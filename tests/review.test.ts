import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildReviewBrief } from '../lib/review.js'

test('buildReviewBrief points at both files and states the target language', () => {
  const brief = buildReviewBrief({
    sourcePath: '/tmp/a.source.md',
    translationPath: '/tmp/a.translated.md',
    sourceName: 'a.md',
    targetLanguage: 'English',
    notes: ['源 PDF 有 1 页需要 OCR'],
  })
  assert.match(brief, /\/tmp\/a\.source\.md/)
  assert.match(brief, /\/tmp\/a\.translated\.md/)
  assert.match(brief, /English/)
  assert.match(brief, /源 PDF 有 1 页需要 OCR/)
  assert.match(brief, /不要修改任何文件/)
})

test('buildReviewBrief omits the notes section when there is nothing to note', () => {
  const brief = buildReviewBrief({
    sourcePath: '/tmp/a.source.md',
    translationPath: '/tmp/a.translated.md',
    sourceName: 'a.md',
    targetLanguage: '简体中文',
    notes: [],
  })
  assert.ok(!brief.includes('已知背景'))
  assert.match(brief, /简体中文/)
})