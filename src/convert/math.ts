import { mapTextSegmentsOutsideCode } from './codeaware'

/**
 * 公式定界符转换（代码块 / 行内代码感知）：
 *   \( ... \)  →  $...$
 *   \[ ... \]  →  $$ ... $$（独立成行）
 * 并转义正文里的货币美元符（$123），防止 Obsidian 误判为行内公式。
 */
export function convertMath(text: string): string {
  return mapTextSegmentsOutsideCode(text, convertSegment)
}

function convertSegment(seg: string): string {
  // 转义须在定界符转换之前做，否则会把公式产出的 $ 一起转义
  seg = seg.replace(/(?<![\\$])\$(?=\d)/g, '\\$')
  seg = seg.replace(
    /[ \t]*\\\[\s*([\s\S]*?)\s*\\\][ \t]*/g,
    (_m, body: string) => `\n\n$$\n${body}\n$$\n\n`,
  )
  // $ 后紧跟空格会让 Obsidian 不渲染行内公式，所以 body 两侧空白要吃掉
  seg = seg.replace(/\\\(\s*([\s\S]*?)\s*\\\)/g, (_m, body: string) => `$${body}$`)
  return seg
}
