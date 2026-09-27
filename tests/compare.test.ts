import { test } from 'node:test'
import assert from 'node:assert/strict'
import { alignBlocks, renderCompareHtml, splitBlocks } from '../lib/compare.js'

test('splitBlocks separates headings, list items, fences, tables and paragraphs', () => {
  const blocks = splitBlocks([
    '# Title',
    '',
    'A paragraph',
    'continuing here.',
    '',
    '- item one',
    '- item two',
    '',
    '```js',
    'const a = 1',
    '',
    'const b = 2',
    '```',
    '',
    '| a | b |',
    '| - | - |',
  ].join('\n'))
  assert.deepEqual(blocks.map(block => block.kind), [
    'heading', 'paragraph', 'list', 'list', 'code', 'table',
  ])
  assert.equal(blocks[4].text, '```js\nconst a = 1\n\nconst b = 2\n```')
})

test('alignBlocks flags a kind mismatch without dropping rows', () => {
  const pairs = alignBlocks(
    splitBlocks('# Title\n\nbody'),
    splitBlocks('Title\n\nbody'),
  )
  assert.equal(pairs.length, 2)
  assert.equal(pairs[0].kindMismatch, true)
  assert.equal(pairs[1].kindMismatch, false)
})

test('renderCompareHtml renders both sides and warnings', () => {
  const html = renderCompareHtml({
    title: 'doc.md',
    sourceName: 'doc.md',
    translationName: 'doc.translated.md',
    pairs: alignBlocks(splitBlocks('Hello'), splitBlocks('你好')),
    warnings: ['one warning'],
  })
  assert.match(html, /<!DOCTYPE html>/)
  assert.match(html, /你好/)
  assert.match(html, /one warning/)
  assert.match(html, /翻译对照/)
})

test('renderCompareHtml neutralizes script in document text', () => {
  const html = renderCompareHtml({
    title: 'x',
    sourceName: 'x.md',
    translationName: 'y.md',
    pairs: alignBlocks(splitBlocks('<script>alert(1)</script>'), splitBlocks('x')),
    warnings: [],
  })
  assert.ok(!html.includes('<script>alert(1)</script>'))
  assert.match(html, /&lt;script&gt;/)
})