import { mapTextSegmentsOutsideCode } from './codeaware'

/**
 * 公式定界符转换（代码块 / 行内代码感知）：
 *   \( ... \)  →  $...$
 *   \[ ... \]  →  $$ ... $$（独立成行）
 * escapeCurrency=true 时另转义正文里的货币美元符（$123），防止 Obsidian
 * 误判为行内公式。Claude 原生使用 $...$，调用方必须关闭这项。
 */
export function convertMath(text: string, escapeCurrency = true): string {
  return mapTextSegmentsOutsideCode(text, (segment) => convertSegment(segment, escapeCurrency))
}

function convertSegment(seg: string, escapeCurrency: boolean): string {
  // 转义须在定界符转换之前做，否则会把公式产出的 $ 一起转义
  if (escapeCurrency) seg = seg.replace(/(?<![\\$])\$(?=\d)/g, '\\$')
  seg = seg.replace(/[ \t]*\\\[\s*([\s\S]*?)\s*\\\][ \t]*/g, (_m, body: string) => `\n\n$$\n${body}\n$$\n\n`)
  // $ 后紧跟空格会让 Obsidian 不渲染行内公式，所以 body 两侧空白要吃掉
  seg = seg.replace(/\\\(\s*([\s\S]*?)\s*\\\)/g, (_m, body: string) => `$${body}$`)
  return seg
}
