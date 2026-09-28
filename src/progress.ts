/**
 * An optional progress surface for one translation.
 *
 * A foreground dsh tool has no progress channel of its own: `output.render`
 * runs only after `execute` returns. So while the tool polls DocuTranslate it
 * registers a lightweight, **unowned** `ctx.jobs` job purely as a display
 * surface. The Web client's job list reads that registry and shows the live
 * progress line / output panel; the tool still waits for the translation and
 * returns its normal synchronous result.
 *
 * Unowned is deliberate: `dsh-tool-jobs` skips completion notices for jobs
 * without an owner, so the display row never injects a spurious "read your
 * job output" message into the conversation. If no job registry (or no
 * controller) is present, the surface is simply absent and the tool behaves
 * as before.
 *
 * The registry is reached structurally rather than through a typed peer
 * dependency, so this plugin keeps working across harness versions that move
 * the job packages.
 * @module dsh-document-translate/progress
 */

import type { Context } from '@deepseek-ai/cordis'

/** Minimal structural view of one job handle. */
interface JobHandleLike {
  /** Replace the live progress line shown beside the job. */
  updateProgress(line: string): void
  /** Append one durable line to the job's output panel. */
  append(text: string, options?: { channel?: string }): void
}

/** Minimal structural view of the producer hooks `run` must return. */
interface JobHooksLike {
  cancel(reason?: string): void
  done: Promise<{ status: 'completed' | 'failed'; detail?: string }>
}

/** Minimal structural view of one job spec. */
interface JobSpecLike {
  kind: string
  label: string
  run(job: JobHandleLike): JobHooksLike
}

/** Minimal structural view of the job registry service. */
interface JobRegistryLike {
  start(spec: JobSpecLike): string
}

/** One translation's live progress surface. */
export interface ProgressSurface {
  /** Replace the live progress line, e.g. `45% 翻译中`. */
  update(line: string): void
  /** Append one durable milestone line to the job's output panel. */
  log(line: string): void
  /** Settle the display job as completed. Idempotent; safe to call in a `finally`. */
  finish(): void
  /** Settle the display job as failed with a reason. Idempotent; wins over a later `finish`. */
  fail(detail: string): void
}

/**
 * Open a progress surface for one translation, or `undefined` when no job
 * registry is available.
 *
 * @param ctx - the plugin context, for `ctx.get('jobs')`.
 * @param label - the one-line job label (source → target language).
 * @returns the surface, or `undefined` when jobs are unavailable.
 */
export function startProgress(ctx: Context, label: string): ProgressSurface | undefined {
  const jobs = ctx.get('jobs') as JobRegistryLike | undefined
  if (jobs === undefined || label.length === 0) return undefined

  let handle: JobHandleLike | undefined
  let settle!: () => void
  let closed = false
  let outcome: { status: 'completed' | 'failed'; detail?: string } = { status: 'completed' }
  // The producer's `done` stays pending until the tool's work finishes, which
  // keeps the row live for exactly as long as the translation runs.
  const settled = new Promise<void>((resolve) => { settle = resolve })

  try {
    jobs.start({
      kind: 'translate',
      label,
      run: (job) => {
        handle = job
        return {
          // The foreground tool owns cancellation through `exec.signal`; the
          // display row must not settle out from under it.
          cancel: () => undefined,
          done: settled.then(() => outcome),
        }
      },
    })
  } catch {
    // No controller serves this context, or the per-owner job cap is reached:
    // the translation still runs, just without a progress row.
    return undefined
  }
  if (handle === undefined) return undefined
  const live = handle

  return {
    update: (line) => live.updateProgress(line),
    log: (line) => live.append(`${line}\n`, { channel: 'log' }),
    finish: () => {
      if (closed) return
      closed = true
      outcome = { status: 'completed' }
      settle()
    },
    fail: (detail) => {
      if (closed) return
      closed = true
      outcome = { status: 'failed', detail }
      settle()
    },
  }
}