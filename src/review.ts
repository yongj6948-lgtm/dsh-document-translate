/**
 * Automatic translation review. The draft's source and translation are handed
 * to a one-shot child agent (`ctx.subagents`), which thinks over the whole
 * document and returns structured findings through a JSON output schema. The
 * plugin never edits the translation: findings exist so a human can decide.
 * @module dsh-document-translate/review
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: resolves the `ctx.subagents` service declaration.
import type {} from '@deepseek-ai/dsh-subagent'
import type { ObjectJsonSchema, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ResolvedOptions } from './options.js'
import type { ReviewCategory, ReviewIssue, ReviewResult, ReviewSeverity } from './types.js'

/** JSON Schema (enforced subset) the review child's answer is validated against. */
export const REVIEW_OUTPUT_SCHEMA: ObjectJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'summary', 'issues'],
  properties: {
    verdict: { type: 'string', enum: ['pass', 'issues'] },
    summary: { type: 'string' },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'category', 'sourceExcerpt', 'translationExcerpt', 'problem', 'suggestion'],
        properties: {
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
          category: {
            type: 'string',
            enum: ['omission', 'mistranslation', 'terminology', 'format', 'untranslated', 'other'],
          },
          sourceExcerpt: { type: 'string' },
          translationExcerpt: { type: 'string' },
          problem: { type: 'string' },
          suggestion: { type: 'string' },
        },
      },
    },
  },
}

/** Everything the reviewer needs about one translation. */
export interface ReviewMaterial {
  /** Source document label (filename). */
  readonly sourceName: string
  /** Translated document label (filename). */
  readonly translationName: string
  /** Source document as Markdown. */
  readonly sourceText: string
  /** Translated document as Markdown. */
  readonly translationText: string
  /** Target language the translation was asked for. */
  readonly targetLanguage: string
  /** Extra facts the reviewer should know (format, PDF OCR pages, warnings). */
  readonly notes: readonly string[]
}

/** The reviewer's instructions; the whole document is reviewed in one pass. */
const REVIEW_INSTRUCTIONS = `你是一名严格的翻译质检员。下面给你一份文档的原文和译文（均为 Markdown）。
请整体通读，逐项核查，只报告**确凿**的问题：

1. 漏译 / 多译 / 段落遗漏或重复
2. 误译、意思偏离、术语或专有名词错误
3. 未翻译的残留（仍为原文语言）、语种错误
4. 格式与占位符：Markdown 结构、标题层级、列表、表格、代码块、链接、URL、数字、编号、变量占位符、字幕时间轴
5. 术语与全文一致性

要求：
- 每条问题给出 severity（high/medium/low）、category、能定位问题的原文片段与译文片段（尽量短且唯一）、
  问题说明 problem、给人工的修改建议 suggestion。
- 不要报告风格偏好或无法确定的问题；没有问题时 verdict 填 "pass"、issues 为空数组。
- 用中文写 problem 和 suggestion。`

/**
 * Run the automatic review through a one-shot child agent.
 *
 * @param ctx - plugin context carrying the subagent service.
 * @param options - resolved plugin options (review provider/model, subagent provider).
 * @param exec - the tool execution whose agent parents the child and whose signal cancels it.
 * @param material - source and translated text plus review context.
 * @returns the validated review verdict.
 */
export async function runReview(
  ctx: Context,
  options: ResolvedOptions,
  exec: ToolRunContext,
  material: ReviewMaterial,
): Promise<ReviewResult> {
  const subagents = ctx.get('subagents')
  if (subagents === undefined) {
    throw new Error(
      'translation review requires the subagent service (mount @deepseek-ai/dsh-subagent with a provider such as @deepseek-ai/dsh-subagent-spawn-in-process)',
    )
  }
  const parent = exec.agent
  if (parent === undefined) {
    throw new Error('translation review requires an owning agent to parent the review child')
  }
  const prompt = buildPrompt(material)
  const agentOptions = {
    ...options.reviewProvider !== undefined ? { provider: options.reviewProvider } : {},
    ...options.reviewModel !== undefined ? { model: options.reviewModel } : {},
  }
  const run = await subagents.start(options.subagentProvider, {
    label: 'translation-review',
    prompt: [{ type: 'text', text: prompt }],
    parent,
    signal: exec.signal,
    outputSchema: REVIEW_OUTPUT_SCHEMA,
    ...Object.keys(agentOptions).length > 0 ? { agentOptions } : {},
  })
  try {
    const result = await run.result
    if (result.stopReason !== 'completed') {
      throw new Error(`translation review did not complete (${result.stopReason})`)
    }
    if (result.structured === undefined) {
      throw new Error('translation review returned no structured result')
    }
    return parseReview(result.structured)
  } finally {
    await run.dispose()
  }
}

/** Compose the reviewer's single-pass prompt. */
function buildPrompt(material: ReviewMaterial): string {
  const notes = material.notes.length === 0
    ? ''
    : `\n## 已知背景\n${material.notes.map(note => `- ${note}`).join('\n')}\n`
  return `${REVIEW_INSTRUCTIONS}
${notes}
## 目标语言
${material.targetLanguage}

## 原文（${material.sourceName}）
<<<SOURCE
${material.sourceText}
SOURCE

## 译文（${material.translationName}）
<<<TRANSLATION
${material.translationText}
TRANSLATION
`
}

/** Validate the child's structured answer into the plugin's review vocabulary. */
export function parseReview(value: unknown): ReviewResult {
  if (typeof value !== 'object' || value === null) {
    throw new Error('translation review returned a non-object result')
  }
  const record = value as Record<string, unknown>
  const verdict = record['verdict'] === 'pass' ? 'pass' : 'issues'
  const summary = typeof record['summary'] === 'string' ? record['summary'] : ''
  const rawIssues = Array.isArray(record['issues']) ? record['issues'] : []
  const issues = rawIssues.map(toIssue)
  return { verdict: issues.length === 0 ? 'pass' : verdict, summary, issues }
}

/** Normalize one raw finding. */
function toIssue(value: unknown): ReviewIssue {
  const record = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
  return {
    severity: asSeverity(record['severity']),
    category: asCategory(record['category']),
    sourceExcerpt: asText(record['sourceExcerpt']),
    translationExcerpt: asText(record['translationExcerpt']),
    problem: asText(record['problem']),
    suggestion: asText(record['suggestion']),
  }
}

/** Narrow a severity, defaulting to `medium`. */
function asSeverity(value: unknown): ReviewSeverity {
  return value === 'high' || value === 'low' ? value : 'medium'
}

/** Narrow a category, defaulting to `other`. */
function asCategory(value: unknown): ReviewCategory {
  const known: readonly ReviewCategory[] = ['omission', 'mistranslation', 'terminology', 'format', 'untranslated', 'other']
  return known.includes(value as ReviewCategory) ? value as ReviewCategory : 'other'
}

/** Coerce one field to text. */
function asText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}