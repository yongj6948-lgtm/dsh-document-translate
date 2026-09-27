/**
 * DocuTranslate wire vocabulary shared by the HTTP client and the plugin's
 * option resolution. Types describe the service's JSON, not the harness.
 * @module dsh-document-translate/types
 */

/** Workflow kinds accepted by DocuTranslate's `payload.workflow_type`. */
export const WORKFLOW_TYPES = [
  'auto',
  'markdown_based',
  'txt',
  'json',
  'xlsx',
  'docx',
  'srt',
  'epub',
  'html',
  'ass',
  'pptx',
] as const

/** One supported workflow kind. */
export type WorkflowType = (typeof WORKFLOW_TYPES)[number]

/** Result file kinds accepted by the download/content endpoints. */
export const FILE_TYPES = [
  'markdown',
  'markdown_zip',
  'html',
  'txt',
  'json',
  'xlsx',
  'csv',
  'docx',
  'srt',
  'epub',
  'ass',
  'pptx',
] as const

/** One supported result file kind. */
export type FileType = (typeof FILE_TYPES)[number]

/** Document conversion engines accepted for PDF/Markdown inputs. */
export const CONVERT_ENGINES = ['identity', 'mineru', 'docling', 'mineru_deploy'] as const

/** One supported document conversion engine. */
export type ConvertEngine = (typeof CONVERT_ENGINES)[number]

/** How a translation is written relative to the source text. */
export type InsertMode = 'replace' | 'append' | 'prepend'

/** Text segmentation strategy (TXT workflow only). */
export type SegmentMode = 'line' | 'paragraph' | 'none'

/**
 * LLM connection parameters forwarded to DocuTranslate. Every field is
 * optional: an unset field either falls back to the service's own `.env`
 * defaults (deployment mode B) or is supplied by the plugin per call (mode A).
 */
export interface LlmParams {
  readonly base_url?: string
  readonly api_key?: string
  readonly model_id?: string
  readonly provider?: string
  readonly temperature?: number
  readonly top_p?: number
  readonly chunk_size?: number
  readonly concurrent?: number
  readonly timeout?: number
  readonly retry?: number
  readonly system_proxy_enable?: boolean
  readonly custom_prompt?: string
  readonly force_json?: boolean
  readonly extra_body?: string
}

/** A term dictionary sent as `glossary_dict` (source text → translated text). */
export type GlossaryDict = Record<string, string>

/** One translation payload; the discriminant is `workflow_type`. */
export interface TranslatePayload extends LlmParams {
  readonly workflow_type: WorkflowType
  readonly to_lang?: string
  readonly skip_translate?: boolean
  readonly glossary_dict?: GlossaryDict
  readonly insert_mode?: InsertMode
  readonly separator?: string
  readonly segment_mode?: SegmentMode
}

/** One task's lifecycle state as reported by `/service/status/{id}`. */
export interface TaskStatus {
  readonly task_id: string
  readonly is_processing: boolean
  readonly status_message: string
  readonly error_flag: boolean
  readonly download_ready: boolean
  readonly progress_percent: number
  readonly original_filename_stem: string
  readonly original_filename: string | null
  readonly task_start_time: number | null
  readonly task_end_time: number | null
  /** Result kind → absolute download URL on the service. */
  readonly downloads: Record<string, string>
  /** Attachment identifier → absolute download URL on the service. */
  readonly attachment: Record<string, string>
  readonly statistics: TaskStatistics
}

/** Token accounting attached to a task. */
export interface TaskStatistics {
  readonly glossary: unknown
  readonly translation: unknown
  readonly total: {
    readonly input_tokens: number
    readonly cached_tokens: number
    readonly output_tokens: number
    readonly reasoning_tokens: number
    readonly total_tokens: number
    readonly request_count: number
    readonly unresolved_errors: number
    readonly unresolved_error_rate: number
  }
}

/** `/service/logs/{id}` response: only lines produced since the previous call. */
export interface LogsResponse {
  readonly logs: string[]
}

/** One review finding's severity. */
export type ReviewSeverity = 'high' | 'medium' | 'low'

/** One review finding's category. */
export type ReviewCategory =
  | 'omission'
  | 'mistranslation'
  | 'terminology'
  | 'format'
  | 'untranslated'
  | 'other'

/** One issue the automatic review reports; a human decides how to fix it. */
export interface ReviewIssue {
  readonly severity: ReviewSeverity
  readonly category: ReviewCategory
  /** Source text near the issue, for locating it in the comparison view. */
  readonly sourceExcerpt: string
  /** Translated text near the issue. */
  readonly translationExcerpt: string
  /** What is wrong. */
  readonly problem: string
  /** Suggested correction, addressed to the human reviewer. */
  readonly suggestion: string
}

/** The review subagent's structured verdict. */
export interface ReviewResult {
  /** `pass` when the translation needs no human decision, `issues` otherwise. */
  readonly verdict: 'pass' | 'issues'
  /** One-sentence overall assessment. */
  readonly summary: string
  readonly issues: readonly ReviewIssue[]
}

/** `/service/content/{id}/{type}` response: the whole file, base64-encoded. */
export interface ContentResponse {
  readonly file_type: FileType
  readonly filename: string
  readonly content: string
}