/**
 * Build a two-column source/translation comparison as a self-contained HTML
 * file. Blocks are paired by position: both columns come from the same
 * DocuTranslate parse/segment pipeline, so their block sequences normally
 * match; a kind mismatch is surfaced in the view instead of being hidden.
 *
 * Raw HTML in a block is escaped before Markdown rendering, so a document
 * cannot inject script into the built-in preview.
 * @module dsh-document-translate/compare
 */

import { marked } from 'marked'
import type { ReviewIssue, ReviewResult } from './types.js'

/** One structural block of Markdown. */
export interface CompareBlock {
  /** Block category, used to flag suspected misalignment. */
  readonly kind: 'heading' | 'list' | 'table' | 'code' | 'paragraph'
  /** The block's Markdown source. */
  readonly text: string
}

/** One row of the comparison. */
export interface ComparePair {
  /** Source-side block; absent when the source column ran out. */
  readonly source?: CompareBlock
  /** Translation-side block; absent when the translation column ran out. */
  readonly translation?: CompareBlock
  /** 1-based row number. */
  readonly row: number
  /** True when both sides exist but their block kinds differ. */
  readonly kindMismatch: boolean
}

/** Everything the comparison page renders. */
export interface ComparePageInput {
  /** Document title (usually the source filename). */
  readonly title: string
  /** Source label. */
  readonly sourceName: string
  /** Translation label. */
  readonly translationName: string
  /** Paired blocks. */
  readonly pairs: readonly ComparePair[]
  /** Automatic review verdict, when review ran. */
  readonly review?: ReviewResult
  /** PDF routing facts, when the source was a PDF. */
  readonly pdf?: { readonly pdfType: string; readonly pagesNeedingOcr: readonly number[] }
  /** Non-fatal problems encountered while preparing the comparison. */
  readonly warnings: readonly string[]
}

/** Split Markdown into reviewable blocks. */
export function splitBlocks(markdown: string): CompareBlock[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  const blocks: CompareBlock[] = []
  let buffer: string[] = []
  let kind: CompareBlock['kind'] = 'paragraph'
  let fence: string | undefined

  const flush = (): void => {
    if (buffer.length === 0) return
    const text = buffer.join('\n').trim()
    if (text.length > 0) blocks.push({ kind, text })
    buffer = []
    kind = 'paragraph'
  }

  for (const line of lines) {
    const trimmed = line.trim()
    if (fence !== undefined) {
      buffer.push(line)
      if (trimmed.startsWith(fence)) {
        fence = undefined
        flush()
      }
      continue
    }
    if (trimmed === '') {
      flush()
      continue
    }
    const fenceMatch = /^(`{3,}|~{3,})/.exec(trimmed)
    if (fenceMatch !== null) {
      flush()
      buffer = [line]
      kind = 'code'
      fence = fenceMatch[1]
      continue
    }
    if (/^#{1,6}\s/.test(trimmed)) {
      flush()
      blocks.push({ kind: 'heading', text: trimmed })
      continue
    }
    if (/^(?:[-*+]|\d+[.)])\s/.test(trimmed)) {
      flush()
      blocks.push({ kind: 'list', text: trimmed })
      continue
    }
    if (trimmed.startsWith('|')) {
      if (kind !== 'table') {
        flush()
        kind = 'table'
      }
      buffer.push(line)
      continue
    }
    buffer.push(line)
  }
  flush()
  return blocks
}

/** Pair source and translation blocks by position, flagging kind mismatches. */
export function alignBlocks(
  source: readonly CompareBlock[],
  translation: readonly CompareBlock[],
): ComparePair[] {
  const rows = Math.max(source.length, translation.length)
  const pairs: ComparePair[] = []
  for (let index = 0; index < rows; index++) {
    const left = source[index]
    const right = translation[index]
    pairs.push({
      row: index + 1,
      ...left !== undefined ? { source: left } : {},
      ...right !== undefined ? { translation: right } : {},
      kindMismatch: left !== undefined && right !== undefined && left.kind !== right.kind,
    })
  }
  return pairs
}

/** Render one block's Markdown to HTML with raw HTML neutralized. */
export function renderBlock(block: CompareBlock | undefined): string {
  if (block === undefined) return '<div class="missing">（无对应内容）</div>'
  const escaped = block.text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  return marked.parse(escaped, { async: false, gfm: true, breaks: false })
}

/** Render the full self-contained comparison page. */
export function renderCompareHtml(input: ComparePageInput): string {
  const review = input.review
  const findings = review?.issues ?? []
  const annotated = findings.map((issue, index) =>
    `<li class="sev-${issue.severity}"><b>#${index + 1} [${issue.severity}/${issue.category}]</b> `
    + `${escapeHtml(issue.problem)}<br><span class="src">原文：</span>${escapeHtml(issue.sourceExcerpt)}`
    + `<br><span class="tgt">译文：</span>${escapeHtml(issue.translationExcerpt)}`
    + `<br><span class="fix">建议：</span>${escapeHtml(issue.suggestion)}</li>`).join('\n')

  const rows = input.pairs.map(pair => {
    const marks = findings
      .map((issue, index) => ({ issue, index }))
      .filter(({ issue }) => blockMentions(pair, issue))
      .map(({ index, issue }) => `<span class="badge sev-${issue.severity}" title="${escapeHtml(issue.problem)}">#${index + 1}</span>`)
      .join('')
    const mismatch = pair.kindMismatch ? ' <span class="badge warn">块类型不一致</span>' : ''
    return `<tr id="row-${pair.row}">`
      + `<td class="num">${pair.row}${marks ? ` ${marks}` : ''}${mismatch}</td>`
      + `<td class="src">${renderBlock(pair.source)}</td>`
      + `<td class="tgt">${renderBlock(pair.translation)}</td>`
      + `</tr>`
  }).join('\n')

  const verdictLine = review === undefined
    ? '未复查'
    : review.verdict === 'pass'
      ? '复查通过（未发现问题）'
      : `复查发现 ${findings.length} 处问题，请人工决定如何修改`

  const warnings = input.warnings.length === 0
    ? ''
    : `<ul class="warnings">${input.warnings.map(text => `<li>${escapeHtml(text)}</li>`).join('')}</ul>`

  const pdfLine = input.pdf === undefined
    ? ''
    : `<p class="meta">PDF 类型：<code>${escapeHtml(input.pdf.pdfType)}</code>`
      + (input.pdf.pagesNeedingOcr.length > 0
        ? `，需要 OCR 的页（0 起）：${input.pdf.pagesNeedingOcr.map(page => page + 1).join(', ')}`
        : '')
      + `</p>`

  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>翻译对照 · ${escapeHtml(input.title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; font: 14px/1.6 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; }
  header { position: sticky; top: 0; z-index: 2; padding: 12px 16px; background: Canvas; border-bottom: 1px solid color-mix(in srgb, CanvasText 20%, transparent); }
  h1 { margin: 0 0 6px; font-size: 16px; }
  .meta, .verdict { margin: 2px 0; color: color-mix(in srgb, CanvasText 70%, transparent); }
  .warnings { color: #b45309; margin: 6px 0 0; padding-left: 18px; }
  .findings { margin: 10px 0 0; padding-left: 18px; max-height: 30vh; overflow: auto; }
  .findings li { margin: 4px 0; }
  .sev-high { border-left: 3px solid #dc2626; padding-left: 8px; }
  .sev-medium { border-left: 3px solid #d97706; padding-left: 8px; }
  .sev-low { border-left: 3px solid #2563eb; padding-left: 8px; }
  table { width: 100%; border-collapse: collapse; table-layout: fixed; }
  th { position: sticky; top: 0; background: Canvas; border-bottom: 1px solid color-mix(in srgb, CanvasText 20%, transparent); padding: 8px; text-align: left; }
  td { vertical-align: top; padding: 8px 10px; border-bottom: 1px solid color-mix(in srgb, CanvasText 12%, transparent); overflow-wrap: anywhere; }
  td.num { width: 64px; color: color-mix(in srgb, CanvasText 55%, transparent); font-variant-numeric: tabular-nums; }
  td.src, td.tgt { width: calc((100% - 64px) / 2); }
  .missing { color: color-mix(in srgb, CanvasText 45%, transparent); font-style: italic; }
  .badge { display: inline-block; border-radius: 8px; padding: 0 5px; font-size: 11px; color: white; background: #6b7280; }
  .badge.sev-high { background: #dc2626; } .badge.sev-medium { background: #d97706; } .badge.sev-low { background: #2563eb; }
  .badge.warn { background: #a855f7; }
  .fix { color: #047857; }
  pre { white-space: pre-wrap; background: color-mix(in srgb, CanvasText 6%, transparent); padding: 8px; border-radius: 6px; }
  code { background: color-mix(in srgb, CanvasText 8%, transparent); padding: 1px 4px; border-radius: 4px; }
  h1,h2,h3,h4 { margin: 0.4em 0; }
</style>
</head>
<body>
<header>
  <h1>${escapeHtml(input.title)}</h1>
  <p class="meta">原文：<code>${escapeHtml(input.sourceName)}</code> · 译文：<code>${escapeHtml(input.translationName)}</code></p>
  ${pdfLine}
  <p class="verdict">${escapeHtml(verdictLine)}</p>
  ${warnings}
  ${review !== undefined && review.summary.length > 0 ? `<p class="meta">${escapeHtml(review.summary)}</p>` : ''}
  ${findings.length > 0 ? `<ul class="findings">\n${annotated}\n</ul>` : ''}
</header>
<table>
  <thead><tr><th>#</th><th>原文</th><th>译文</th></tr></thead>
  <tbody>
${rows}
  </tbody>
</table>
</body>
</html>
`
}

/** True when one pair's text contains enough of a finding's excerpt to mark it. */
function blockMentions(pair: ComparePair, issue: ReviewIssue): boolean {
  const haystacks = [pair.source?.text, pair.translation?.text].filter((text): text is string => text !== undefined)
  return haystacks.some(text =>
    mentions(text, issue.sourceExcerpt) || mentions(text, issue.translationExcerpt))
}

/** Match an excerpt by normalized containment, ignoring whitespace runs. */
function mentions(haystack: string, excerpt: string): boolean {
  const needle = normalize(excerpt)
  if (needle.length < 6) return false
  return normalize(haystack).includes(needle)
}

/** Collapse whitespace and lowercase for containment matching. */
function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase()
}

/** Escape text for HTML element and attribute contexts. */
function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}