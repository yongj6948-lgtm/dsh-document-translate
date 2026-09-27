import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractMarkdown, extractPdfMarkdown } from '../lib/extract.js'

const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url))

test('extractMarkdown reads text formats directly', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dt-extract-'))
  const path = join(directory, 'a.md')
  await writeFile(path, '# Title\n\nbody\n')
  const result = await extractMarkdown(path)
  assert.equal(result.method, 'direct')
  assert.equal(result.markdown, '# Title\n\nbody\n')
})

test('extractMarkdown converts a docx through anydoc', async () => {
  const result = await extractMarkdown(join(fixtures, 'sample.docx'))
  assert.equal(result.method, 'anydoc')
  assert.match(result.markdown, /产品说明/)
  assert.match(result.markdown, /Markdown/)
})

test('extractPdfMarkdown reads a text-based PDF locally', async () => {
  const result = await extractPdfMarkdown(join(fixtures, 'sample.pdf'))
  assert.equal(result.method, 'pdf-inspector')
  assert.equal(result.pdf.pdfType, 'TextBased')
  assert.match(result.markdown, /Dummy PDF file/)
})