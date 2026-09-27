import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DocuTranslateClient, DocuTranslateError, parseFilename } from '../lib/client.js'

/** Build a fetch stub that records calls and answers with the given responses in order. */
function stubFetch(responses) {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    const next = responses.shift()
    if (next instanceof Error) throw next
    return new Response(next.body, next)
  }
  return { fetchImpl, calls }
}

test('parseFilename reads plain and RFC 5987 filenames', () => {
  assert.equal(parseFilename('attachment; filename="a.md"'), 'a.md')
  assert.equal(parseFilename("attachment; filename*=UTF-8''%E6%96%87%E6%A1%A3.md"), '文档.md')
  assert.equal(parseFilename(null), undefined)
})

test('submit posts multipart and returns the task id', async () => {
  const { fetchImpl, calls } = stubFetch([
    { status: 200, body: JSON.stringify({ task_id: 'abc123' }) },
  ])
  const client = new DocuTranslateClient({
    baseURL: 'http://service:8010/',
    timeoutMs: 1000,
    fetchImpl,
  })
  const taskId = await client.submit(
    'a.md',
    new TextEncoder().encode('# hi'),
    { workflow_type: 'markdown_based', to_lang: 'English' },
  )
  assert.equal(taskId, 'abc123')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'http://service:8010/service/translate/file')
  assert.equal(calls[0].init.method, 'POST')
  const form = calls[0].init.body
  assert.ok(form instanceof FormData)
  assert.equal(form.get('file').name, 'a.md')
  assert.deepEqual(JSON.parse(form.get('payload')), {
    workflow_type: 'markdown_based',
    to_lang: 'English',
  })
})

test('HTTP errors carry the FastAPI detail and a stable code', async () => {
  const { fetchImpl } = stubFetch([
    { status: 404, body: JSON.stringify({ detail: '找不到任务' }) },
  ])
  const client = new DocuTranslateClient({
    baseURL: 'http://service:8010',
    timeoutMs: 1000,
    fetchImpl,
  })
  await assert.rejects(
    () => client.status('missing'),
    (error) => {
      assert.ok(error instanceof DocuTranslateError)
      assert.equal(error.code, 'DT_HTTP')
      assert.equal(error.status, 404)
      assert.match(error.message, /找不到任务/)
      return true
    },
  )
})

test('a submission without a task id fails as an unprocessable body', async () => {
  const { fetchImpl } = stubFetch([{ status: 200, body: JSON.stringify({}) }])
  const client = new DocuTranslateClient({
    baseURL: 'http://service:8010',
    timeoutMs: 1000,
    fetchImpl,
  })
  await assert.rejects(
    () => client.submit('a.md', new Uint8Array(), { workflow_type: 'txt' }),
    (error) => error instanceof DocuTranslateError && error.code === 'DT_BAD_BODY',
  )
})

test('content decodes the base64 envelope', async () => {
  const payload = Buffer.from('# translated').toString('base64')
  const { fetchImpl } = stubFetch([
    { status: 200, body: JSON.stringify({ file_type: 'markdown', filename: 'a.md', content: payload }) },
  ])
  const client = new DocuTranslateClient({
    baseURL: 'http://service:8010',
    timeoutMs: 1000,
    fetchImpl,
  })
  const bytes = await client.content('abc', 'markdown')
  assert.equal(Buffer.from(bytes).toString(), '# translated')
})