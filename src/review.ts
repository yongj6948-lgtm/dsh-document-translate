/**
 * Build the brief the calling agent hands to its own `subagent` tool. The
 * plugin never reviews and never chooses a review model: it extracts both
 * sides to Markdown, points the brief at those files, and states the checklist.
 * The reviewer reads the files itself, so the brief stays small regardless of
 * document length.
 * @module dsh-document-translate/review
 */

/** The facts a review brief needs. */
export interface ReviewMaterial {
  /** Absolute path to the source document as Markdown. */
  readonly sourcePath: string
  /** Absolute path to the translated document as Markdown. */
  readonly translationPath: string
  /** Original source filename, for context. */
  readonly sourceName: string
  /** Target language the translation was requested in. */
  readonly targetLanguage: string
  /** Non-fatal facts the reviewer should know (format, PDF OCR pages, warnings). */
  readonly notes: readonly string[]
}

/**
 * Compose the subagent prompt for one translation.
 *
 * @param material - extracted file paths and review context.
 * @returns a self-contained prompt for the `subagent` tool.
 */
export function buildReviewBrief(material: ReviewMaterial): string {
  const notes = material.notes.length === 0
    ? ''
    : `\n已知背景：\n${material.notes.map(note => `- ${note}`).join('\n')}\n`
  return `请复查一份文档翻译，只报告确凿问题，不要修改任何文件。

原文（Markdown）：${material.sourcePath}
译文（Markdown）：${material.translationPath}
目标语言：${material.targetLanguage}
${notes}
先用文件读取工具读完这两份 Markdown，然后整体通读，逐项核查：

1. 漏译 / 多译 / 段落遗漏或重复
2. 误译、意思偏离、术语或专有名词错误
3. 未翻译的残留（仍为原文语言）、语种错误
4. 格式与占位符：Markdown 结构、标题层级、列表、表格、代码块、链接、URL、数字、编号、变量占位符、字幕时间轴
5. 术语与全文一致性

输出要求：
- 每条问题给出 severity（high/medium/low）、category（omission/mistranslation/terminology/format/untranslated/other）、
  能定位问题的原文片段与译文片段、问题说明、给人工的修改建议。
- 不要报告风格偏好或无法确定的问题。没有问题时直接说明“未发现问题”。
- 用中文写说明与建议。`
}