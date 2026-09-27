/**
 * Build a two-column source/translation comparison as a self-contained HTML
 * file. Blocks are paired by position: both columns come from the same
 * DocuTranslate parse/segment pipeline, so their block sequences normally
 * match; a kind mismatch is surfaced in the view instead of being hidden.
 *
 * Raw HTML in a block is escaped before Markdown rendering, so a document
 * cannot inject script into the built-in preview. Review findings are not part
 * of this page: the calling agent's `subagent` reports them in the conversation.
 * @module dsh-document-translate/compare
 */

import { marked } from 'marked'

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
  const rows = input.pairs.map(pair => {
    const mismatch = pair.kindMismatch ? ' <span class="badge warn">块类型不一致</span>' : ''
    return `<tr id="row-${pair.row}">`
      + `<td class="num">${pair.row}${mismatch}</td>`
      + `<td class="src">${renderBlock(pair.source)}</td>`
      + `<td class="tgt">${renderBlock(pair.translation)}</td>`
      + `</tr>`
  }).join('\n')

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
  .meta { margin: 2px 0; color: color-mix(in srgb, CanvasText 70%, transparent); }
  .warnings { color: #b45309; margin: 6px 0 0; padding-left: 18px; }
  table { width: 100%; border-collapse: collapse; table-layout: fixed; }
  th { position: sticky; top: 0; background: Canvas; border-bottom: 1px solid color-mix(in srgb, CanvasText 20%, transparent); padding: 8px; text-align: left; }
  td { vertical-align: top; padding: 8px 10px; border-bottom: 1px solid color-mix(in srgb, CanvasText 12%, transparent); overflow-wrap: anywhere; }
  td.num { width: 64px; color: color-mix(in srgb, CanvasText 55%, transparent); font-variant-numeric: tabular-nums; }
  td.src, td.tgt { width: calc((100% - 64px) / 2); }
  .missing { color: color-mix(in srgb, CanvasText 45%, transparent); font-style: italic; }
  .badge { display: inline-block; border-radius: 8px; padding: 0 5px; font-size: 11px; color: white; background: #6b7280; }
  .badge.warn { background: #a855f7; }
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
  ${warnings}
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

/** Escape text for HTML element and attribute contexts. */
function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}