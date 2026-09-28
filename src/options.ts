/**
 * Plugin configuration and its resolved form. Every deployment-varying value
 * lives in the Cordis `Config` schema as a volatile reference so the built-in
 * settings page can edit it live and no endpoint or credential is hardcoded in
 * this package. `resolveOptions` reads the current references at the start of
 * each operation.
 * @module dsh-document-translate/options
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import z from '@deepseek-ai/schemastery'
import type { ConvertEngine, InsertMode, WorkflowType } from './types.js'
import { CONVERT_ENGINES, WORKFLOW_TYPES } from './types.js'

/** Default DocuTranslate endpoint; deployments override it. */
export const DEFAULT_SERVICE_URL = 'http://127.0.0.1:8010'

/** Default target language. */
export const DEFAULT_TARGET_LANG = '简体中文'

/** Default workflow selection; the service sniffs the file type. */
export const DEFAULT_WORKFLOW_TYPE: WorkflowType = 'auto'

/** Default insertion mode: replace the source text with the translation. */
export const DEFAULT_INSERT_MODE: InsertMode = 'replace'

/** Default separator used when `insertMode` is `append` or `prepend`. */
export const DEFAULT_SEPARATOR = '\n'

/** Default per-request HTTP timeout in milliseconds. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 120_000

/** Default overall task timeout in milliseconds. */
export const DEFAULT_TASK_TIMEOUT_MS = 1_800_000

/** Default poll interval while waiting for a task. */
export const DEFAULT_POLL_INTERVAL_MS = 2_000

/** Default credential reference holding the translation LLM's API key. */
export const DEFAULT_LLM_API_KEY_ENV = 'DOCUTRANSLATE_LLM_API_KEY'

/** Plugin configuration; every field is a live reference the settings page can edit. */
export interface Config {
  /** DocuTranslate service root. Falls back to `$DOCUTRANSLATE_SERVICE_URL`. */
  baseURL: Volatile<string | undefined>
  /** Default target language. Falls back to `$DOCUTRANSLATE_TO_LANG`. */
  targetLang: Volatile<string | undefined>
  /** Default workflow kind. Defaults to `auto`. */
  workflowType: Volatile<WorkflowType | undefined>
  /** Default insertion mode. Defaults to `replace`. */
  insertMode: Volatile<InsertMode | undefined>
  /** Default separator for `append`/`prepend`. Defaults to a newline. */
  separator: Volatile<string | undefined>
  /** Per-request HTTP timeout in milliseconds. */
  requestTimeoutMs: Volatile<number>
  /** Overall task timeout in milliseconds. */
  taskTimeoutMs: Volatile<number>
  /** Poll interval in milliseconds. */
  pollIntervalMs: Volatile<number>
  /** Translation LLM base URL (OpenAI-compatible). Unset uses the service default. */
  llmBaseURL: Volatile<string | undefined>
  /** Translation LLM model id. Unset uses the service default. */
  llmModelId: Volatile<string | undefined>
  /** Translation LLM provider hint passed to the service. */
  llmProvider: Volatile<string | undefined>
  /** Credential reference holding the translation LLM API key. */
  llmApiKeyEnv: Volatile<string | undefined>
  /** Document conversion engine for PDF/Markdown inputs. */
  convertEngine: Volatile<ConvertEngine | undefined>
  /** Directory for translated output; empty writes beside the source file. */
  outputDir: Volatile<string | undefined>
  /** Show a live progress row during translation (via an unowned `ctx.jobs` display job). */
  showProgress: Volatile<boolean>
}

/** Schemastery schema validating {@link Config} in `cordis.yml` or the settings page. */
export const Config = z.object({
  baseURL: z.string().volatile(),
  targetLang: z.string().volatile(),
  workflowType: z.union(WORKFLOW_TYPES).volatile(),
  insertMode: z.union(['replace', 'append', 'prepend'] as const).volatile(),
  separator: z.string().volatile(),
  requestTimeoutMs: z.number().step(1).min(1).default(DEFAULT_REQUEST_TIMEOUT_MS).volatile(),
  taskTimeoutMs: z.number().step(1).min(1).default(DEFAULT_TASK_TIMEOUT_MS).volatile(),
  pollIntervalMs: z.number().step(1).min(1).default(DEFAULT_POLL_INTERVAL_MS).volatile(),
  llmBaseURL: z.string().volatile(),
  llmModelId: z.string().volatile(),
  llmProvider: z.string().volatile(),
  llmApiKeyEnv: z.string().volatile(),
  convertEngine: z.union(CONVERT_ENGINES).volatile(),
  outputDir: z.string().volatile(),
  showProgress: z.boolean().default(true).volatile(),
})

/** Fully resolved options (no optional tuning fields, no live references). */
export interface ResolvedOptions {
  readonly baseURL: string
  readonly targetLang: string
  readonly workflowType: WorkflowType
  readonly insertMode: InsertMode
  readonly separator: string
  readonly requestTimeoutMs: number
  readonly taskTimeoutMs: number
  readonly pollIntervalMs: number
  readonly llmBaseURL?: string
  readonly llmModelId?: string
  readonly llmProvider?: string
  readonly llmApiKeyEnv: string
  readonly convertEngine?: ConvertEngine
  /** Resolved output directory; empty means "beside the source file". */
  readonly outputDir: string
  /** Whether to show a live progress row during translation. */
  readonly showProgress: boolean
}

/**
 * Read the current value of every reference and fold in launch-environment
 * fallbacks and constants. Call this at the start of each operation so a live
 * settings edit applies to the next call without a restart.
 *
 * @param ctx - the consuming context, for the launch-environment snapshot.
 * @param config - the live plugin config references.
 * @returns fully populated options for one operation.
 */
export function resolveOptions(ctx: Context, config: Config): ResolvedOptions {
  const env = launchEnvironmentOf(ctx)
  const baseURL = config.baseURL.get()
    ?? env.get('DOCUTRANSLATE_SERVICE_URL')?.value
    ?? DEFAULT_SERVICE_URL
  const targetLang = config.targetLang.get()
    ?? env.get('DOCUTRANSLATE_TO_LANG')?.value
    ?? DEFAULT_TARGET_LANG
  return {
    baseURL: baseURL.replace(/\/+$/, ''),
    targetLang,
    workflowType: config.workflowType.get() ?? DEFAULT_WORKFLOW_TYPE,
    insertMode: config.insertMode.get() ?? DEFAULT_INSERT_MODE,
    separator: config.separator.get() ?? DEFAULT_SEPARATOR,
    requestTimeoutMs: config.requestTimeoutMs.get(),
    taskTimeoutMs: config.taskTimeoutMs.get(),
    pollIntervalMs: config.pollIntervalMs.get(),
    ...pick('llmBaseURL', config.llmBaseURL.get()),
    ...pick('llmModelId', config.llmModelId.get()),
    ...pick('llmProvider', config.llmProvider.get()),
    llmApiKeyEnv: config.llmApiKeyEnv.get() ?? DEFAULT_LLM_API_KEY_ENV,
    ...pick('convertEngine', config.convertEngine.get()),
    outputDir: config.outputDir.get() ?? '',
    showProgress: config.showProgress.get(),
  }
}

/** Include an optional field only when it carries a value. */
function pick<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  if (value === undefined) return {}
  if (typeof value === 'string' && value.length === 0) return {}
  return { [key]: value } as { [P in K]?: V }
}