/**
 * The model-facing `translate_document` tool. It runs the deterministic part of
 * the workflow: submit the file to DocuTranslate, write the translated copy,
 * extract both sides as Markdown, and render a two-column comparison. It then
 * returns a ready-made review brief; the calling agent delegates that brief to
 * its own `subagent` tool, which owns the review model and reports findings
 * back into the conversation. The plugin never reviews and never edits the
 * translation.
 *
 * The service keeps task state in memory, so every path releases the task.
 * @module dsh-document-translate/tool
 */

import { readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { DocuTranslateClient, DocuTranslateError } from './client.js'
import type { TaskId } from './client.js'
import { alignBlocks, renderCompareHtml, splitBlocks } from './compare.js'
import { extractMarkdown, extractPdfMarkdown } from './extract.js'
import type { PdfFacts } from './extract.js'
import type { ResolvedOptions } from './options.js'
import { startProgress } from './progress.js'
import { buildReviewBrief } from './review.js'
import type { FileType, TaskStatus, TranslatePayload, WorkflowType } from './types.js'
import { FILE_TYPES, WORKFLOW_TYPES } from './types.js'

/** Preferred result file kind per source extension. */
const SOURCE_FILE_TYPE: Record<string, FileType> = {
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.txt': 'txt',
  '.html': 'html',
  '.htm': 'html',
  '.json': 'json',
  '.xlsx': 'xlsx',
  '.docx': 'docx',
  '.srt': 'srt',
  '.epub': 'epub',
  '.ass': 'ass',
  '.ssa': 'ass',
  '.pptx': 'pptx',
}

/** Canonical value of a successful `translate_document` call. */
export interface TranslateDocumentResult {
  readonly taskId: string
  readonly sourcePath: string
  /** The translated copy, in the service's own format for the workflow. */
  readonly outputPath: string
  /** Two-column source/translation HTML page. */
  readonly compareHtmlPath: string
  /** Source document as Markdown, written for the reviewer to read. */
  readonly reviewSourcePath: string
  /** Translated document as Markdown, written for the reviewer to read. */
  readonly reviewTranslationPath: string
  readonly fileType: FileType
  readonly targetLanguage: string
  /** Prompt for the calling agent's `subagent` tool. */
  readonly reviewBrief: string
  readonly elapsedMs: number
}

/** Model-facing description. */
const DESCRIPTION =
  'Translate one document with the DocuTranslate service and prepare its review. The file is '
  + 'uploaded, translated by its workflow (markdown, docx, srt, xlsx, epub, html, ass, pptx, json, '
  + 'txt, pdf, or auto-detect), and the translated copy is written next to the source (or to '
  + 'outputPath). The source and translation are extracted to Markdown, a two-column HTML '
  + 'comparison is written, and a `reviewBrief` is returned. '
  + 'REQUIRED NEXT STEP: immediately delegate the review by calling the `subagent` tool with the '
  + `returned reviewBrief as its prompt, then report the review findings to the user. Use insertMode `
  + '"append" or "prepend" for a bilingual copy.'

/** One validated call's arguments, as inferred by `defineTool`. */
interface TranslateArgs {
  readonly source: string
  readonly targetLanguage?: string
  readonly workflowType?: WorkflowType
  readonly insertMode?: 'replace' | 'append' | 'prepend'
  readonly outputPath?: string
}

/** Build the tool definition bound to one plugin instance's live options. */
export function createTranslateTool(ctx: Context, getOptions: () => ResolvedOptions) {
  return defineTool({
    name: 'translate_document',
    description: DESCRIPTION,
    parameters: {
      source: { type: 'string', required: true, description: 'Path to the document to translate.' },
      targetLanguage: { type: 'string', description: 'Target language; defaults to the configured target language.' },
      workflowType: {
        type: 'string',
        enum: WORKFLOW_TYPES,
        description: 'Translation workflow; omit to auto-detect from the file type.',
      },
      insertMode: {
        type: 'string',
        enum: ['replace', 'append', 'prepend'],
        description: 'Replace the source text, or append/prepend the translation for a bilingual copy.',
      },
      outputPath: { type: 'string', description: 'Explicit output file path; defaults to beside the source.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          taskId: { type: 'string', required: true },
          sourcePath: { type: 'string', required: true },
          outputPath: { type: 'string', required: true },
          compareHtmlPath: { type: 'string', required: true },
          reviewSourcePath: { type: 'string', required: true },
          reviewTranslationPath: { type: 'string', required: true },
          fileType: { type: 'string', required: true },
          targetLanguage: { type: 'string', required: true },
          reviewBrief: { type: 'string', required: true },
          elapsedMs: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Translated ${value.sourcePath} → ${value.outputPath}\n`
          + `comparison: ${value.compareHtmlPath}\n`
          + `task ${value.taskId}, ${value.fileType}, ${value.targetLanguage}, `
          + `${Math.round(value.elapsedMs / 1000)}s\n\n`
          + `下一步必须调用 subagent 工具复查，prompt 用：\n${value.reviewBrief}`,
      }],
    },
    async execute(args: TranslateArgs, exec: ToolRunContext): Promise<TranslateDocumentResult> {
      // Read the live settings at the start of the operation so a settings edit
      // applies to the next call without a restart.
      const options = getOptions()
      const client = new DocuTranslateClient({
        baseURL: options.baseURL,
        timeoutMs: options.requestTimeoutMs,
      })
      return await runTranslate(ctx, options, client, args, exec)
    },
  })
}

/** Run one translation workflow: draft, extract, compare, brief. */
async function runTranslate(
  ctx: Context,
  options: ResolvedOptions,
  client: DocuTranslateClient,
  args: TranslateArgs,
  exec: ToolRunContext,
): Promise<TranslateDocumentResult> {
  const sourcePath = isAbsolute(args.source) ? args.source : join(process.cwd(), args.source)
  const started = Date.now()
  let bytes: Uint8Array
  try {
    bytes = new Uint8Array(await readFile(sourcePath))
  } catch (error: unknown) {
    throw new Error(`cannot read source file ${sourcePath}: ${String(error)}`)
  }
  const targetLanguage = args.targetLanguage ?? options.targetLang
  let workflowType = args.workflowType ?? options.workflowType
  let convertEngine = options.convertEngine
  const insertMode = args.insertMode ?? options.insertMode
  // A text-based PDF is read locally and submitted as Markdown. DocuTranslate's
  // own PDF path would rebuild the document through mineru/docling, changing
  // its layout, which this deployment does not want.
  let submitName = basename(sourcePath)
  let submitBytes = bytes
  let knownSource: { markdown: string; pdf?: PdfFacts } | undefined
  if (extname(sourcePath).toLowerCase() === '.pdf') {
    const extracted = await extractPdfMarkdown(sourcePath)
    knownSource = { markdown: extracted.markdown, pdf: extracted.pdf }
    submitName = `${basename(sourcePath, extname(sourcePath))}.md`
    submitBytes = new TextEncoder().encode(extracted.markdown)
    workflowType = 'markdown_based'
    convertEngine = 'identity'
  }
  const payload: TranslatePayload = {
    workflow_type: workflowType,
    to_lang: targetLanguage,
    insert_mode: insertMode,
    ...insertMode === 'replace' ? {} : { separator: options.separator },
    ...llmParams(options, await resolveApiKey(ctx, options)),
    ...convertEngine !== undefined ? { convert_engine: convertEngine } : {},
  }
  // A live progress row, when the harness has a job registry. The row is
  // unowned on purpose so it produces no completion notice; the tool still
  // waits for the workflow and returns its normal result.
  const progress = options.showProgress
    ? startProgress(ctx, `${basename(sourcePath)} → ${targetLanguage}`)
    : undefined
  progress?.log(`提交给 DocuTranslate：${submitName}`)
  try {
    const taskId = await client.submit(submitName, submitBytes, payload, exec.signal)
    progress?.update('已提交，等待服务处理…')
    try {
      const status = await waitForTask(
        client, options, taskId, exec.signal, line => progress?.update(line),
      )
      if (status.error_flag) {
        throw new DocuTranslateError(`translation failed: ${status.status_message}`, 'DT_TASK_FAILED')
      }
      const preferred = knownSource !== undefined
        ? 'markdown'
        : (args.workflowType !== undefined && workflowType !== 'auto'
            ? workflowFor(workflowType)
            : SOURCE_FILE_TYPE[extname(sourcePath).toLowerCase()] ?? inferFromStatus(status))
      const fileType = pickAvailable(status, preferred)
      progress?.update('下载译文…')
      const file = await client.download(taskId, fileType, exec.signal)
      const outputPath = resolveOutputPath(sourcePath, options, fileType, args.outputPath)
      await writeFile(outputPath, file.bytes)

      progress?.update('生成对照与复查材料…')
      const prepared = await prepareReview(
        client, exec, taskId, status, sourcePath, outputPath, targetLanguage, knownSource,
      )
      progress?.log(`完成：${basename(outputPath)}`)
      progress?.finish()
      return {
        taskId,
        sourcePath,
        outputPath,
        compareHtmlPath: prepared.compareHtmlPath,
        reviewSourcePath: prepared.reviewSourcePath,
        reviewTranslationPath: prepared.reviewTranslationPath,
        fileType,
        targetLanguage,
        reviewBrief: prepared.reviewBrief,
        elapsedMs: Date.now() - started,
      }
    } finally {
      // The service keeps task state and temp files in memory; release is best effort.
      await client.release(taskId).catch(() => undefined)
    }
  } catch (error: unknown) {
    progress?.fail(error instanceof Error ? error.message : String(error))
    throw error
  } finally {
    // Defensive: a cancellation path that throws before finish/fail still
    // settles the display row instead of leaving it running.
    progress?.finish()
  }
}

/** Extract both sides, write the comparison and review Markdown, and compose the brief. */
async function prepareReview(
  client: DocuTranslateClient,
  exec: ToolRunContext,
  taskId: TaskId,
  status: TaskStatus,
  sourcePath: string,
  outputPath: string,
  targetLanguage: string,
  knownSource: { markdown: string; pdf?: PdfFacts } | undefined,
): Promise<{
  compareHtmlPath: string
  reviewSourcePath: string
  reviewTranslationPath: string
  reviewBrief: string
}> {
  const warnings: string[] = []
  // The translated Markdown from the service comes off the same parse pipeline
  // as the source, so block alignment is better than two independent extractions.
  const translated = status.downloads['markdown'] !== undefined
    ? { markdown: new TextDecoder().decode(await client.content(taskId, 'markdown', exec.signal)) }
    : { markdown: (await extractMarkdown(outputPath)).markdown }

  const source = knownSource !== undefined
    ? { markdown: knownSource.markdown, ...knownSource.pdf !== undefined ? { pdf: knownSource.pdf } : {} }
    : await extractMarkdown(sourcePath)
  if (source.pdf !== undefined && source.pdf.pagesNeedingOcr.length > 0) {
    warnings.push(
      `pdf-inspector 标记第 ${source.pdf.pagesNeedingOcr.join(', ')} 页建议 OCR，若译文缺失这些页的内容请人工确认`,
    )
  }
  const pairs = alignBlocks(splitBlocks(source.markdown), splitBlocks(translated.markdown))
  const mismatches = pairs.filter(pair => pair.kindMismatch).length
  if (mismatches > 0) {
    warnings.push(`${mismatches} 行的原文/译文块类型不一致，可能是分段差异`)
  }

  const stem = join(dirname(outputPath), basename(sourcePath, extname(sourcePath)))
  const reviewSourcePath = `${stem}.source.md`
  const reviewTranslationPath = extname(outputPath).toLowerCase() === '.md'
    ? outputPath
    : `${stem}.translated.md`
  await writeFile(reviewSourcePath, source.markdown)
  if (reviewTranslationPath !== outputPath) await writeFile(reviewTranslationPath, translated.markdown)

  const compareHtmlPath = comparePathFor(outputPath)
  await writeFile(compareHtmlPath, renderCompareHtml({
    title: basename(sourcePath),
    sourceName: basename(sourcePath),
    translationName: basename(outputPath),
    pairs,
    warnings,
    ...source.pdf !== undefined ? { pdf: source.pdf } : {},
  }))

  return {
    compareHtmlPath,
    reviewSourcePath,
    reviewTranslationPath,
    reviewBrief: buildReviewBrief({
      sourcePath: reviewSourcePath,
      translationPath: reviewTranslationPath,
      sourceName: basename(sourcePath),
      targetLanguage,
      notes: warnings,
    }),
  }
}

/** Collect the A-side LLM parameters, omitting every unset field. */
function llmParams(
  options: ResolvedOptions,
  apiKey: string | undefined,
): Partial<TranslatePayload> {
  return {
    ...options.llmBaseURL !== undefined ? { base_url: options.llmBaseURL } : {},
    ...options.llmModelId !== undefined ? { model_id: options.llmModelId } : {},
    ...options.llmProvider !== undefined ? { provider: options.llmProvider } : {},
    ...apiKey !== undefined ? { api_key: apiKey } : {},
  }
}

/** Resolve the translation LLM key through the credential seam, then the environment. */
async function resolveApiKey(ctx: Context, options: ResolvedOptions): Promise<string | undefined> {
  const ref = credentialRef(options.llmApiKeyEnv)
  const credentials = ctx.get('credentials')
  if (credentials !== undefined) {
    const resolved = await credentials.resolve(ref)
    if (resolved !== undefined && resolved.value.length > 0) return resolved.value
  }
  const ambient = launchEnvironmentOf(ctx).get(options.llmApiKeyEnv)
  return ambient !== undefined && ambient.value.length > 0 ? ambient.value : undefined
}

/** Poll until the task settles, the deadline passes, or the caller aborts. */
async function waitForTask(
  client: DocuTranslateClient,
  options: ResolvedOptions,
  taskId: TaskId,
  signal: AbortSignal,
  onProgress?: (line: string) => void,
): Promise<TaskStatus> {
  const deadline = Date.now() + options.taskTimeoutMs
  for (;;) {
    const status = await client.status(taskId, signal)
    onProgress?.(`${status.progress_percent}% ${status.status_message}`.trim())
    if (status.download_ready || status.error_flag) return status
    if (!status.is_processing) return status
    if (Date.now() >= deadline) {
      await client.cancel(taskId).catch(() => undefined)
      throw new DocuTranslateError(
        `translation did not finish within ${options.taskTimeoutMs}ms (task ${taskId})`,
        'DT_TIMEOUT',
      )
    }
    await sleep(options.pollIntervalMs, signal)
  }
}

/** Resolve the output path, preferring an explicit one. */
function resolveOutputPath(
  sourcePath: string,
  options: ResolvedOptions,
  fileType: FileType,
  explicit: string | undefined,
): string {
  if (explicit !== undefined && explicit.length > 0) {
    return isAbsolute(explicit) ? explicit : join(process.cwd(), explicit)
  }
  const directory = options.outputDir.length > 0
    ? (isAbsolute(options.outputDir) ? options.outputDir : join(process.cwd(), options.outputDir))
    : dirname(sourcePath)
  const stem = basename(sourcePath, extname(sourcePath))
  return join(directory, `${stem}.translated.${extensionFor(fileType)}`)
}

/** Comparison page path beside the translated file. */
function comparePathFor(outputPath: string): string {
  return `${outputPath.slice(0, outputPath.length - extname(outputPath).length)}.compare.html`
}

/** Result kind the service produces for a workflow, when it is unambiguous. */
function workflowFor(workflow: WorkflowType): FileType | undefined {
  switch (workflow) {
    case 'markdown_based': return 'markdown'
    case 'txt': return 'txt'
    case 'json': return 'json'
    case 'xlsx': return 'xlsx'
    case 'docx': return 'docx'
    case 'srt': return 'srt'
    case 'epub': return 'epub'
    case 'html': return 'html'
    case 'ass': return 'ass'
    case 'pptx': return 'pptx'
    case 'auto': return undefined
  }
}

/** First downloadable kind when no preference is known. */
function inferFromStatus(status: TaskStatus): FileType | undefined {
  for (const candidate of FILE_TYPES) {
    if (status.downloads[candidate] !== undefined) return candidate
  }
  return undefined
}

/** Prefer the requested kind, else the first download the service offers. */
function pickAvailable(status: TaskStatus, preferred: FileType | undefined): FileType {
  if (preferred !== undefined && status.downloads[preferred] !== undefined) return preferred
  const fallback = inferFromStatus(status)
  if (fallback !== undefined) return fallback
  throw new DocuTranslateError(
    `task produced no downloadable result (offered: ${Object.keys(status.downloads).join(', ') || 'none'})`,
    'DT_BAD_BODY',
  )
}

/** Canonical file extension for one result kind. */
function extensionFor(fileType: FileType): string {
  switch (fileType) {
    case 'markdown': return 'md'
    case 'markdown_zip': return 'zip'
    case 'html': return 'html'
    case 'txt': return 'txt'
    case 'json': return 'json'
    case 'xlsx': return 'xlsx'
    case 'csv': return 'csv'
    case 'docx': return 'docx'
    case 'srt': return 'srt'
    case 'epub': return 'epub'
    case 'ass': return 'ass'
    case 'pptx': return 'pptx'
  }
}

/** Sleep that rejects on caller cancellation. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}