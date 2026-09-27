/**
 * Extract reviewable Markdown from a source or translated document.
 *
 * Text-ish formats are read directly. Container formats go through
 * `@firecrawl/anydoc`. PDFs are read locally by `@firecrawl/pdf-inspector`
 * instead of DocuTranslate's conversion engines (mineru/docling): those rebuild
 * the document, changing its layout, and a text-based PDF needs none of that.
 * A PDF whose pages need OCR is refused, because the plugin does not handle
 * scanned documents yet.
 *
 * The native extractors are imported lazily so the plugin still loads on a
 * platform whose prebuilt binary is absent; a call that actually needs one then
 * fails with a named error.
 * @module dsh-document-translate/extract
 */

import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'

/** How the Markdown was obtained. */
export type ExtractMethod = 'direct' | 'anydoc' | 'pdf-inspector'

/** PDF routing facts reported by pdf-inspector. */
export interface PdfFacts {
  /** `TextBased`, `Scanned`, `ImageBased`, or `Mixed`. */
  readonly pdfType: string
  /** Pages that need OCR, 1-indexed as pdf-inspector reports them. */
  readonly pagesNeedingOcr: readonly number[]
}

/** One document's reviewable text. */
export interface ExtractedText {
  /** GitHub-Flavored Markdown of the document. */
  readonly markdown: string
  /** Whether the bytes were read directly or converted by a local extractor. */
  readonly method: ExtractMethod
  /** PDF classification, when the input was a PDF. */
  readonly pdf?: PdfFacts
}

/** A PDF the plugin refuses because it is scanned or image-only. */
export class ScannedPdfError extends Error {
  /** The classifier's document type. */
  readonly pdfType: string

  /**
   * @param pdfType - the classifier's document type (`Scanned` or `ImageBased`).
   */
  constructor(pdfType: string) {
    super(`PDF 类型为 ${pdfType}，没有可提取文本；扫描件暂不支持，请先做 OCR 或转换为 docx/md`)
    this.name = 'ScannedPdfError'
    this.pdfType = pdfType
  }
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
  return { markdown: await convertWithAnydoc(path), method: 'anydoc' }
}

/**
 * Read a text-based PDF locally and return its Markdown.
 *
 * `Scanned` and `ImageBased` documents are refused. `TextBased` and `Mixed`
 * documents are extracted; pdf-inspector's per-page OCR hints are returned as
 * facts so the caller can warn rather than silently assume completeness.
 *
 * @param path - absolute path to the PDF.
 * @returns the extracted Markdown and classification facts.
 * @throws {@link ScannedPdfError} for a document with no extractable text.
 */
export async function extractPdfMarkdown(path: string): Promise<ExtractedText & { pdf: PdfFacts }> {
  const inspector = await loadOptional('@firecrawl/pdf-inspector', 'PDF extraction')
  if (inspector === undefined) {
    throw new Error(
      `cannot read ${path}: @firecrawl/pdf-inspector is not installed for ${process.platform}-${process.arch}`,
    )
  }
  const result = await inspector.processPdfAsync(await readFile(path))
  const pdfType = String(result.pdfType)
  if (pdfType === 'Scanned' || pdfType === 'ImageBased') {
    throw new ScannedPdfError(pdfType)
  }
  const markdown = result.markdown ?? ''
  if (markdown.trim().length === 0) {
    throw new Error(`PDF ${path} 没有提取到文本（类型 ${pdfType}）`)
  }
  return {
    markdown,
    method: 'pdf-inspector',
    pdf: { pdfType, pagesNeedingOcr: [...result.pagesNeedingOcr] },
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

/** One pdf-inspector process result, narrowed to what the plugin reads. */
interface PdfProcessResult {
  readonly pdfType: unknown
  readonly markdown?: string
  /** 1-indexed pages needing OCR. */
  readonly pagesNeedingOcr: number[]
}

/** Minimal structural view of the optional PDF extractor. */
interface PdfInspectorModule {
  processPdfAsync(buffer: Buffer): Promise<PdfProcessResult>
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