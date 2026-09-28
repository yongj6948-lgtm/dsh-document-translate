/**
 * DocuTranslate-backed document translation plugin for DeepSeek Harness.
 * Registers the explicit `translate_document` tool on `ctx.tools`; the service
 * endpoint, target language, insertion mode, and optional translation-LLM
 * parameters all come from plugin {@link Config}.
 * @module dsh-document-translate
 */

import type { Context } from '@deepseek-ai/cordis'
import { Config, resolveOptions } from './options.js'
import type { Config as TranslateConfig } from './options.js'
import { createTranslateTool } from './tool.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'document-translate'

/** The tool registry this plugin contributes to. */
export const inject = ['tools']

export { Config }
export { resolveOptions }
export { DocuTranslateClient, DocuTranslateError } from './client.js'
export type { ClientOptions, DocuTranslateErrorCode, DownloadedFile, TaskId } from './client.js'
export { extractMarkdown, extractPdfMarkdown, ScannedPdfError } from './extract.js'
export type { ExtractMethod, ExtractedText, PdfFacts } from './extract.js'
export { alignBlocks, renderCompareHtml, splitBlocks } from './compare.js'
export type { CompareBlock, ComparePair, ComparePageInput } from './compare.js'
export { buildReviewBrief } from './review.js'
export type { ReviewMaterial } from './review.js'
export { startProgress } from './progress.js'
export type { ProgressSurface } from './progress.js'
export type { Config as TranslateConfig, ResolvedOptions } from './options.js'
export type { TranslateDocumentResult } from './tool.js'
export * from './types.js'

/** Register the document translation tool. */
export function apply(ctx: Context, config: TranslateConfig): void {
  // Resolve per call: the Config fields are live references the settings page can edit.
  ctx.tools.register(createTranslateTool(ctx, () => resolveOptions(ctx, config)))
}