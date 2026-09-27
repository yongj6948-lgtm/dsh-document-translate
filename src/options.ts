/**
 * Plugin configuration and its resolved form. Every deployment-tunable value
 * lives in the Cordis `Config` schema so `cordis.yml` or a profile patch can
 * change it without a code edit; `apply` folds in launch-environment fallbacks
 * and constants.
 * @module dsh-document-translate/options
 */

import type { Context } from '@deepseek-ai/cordis'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import z from '@deepseek-ai/schemastery'
import type { InsertMode, ThinkingMode, WorkflowType } from './types.js'
import { WORKFLOW_TYPES } from './types.js'

/** Default DocuTranslate endpoint (the LAN service this deployment targets). */
export const DEFAULT_SERVICE_URL = 'http://127.0.0.1:8010'

/** Default target language. */
export const DEFAULT_TARGET_LANG = '简体中文'

/** Default workflow selection; the service sniffs the file type. */
export const DEFAULT_WORKFLOW_TYPE: WorkflowType = 'auto'

/** Default insertion mode: replace the source text with the translation. */
export const DEFAULT_INSERT_MODE: InsertMode = 'replace'

/** Default separator used when `insert_mode` is `append` or `prepend`. */
export const DEFAULT_SEPARATOR = '\n'

/** Default per-request timeout (the translation itself can run for minutes). */
export const DEFAULT_REQUEST_TIMEOUT_MS = 120_000

/** Default overall task timeout. */
export const DEFAULT_TASK_TIMEOUT_MS = 1_800_000

/** Default poll interval while waiting for a task. */
export const DEFAULT_POLL_INTERVAL_MS = 2_000

/** Default credential reference holding the translation LLM's API key. */
export const DEFAULT_LLM_API_KEY_ENV = 'DOCUTRANSLATE_LLM_API_KEY'

/** Plugin config; every field optional, `apply` supplies env/constant defaults. */
export interface Config {
  /** DocuTranslate service root. Falls back to `$DOCUTRANSLATE_SERVICE_URL`. */
  baseURL?: string
  /** Default target language. Falls back to `$DOCUTRANSLATE_TO_LANG`. */
  targetLang?: string
  /** Default workflow kind. Defaults to `auto`. */
  workflowType?: WorkflowType
  /** Default insertion mode. Defaults to `replace`. */
  insertMode?: InsertMode
  /** Default separator for `append`/`prepend`. Defaults to a newline. */
  separator?: string
  /** Per-request HTTP timeout in milliseconds. */
  requestTimeoutMs?: number
  /** Overall task timeout in milliseconds. */
  taskTimeoutMs?: number
  /** Poll interval in milliseconds. */
  pollIntervalMs?: number
  /** Translation LLM base URL (OpenAI-compatible). Empty uses the service default. */
  llmBaseURL?: string
  /** Translation LLM model id. Empty uses the service default. */
  llmModelId?: string
  /** Translation LLM provider hint passed to the service. */
  llmProvider?: string
  /** Thinking policy for the translation LLM. */
  llmThinking?: ThinkingMode
  /** Credential reference holding the translation LLM API key. */
  llmApiKeyEnv?: string
  /** Document conversion engine for PDF/Markdown inputs. */
  convertEngine?: 'identity' | 'mineru' | 'docling' | 'mineru_deploy'
  /** Directory for translated output; empty writes beside the source file. */
  outputDir?: string
}

/** Schemastery schema validating {@link Config} in `cordis.yml`. */
export const Config: z<Config> = z.object({
  baseURL: z.string(),
  targetLang: z.string(),
  workflowType: z.union(WORKFLOW_TYPES),
  insertMode: z.union(['replace', 'append', 'prepend'] as const),
  separator: z.string(),
  requestTimeoutMs: z.number().step(1).min(1),
  taskTimeoutMs: z.number().step(1).min(1),
  pollIntervalMs: z.number().step(1).min(1),
  llmBaseURL: z.string(),
  llmModelId: z.string(),
  llmProvider: z.string(),
  llmThinking: z.union(['default', 'enable', 'disable'] as const),
  llmApiKeyEnv: z.string(),
  convertEngine: z.union(['identity', 'mineru', 'docling', 'mineru_deploy'] as const),
  outputDir: z.string(),
})

/** Fully resolved options (no optional tuning fields). */
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
  readonly llmThinking?: ThinkingMode
  readonly llmApiKeyEnv: string
  readonly convertEngine?: 'identity' | 'mineru' | 'docling' | 'mineru_deploy'
  /** Resolved output directory; empty means "beside the source file". */
  readonly outputDir: string
}

/**
 * Resolve plugin config against launch environment and constants.
 *
 * @param ctx - the consuming context, for the launch-environment snapshot.
 * @param config - validated plugin config.
 * @returns fully populated options.
 */
export function resolveOptions(ctx: Context, config: Config): ResolvedOptions {
  const env = launchEnvironmentOf(ctx)
  const baseURL = config.baseURL
    ?? env.get('DOCUTRANSLATE_SERVICE_URL')?.value
    ?? DEFAULT_SERVICE_URL
  const targetLang = config.targetLang
    ?? env.get('DOCUTRANSLATE_TO_LANG')?.value
    ?? DEFAULT_TARGET_LANG
  return {
    baseURL: baseURL.replace(/\/+$/, ''),
    targetLang,
    workflowType: config.workflowType ?? DEFAULT_WORKFLOW_TYPE,
    insertMode: config.insertMode ?? DEFAULT_INSERT_MODE,
    separator: config.separator ?? DEFAULT_SEPARATOR,
    requestTimeoutMs: config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    taskTimeoutMs: config.taskTimeoutMs ?? DEFAULT_TASK_TIMEOUT_MS,
    pollIntervalMs: config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    ...pick('llmBaseURL', config.llmBaseURL),
    ...pick('llmModelId', config.llmModelId),
    ...pick('llmProvider', config.llmProvider),
    ...pick('llmThinking', config.llmThinking),
    llmApiKeyEnv: config.llmApiKeyEnv ?? DEFAULT_LLM_API_KEY_ENV,
    ...pick('convertEngine', config.convertEngine),
    outputDir: config.outputDir ?? '',
  }
}

/** Include an optional field only when it carries a value. */
function pick<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  if (value === undefined) return {}
  if (typeof value === 'string' && value.length === 0) return {}
  return { [key]: value } as { [P in K]?: V }
}