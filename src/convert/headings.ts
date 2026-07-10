import { mapLinesOutsideFencedCode } from './codeaware'

/**
 * 消息内容里的 H1–H6 整体降 depth 级（H6 封顶），
 * 把最高级标题让给 `# User` / `# ChatGPT` 作为对话轮次分隔。
 */
export function demoteHeadings(text: string, depth = 1): string {
  return mapLinesOutsideFencedCode(text, (line) => {
    // ATX 标题要求 # 后带空格或行尾；#hashtag 不是标题
    const m = /^( {0,3})(#{1,6})([ \t].*|)$/.exec(line)
    if (!m) return line
    const level = Math.min(6, m[2]!.length + depth)
    return m[1]! + '#'.repeat(level) + m[3]!
  })
}

/** 「全部剥离」模式：消息内标题一律转成加粗行，文档层级只留 `# User` / `# ChatGPT`。 */
export function stripHeadings(text: string): string {
  return mapLinesOutsideFencedCode(text, (line) => {
    const m = /^ {0,3}#{1,6}([ \t].*|)$/.exec(line)
    if (!m) return line
    // ATX 闭合序列（`# 标题 ##`）也要去掉；`# C#` 里的 # 属于标题文本，不受影响
    const inner = m[1]!.replace(/[ \t]+#+[ \t]*$/, '').trim()
    return inner === '' ? '' : `**${inner}**`
  })
}

export type HeadingMode = 'demote' | 'strip'

export function transformHeadings(text: string, mode: HeadingMode): string {
  return mode === 'strip' ? stripHeadings(text) : demoteHeadings(text)
}
