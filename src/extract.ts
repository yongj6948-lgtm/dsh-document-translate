/**
 * Extract reviewable Markdown from a source or translated document. Text-ish
 * formats are read directly; container formats go through `@firecrawl/anydoc`;
 * PDFs are classified first with `@firecrawl/pdf-inspector` so a scanned PDF is
 * reported as unverifiable text rather than silently reviewed.
 *
 * The native extractors are imported lazily so the plugin still loads (and the
 * translation-only path still works) on a platform whose prebuilt binary is
 * absent; a call that actually needs one then fails with a named error.
 * @module dsh-document-translate/extract
 */

import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'

/** How the Markdown was obtained. */
export type ExtractMethod = 'direct' | 'anydoc'

/** PDF routing facts reported by pdf-inspector. */
export interface PdfFacts {
  /** `TextBased`, `Scanned`, `ImageBased`, or `Mixed`. */
  readonly pdfType: string
  /** 0-indexed pages that need OCR before their text is reviewable. */
  readonly pagesNeedingOcr: number[]
}

/** One document's reviewable text. */
export interface ExtractedText {
  /** GitHub-Flavored Markdown of the document. */
  readonly markdown: string
  /** Whether the bytes were read directly or converted by anydoc. */
  readonly method: ExtractMethod
  /** PDF classification, when the input was a PDF. */
  readonly pdf?: PdfFacts
}

/** Extensions read as UTF-8 text without a converter. */
const PLAIN_TEXT_EXTENSIONS = new Set([
  '.md', '.markdown', '.txt', '.srt', '.ass', '.ssa',
  '.html', '.htm', '.json', '.csv', '.xml', '.yml', '.yaml',
])

/**
 * Obtain reviewable Markdown for one document.
 *
 * @param path - absolute path to the document.
 * @returns the Markdown plus how it was obtained.
 */
export async function extractMarkdown(path: string): Promise<ExtractedText> {
  const extension = extname(path).toLowerCase()
  if (PLAIN_TEXT_EXTENSIONS.has(extension)) {
    return { markdown: await readFile(path, 'utf8'), method: 'direct' }
  }
  const pdf = extension === '.pdf' ? await classifyPdf(path) : undefined
  return {
    markdown: await convertWithAnydoc(path),
    method: 'anydoc',
    ...pdf !== undefined ? { pdf } : {},
  }
}

/** Classify a PDF's pages; a missing binary is a named failure, not a silent skip. */
async function classifyPdf(path: string): Promise<PdfFacts | undefined> {
  const inspector = await loadOptional('@firecrawl/pdf-inspector', 'PDF classification')
  if (inspector === undefined) return undefined
  const buffer = await readFile(path)
  const result = inspector.classifyPdf(buffer)
  return {
    pdfType: String(result.pdfType),
    pagesNeedingOcr: [...result.pagesNeedingOcr],
  }
}

/** Convert a container format to Markdown with anydoc. */
async function convertWithAnydoc(path: string): Promise<string> {
  const anydoc = await loadOptional('@firecrawl/anydoc', 'document conversion')
  if (anydoc === undefined) {
    throw new Error(
      `cannot convert ${path}: @firecrawl/anydoc is not installed for ${process.platform}-${process.arch}`,
    )
  }
  return await anydoc.toMarkdown(path)
}

/** Minimal structural view of the optional native extractor modules. */
interface AnydocModule {
  toMarkdown(path: string): Promise<string>
}

/** Minimal structural view of the optional PDF classifier. */
interface PdfInspectorModule {
  classifyPdf(buffer: Buffer): { pdfType: unknown; pagesNeedingOcr: number[] }
}

/** Load one optional native module, or `undefined` when it is unavailable. */
async function loadOptional(
  specifier: '@firecrawl/anydoc',
  capability: string,
): Promise<AnydocModule | undefined>
async function loadOptional(
  specifier: '@firecrawl/pdf-inspector',
  capability: string,
): Promise<PdfInspectorModule | undefined>
async function loadOptional(
  specifier: string,
  _capability: string,
): Promise<AnydocModule | PdfInspectorModule | undefined> {
  try {
    return await import(specifier) as AnydocModule | PdfInspectorModule
  } catch {
    // A platform without the prebuilt binary degrades to "cannot convert",
    // which the caller reports against the exact file.
    return undefined
  }
}