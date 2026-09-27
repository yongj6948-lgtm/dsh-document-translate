/**
 * The model-facing `translate_document` tool. It runs the whole workflow:
 * submit the file to DocuTranslate, wait for the draft, write it to the
 * workspace, extract both sides as Markdown, render a two-column comparison,
 * and run the automatic review through a subagent. Findings are reported for a
 * human to act on; the tool never edits the translation.
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
import { extractMarkdown } from './extract.js'
import type { ResolvedOptions } from './options.js'
import { runReview } from './review.js'
import type { FileType, ReviewResult, TaskStatus, TranslatePayload, WorkflowType } from './types.js'
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
  readonly outputPath: string
  /** Path to the two-column comparison page. */
  readonly compareHtmlPath: string
  readonly fileType: FileType
  readonly targetLanguage: string
  /** `pass`, `issues`, or `skipped` when review was disabled. */
  readonly verdict: 'pass' | 'issues' | 'skipped'
  readonly issueCount: number
  readonly elapsedMs: number
}

/** Model-facing description. */
const DESCRIPTION =
  'Translate one document file with the DocuTranslate service, then review the result and show a '
  + 'side-by-side comparison. The file is uploaded, translated by its workflow (markdown, docx, srt, '
  + 'xlsx, epub, html, ass, pptx, json, txt, pdf, or auto-detect), and the translated copy is written '
  + 'next to the source (or to outputPath). The source and translation are extracted to Markdown, a '
  + 'two-column HTML comparison is written, and a review subagent reports any translation problems so '
  + 'the human can decide how to fix them. Use insertMode "append" or "prepend" for a bilingual copy.'

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
          fileType: { type: 'string', required: true },
          targetLanguage: { type: 'string', required: true },
          verdict: { type: 'string', required: true },
          issueCount: { type: 'integer', required: true },
          elapsedMs: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Translated ${value.sourcePath} → ${value.outputPath}\n`
          + `comparison: ${value.compareHtmlPath}\n`
          + `task ${value.taskId}, ${value.fileType}, ${value.targetLanguage}, `
          + `review=${value.verdict} (${value.issueCount} issues), `
          + `${Math.round(value.elapsedMs / 1000)}s`,
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

/** Run one translation workflow: draft, compare, review. */
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
  const workflowType = args.workflowType ?? options.workflowType
  const insertMode = args.insertMode ?? options.insertMode
  const payload: TranslatePayload = {
    workflow_type: workflowType,
    to_lang: targetLanguage,
    insert_mode: insertMode,
    ...insertMode === 'replace' ? {} : { separator: options.separator },
    ...llmParams(options, await resolveApiKey(ctx, options)),
    ...options.convertEngine !== undefined ? { convert_engine: options.convertEngine } : {},
  }
  const taskId = await client.submit(basename(sourcePath), bytes, payload, exec.signal)
  try {
    const status = await waitForTask(client, options, taskId, exec.signal)
    if (status.error_flag) {
      throw new DocuTranslateError(`translation failed: ${status.status_message}`, 'DT_TASK_FAILED')
    }
    const preferred = args.workflowType !== undefined && workflowType !== 'auto'
      ? workflowFor(workflowType)
      : SOURCE_FILE_TYPE[extname(sourcePath).toLowerCase()] ?? inferFromStatus(status)
    const fileType = pickAvailable(status, preferred)
    const file = await client.download(taskId, fileType, exec.signal)
    const outputPath = resolveOutputPath(sourcePath, options, fileType, args.outputPath)
    await writeFile(outputPath, file.bytes)

    const { compareHtmlPath, review } = await buildComparison(
      ctx, options, client, exec, taskId, status, sourcePath, outputPath, targetLanguage,
    )
    return {
      taskId,
      sourcePath,
      outputPath,
      compareHtmlPath,
      fileType,
      targetLanguage,
      verdict: review === undefined ? 'skipped' : review.verdict,
      issueCount: review?.issues.length ?? 0,
      elapsedMs: Date.now() - started,
    }
  } finally {
    // The service keeps task state and temp files in memory; release is best effort.
    await client.release(taskId).catch(() => undefined)
  }
}

/** Extract both sides, write the comparison page, and run the automatic review. */
async function buildComparison(
  ctx: Context,
  options: ResolvedOptions,
  client: DocuTranslateClient,
  exec: ToolRunContext,
  taskId: TaskId,
  status: TaskStatus,
  sourcePath: string,
  outputPath: string,
  targetLanguage: string,
): Promise<{ compareHtmlPath: string; review?: ReviewResult }> {
  const warnings: string[] = []
  // The translated Markdown from the service comes off the same parse pipeline
  // as the source, so block alignment is better than two independent extractions.
  const translated = status.downloads['markdown'] !== undefined
    ? { markdown: new TextDecoder().decode(await client.content(taskId, 'markdown', exec.signal)) }
    : { markdown: (await extractMarkdown(outputPath)).markdown }

  const source = await extractMarkdown(sourcePath)
  if (source.pdf !== undefined && source.pdf.pagesNeedingOcr.length > 0) {
    warnings.push(`源 PDF 有 ${source.pdf.pagesNeedingOcr.length} 页需要 OCR，文本复查可能不完整`)
  }
  const pairs = alignBlocks(splitBlocks(source.markdown), splitBlocks(translated.markdown))
  const mismatches = pairs.filter(pair => pair.kindMismatch).length
  if (mismatches > 0) {
    warnings.push(`${mismatches} 行的原文/译文块类型不一致，可能是分段差异`)
  }

  const review = options.review
    ? await runReview(ctx, options, exec, {
      sourceName: basename(sourcePath),
      translationName: basename(outputPath),
      sourceText: source.markdown,
      translationText: translated.markdown,
      targetLanguage,
      notes: warnings,
    })
    : undefined

  const compareHtmlPath = comparePathFor(outputPath)
  await writeFile(compareHtmlPath, renderCompareHtml({
    title: basename(sourcePath),
    sourceName: basename(sourcePath),
    translationName: basename(outputPath),
    pairs,
    warnings,
    ...review !== undefined ? { review } : {},
    ...source.pdf !== undefined ? { pdf: source.pdf } : {},
  }))
  return { compareHtmlPath, ...review !== undefined ? { review } : {} }
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
): Promise<TaskStatus> {
  const deadline = Date.now() + options.taskTimeoutMs
  for (;;) {
    const status = await client.status(taskId, signal)
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