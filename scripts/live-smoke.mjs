/**
 * Live smoke against a running DocuTranslate service. Not part of the test
 * suite: it needs a reachable service (default http://127.0.0.1:8010).
 *
 *   node scripts/live-smoke.mjs [baseURL]
 *
 * By default it runs the no-LLM parse path (`skip_translate: true`) so the
 * submit → poll → download pipeline is verifiable without an LLM credential.
 * Set the three DOCUTRANSLATE_TEST_LLM_* variables to also run a real
 * translation:
 *
 *   DOCUTRANSLATE_TEST_LLM_BASE_URL=https://api.deepseek.com/v1 \
 *   DOCUTRANSLATE_TEST_LLM_API_KEY=sk-... \
 *   DOCUTRANSLATE_TEST_LLM_MODEL_ID=deepseek-chat \
 *   node scripts/live-smoke.mjs
 */
import { DocuTranslateClient } from '../lib/client.js'

const baseURL = process.argv[2] ?? process.env.DOCUTRANSLATE_SERVICE_URL ?? 'http://127.0.0.1:8010'
const client = new DocuTranslateClient({ baseURL, timeoutMs: 120_000 })

console.log(`service: ${baseURL}`)
console.log(`meta: ${JSON.stringify(await client.meta())}`)
console.log(`engines: ${JSON.stringify(await client.engineList())}`)
console.log(`default-params: ${JSON.stringify(await client.defaultParams())}`)

/** Wait for a task to settle, printing progress transitions. */
async function wait(taskId, taskTimeoutMs = 300_000) {
  const deadline = Date.now() + taskTimeoutMs
  let last = ''
  for (;;) {
    const status = await client.status(taskId)
    const line = `${status.progress_percent}% ${status.status_message}`
    if (line !== last) {
      console.log(`  [${taskId}] ${line}`)
      last = line
    }
    if (status.download_ready || status.error_flag) return status
    if (!status.is_processing) return status
    if (Date.now() >= deadline) throw new Error(`task ${taskId} timed out`)
    await new Promise((resolve) => setTimeout(resolve, 2_000))
  }
}

const source = `# Live smoke\n\nHello from dsh-document-translate at ${new Date().toISOString()}.\n\n- alpha\n- beta\n`
const bytes = new TextEncoder().encode(source)

// Phase 1: no-LLM parse path.
const parseId = await client.submit('smoke.md', bytes, {
  workflow_type: 'markdown_based',
  to_lang: 'English',
  skip_translate: true,
  convert_engine: 'identity',
})
console.log(`\n=== parse-only task ${parseId} ===`)
const parseStatus = await wait(parseId)
console.log(`result: ready=${parseStatus.download_ready} error=${parseStatus.error_flag} ${parseStatus.status_message}`)
console.log(`downloads: ${JSON.stringify(Object.keys(parseStatus.downloads))}`)
if (parseStatus.download_ready) {
  const markdown = await client.download(parseId, 'markdown')
  console.log(`markdown bytes: ${markdown.bytes.byteLength}, filename=${markdown.filename ?? '(none)'}`)
  console.log(String.fromCharCode(...markdown.bytes.slice(0, 240)))
}
await client.release(parseId)
console.log(`released ${parseId}`)

// Phase 2 (optional): real translation.
const llmBaseURL = process.env.DOCUTRANSLATE_TEST_LLM_BASE_URL
const llmApiKey = process.env.DOCUTRANSLATE_TEST_LLM_API_KEY
const llmModelId = process.env.DOCUTRANSLATE_TEST_LLM_MODEL_ID
if (llmBaseURL && llmApiKey && llmModelId) {
  console.log(`\n=== real translation task (model ${llmModelId}) ===`)
  const translateId = await client.submit('smoke.md', bytes, {
    workflow_type: 'markdown_based',
    to_lang: 'English',
    base_url: llmBaseURL,
    api_key: llmApiKey,
    model_id: llmModelId,
    convert_engine: 'identity',
  })
  const status = await wait(translateId)
  console.log(`result: ready=${status.download_ready} error=${status.error_flag} ${status.status_message}`)
  if (status.download_ready) {
    const translated = await client.download(translateId, 'markdown')
    console.log(`translated markdown bytes: ${translated.bytes.byteLength}`)
    console.log(String.fromCharCode(...translated.bytes.slice(0, 400)))
  }
  await client.release(translateId)
} else {
  console.log('\n(real-translation phase skipped: set DOCUTRANSLATE_TEST_LLM_BASE_URL/API_KEY/MODEL_ID to run it)')
}