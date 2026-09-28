import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startProgress } from '../lib/progress.js'

/** Minimal fake `ctx.jobs`: capture the spec and expose its handle hooks. */
function makeJobs(): {
  registry: { start(spec: { kind: string; label: string; owner?: string; run(handle: unknown): { cancel(reason?: string): void; done: Promise<unknown> } }): string }
  state: {
    spec?: { kind: string; label: string; owner?: string }
    hooks?: { cancel(reason?: string): void; done: Promise<{ status: string; detail?: string }> }
    calls: unknown[][]
  }
} {
  const state: {
    spec?: { kind: string; label: string; owner?: string }
    hooks?: { cancel(reason?: string): void; done: Promise<{ status: string; detail?: string }> }
    calls: unknown[][]
  } = { calls: [] }
  return {
    registry: {
      start(spec) {
        state.spec = { kind: spec.kind, label: spec.label, owner: spec.owner }
        const handle = {
          updateProgress: (line: string) => state.calls.push(['progress', line]),
          append: (text: string, options?: unknown) => state.calls.push(['append', text, options]),
        }
        state.hooks = spec.run(handle) as typeof state.hooks
        return 'translate-1'
      },
    },
    state,
  }
}

/** A context that only answers `get('jobs')`. */
function fakeCtx(jobs: unknown): never {
  return { get: (name: string) => name === 'jobs' ? jobs : undefined } as never
}

test('startProgress returns undefined when no job registry is available', () => {
  assert.equal(startProgress(fakeCtx(undefined), 'a.md → English'), undefined)
})

test('startProgress registers an unowned translate job and exposes progress', () => {
  const { registry, state } = makeJobs()
  const surface = startProgress(fakeCtx(registry), 'a.md → English')
  assert.ok(surface)
  assert.equal(state.spec?.kind, 'translate')
  assert.equal(state.spec?.label, 'a.md → English')
  // Unowned: no completion notice is delivered for it.
  assert.equal(state.spec?.owner, undefined)
  surface.update('45% 翻译中')
  surface.log('提交给 DocuTranslate：a.md')
  assert.deepEqual(state.calls[0], ['progress', '45% 翻译中'])
  assert.deepEqual(state.calls[1], ['append', '提交给 DocuTranslate：a.md\n', { channel: 'log' }])
})

test('finish settles the job as completed and is idempotent', async () => {
  const { registry, state } = makeJobs()
  const surface = startProgress(fakeCtx(registry), 'a.md → English')!
  surface.finish()
  surface.finish()
  assert.deepEqual(await state.hooks!.done, { status: 'completed' })
})

test('fail wins over a later finish and carries the reason', async () => {
  const { registry, state } = makeJobs()
  const surface = startProgress(fakeCtx(registry), 'a.md → English')!
  surface.fail('task timed out')
  surface.finish()
  assert.deepEqual(await state.hooks!.done, { status: 'failed', detail: 'task timed out' })
})

test('a registry that refuses to start degrades to no progress surface', () => {
  const refusing = { start: () => { throw new Error('no job controller') } }
  assert.equal(startProgress(fakeCtx(refusing), 'a.md → English'), undefined)
})