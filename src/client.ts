/**
 * HTTP client for one DocuTranslate service. Stateless; safe to share across
 * calls. Owns URL shaping, timeouts, cancellation merging, and error
 * normalization into {@link DocuTranslateError}.
 * @module dsh-document-translate/client
 */

import type {
  ContentResponse,
  FileType,
  LogsResponse,
  TranslatePayload,
  TaskStatus,
} from './types.js'

/** Stable failure codes surfaced to the tool. */
export type DocuTranslateErrorCode =
  | 'DT_ABORTED'
  | 'DT_TIMEOUT'
  | 'DT_UNREACHABLE'
  | 'DT_HTTP'
  | 'DT_BAD_BODY'
  | 'DT_TASK_FAILED'

/** One client failure with a stable code and optional HTTP status. */
export class DocuTranslateError extends Error {
  /** Stable routing code; message text never carries routing meaning. */
  readonly code: DocuTranslateErrorCode
  /** HTTP status of the offending response, when one was received. */
  readonly status?: number

  /**
   * @param message - human-readable detail.
   * @param code - stable routing code.
   * @param options - original cause and HTTP status.
   */
  constructor(
    message: string,
    code: DocuTranslateErrorCode,
    options: { cause?: unknown; status?: number } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined)
    this.name = 'DocuTranslateError'
    this.code = code
    if (options.status !== undefined) this.status = options.status
  }
}

/** Resolved client settings. */
export interface ClientOptions {
  /** Service root, without a trailing slash. */
  readonly baseURL: string
  /** Per-request timeout in milliseconds. */
  readonly timeoutMs: number
  /** Fetch implementation, injectable for tests. */
  readonly fetchImpl?: typeof fetch
}

/** One downloaded result file. */
export interface DownloadedFile {
  /** Raw result bytes. */
  readonly bytes: Uint8Array
  /** Filename advertised by `Content-Disposition`, when present. */
  readonly filename?: string
}

/** A submitted task identifier. */
export type TaskId = string

/**
 * Talks to one DocuTranslate service over its `/service` routes.
 */
export class DocuTranslateClient {
  private readonly baseURL: string
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch

  /**
   * @param options - resolved service endpoint and timeout.
   */
  constructor(options: ClientOptions) {
    this.baseURL = options.baseURL.replace(/\/+$/, '')
    this.timeoutMs = options.timeoutMs
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  /** Read the service version. */
  async meta(signal?: AbortSignal): Promise<{ version: string }> {
    return await this.json<{ version: string }>('GET', '/service/meta', signal)
  }

  /** Read the available document-conversion engines. */
  async engineList(signal?: AbortSignal): Promise<string[]> {
    return await this.json<string[]>('GET', '/service/engin-list', signal)
  }

  /** Read the service's default parameters (including `env_force_override`). */
  async defaultParams(signal?: AbortSignal): Promise<Record<string, unknown>> {
    return await this.json<Record<string, unknown>>('GET', '/service/default-params', signal)
  }

  /**
   * Submit one file for translation and return its task id.
   *
   * @param fileName - original filename, including extension.
   * @param bytes - raw file bytes (multipart upload; never base64).
   * @param payload - workflow parameters.
   * @param signal - caller cancellation.
   * @returns the assigned task id.
   */
  async submit(
    fileName: string,
    bytes: Uint8Array,
    payload: TranslatePayload,
    signal?: AbortSignal,
  ): Promise<TaskId> {
    const form = new FormData()
    form.append('file', new Blob([bytes as BlobPart]), fileName)
    form.append('payload', JSON.stringify(payload))
    const response = await this.request('POST', '/service/translate/file', signal, { body: form })
    const body = await this.readJson(response)
    const taskId = typeof body === 'object' && body !== null && 'task_id' in body
      ? (body as { task_id?: unknown }).task_id
      : undefined
    if (typeof taskId !== 'string' || taskId.length === 0) {
      throw new DocuTranslateError(
        `submission response carried no task_id: ${truncate(JSON.stringify(body))}`,
        'DT_BAD_BODY',
      )
    }
    return taskId
  }

  /** Read one task's current state. */
  async status(taskId: TaskId, signal?: AbortSignal): Promise<TaskStatus> {
    return await this.json<TaskStatus>('GET', `/service/status/${encodeURIComponent(taskId)}`, signal)
  }

  /** Read logs produced since the previous call for this task. */
  async logs(taskId: TaskId, signal?: AbortSignal): Promise<string[]> {
    const body = await this.json<LogsResponse>('GET', `/service/logs/${encodeURIComponent(taskId)}`, signal)
    return Array.isArray(body.logs) ? body.logs : []
  }

  /** Download one result file as raw bytes. */
  async download(taskId: TaskId, fileType: FileType, signal?: AbortSignal): Promise<DownloadedFile> {
    const response = await this.request(
      'GET',
      `/service/download/${encodeURIComponent(taskId)}/${fileType}`,
      signal,
      {},
    )
    const bytes = new Uint8Array(await response.arrayBuffer())
    const filename = parseFilename(response.headers.get('content-disposition'))
    return { bytes, ...filename !== undefined ? { filename } : {} }
  }

  /** Read one result file decoded from the service's base64 JSON envelope. */
  async content(taskId: TaskId, fileType: FileType, signal?: AbortSignal): Promise<Uint8Array> {
    const body = await this.json<ContentResponse>(
      'GET',
      `/service/content/${encodeURIComponent(taskId)}/${fileType}`,
      signal,
    )
    if (typeof body.content !== 'string') {
      throw new DocuTranslateError(`content response carried no content field`, 'DT_BAD_BODY')
    }
    return new Uint8Array(Buffer.from(body.content, 'base64'))
  }

  /** Ask the service to stop a running task. */
  async cancel(taskId: TaskId, signal?: AbortSignal): Promise<void> {
    await this.json<unknown>('POST', `/service/cancel/${encodeURIComponent(taskId)}`, signal)
  }

  /** Ask the service to drop a task's state and temporary files. */
  async release(taskId: TaskId, signal?: AbortSignal): Promise<void> {
    await this.json<unknown>('POST', `/service/release/${encodeURIComponent(taskId)}`, signal)
  }

  /** Run one request and translate transport failures into client errors. */
  private async request(
    method: string,
    path: string,
    signal: AbortSignal | undefined,
    init: RequestInit,
  ): Promise<Response> {
    const timeout = AbortSignal.timeout(this.timeoutMs)
    const combined = signal !== undefined ? AbortSignal.any([signal, timeout]) : timeout
    let response: Response
    try {
      response = await this.fetchImpl(`${this.baseURL}${path}`, {
        ...init,
        method,
        signal: combined,
        headers: { accept: 'application/json', ...init.headers },
      })
    } catch (error: unknown) {
      throw this.transportError(error, signal, method, path)
    }
    if (!response.ok) {
      const detail = await this.errorDetail(response)
      throw new DocuTranslateError(
        `DocuTranslate ${method} ${path} failed with HTTP ${response.status}: ${detail}`,
        'DT_HTTP',
        { status: response.status },
      )
    }
    return response
  }

  /** Run one request whose response is JSON. */
  private async json<T>(
    method: string,
    path: string,
    signal: AbortSignal | undefined,
  ): Promise<T> {
    const response = await this.request(method, path, signal, {})
    return await this.readJson(response) as T
  }

  /** Decode a JSON body, mapping malformed bodies to a stable error. */
  private async readJson(response: Response): Promise<unknown> {
    try {
      return await response.json()
    } catch (error: unknown) {
      throw new DocuTranslateError(`DocuTranslate returned an unprocessable body: ${String(error)}`, 'DT_BAD_BODY', { cause: error })
    }
  }

  /** Extract a FastAPI `detail` string when the error body carries one. */
  private async errorDetail(response: Response): Promise<string> {
    try {
      const body = await response.json() as { detail?: unknown }
      if (typeof body.detail === 'string' && body.detail.length > 0) return body.detail
    } catch {
      // A non-JSON error body only costs a richer message.
    }
    return `HTTP ${response.status}`
  }

  /** Classify one thrown fetch/timeout/abort error. */
  private transportError(
    error: unknown,
    signal: AbortSignal | undefined,
    method: string,
    path: string,
  ): DocuTranslateError {
    if (signal?.aborted === true) {
      return new DocuTranslateError(`DocuTranslate ${method} ${path} aborted`, 'DT_ABORTED', { cause: error })
    }
    if (isAbortError(error)) {
      return new DocuTranslateError(
        `DocuTranslate ${method} ${path} timed out after ${this.timeoutMs}ms`,
        'DT_TIMEOUT',
        { cause: error },
      )
    }
    return new DocuTranslateError(
      `DocuTranslate ${method} ${path} unreachable: ${String(error)}`,
      'DT_UNREACHABLE',
      { cause: error },
    )
  }
}

/** Parse the filename from a `Content-Disposition` header. */
export function parseFilename(header: string | null): string | undefined {
  if (header === null) return undefined
  const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(header)
  if (utf8 !== null) {
    try {
      return decodeURIComponent(utf8[1]?.trim() ?? '')
    } catch {
      return undefined
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(header)
  return plain?.[1]?.trim()
}

/** True for a fetch or AbortSignal abort. */
function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

/** Bound a diagnostic string so an error message stays readable. */
function truncate(text: string, max = 200): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}