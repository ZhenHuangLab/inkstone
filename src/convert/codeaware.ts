// Markdown 代码感知的文本变换基础设施：
// 所有正文改写（公式定界符、标题降级、引用剥离）都必须跳过代码，规则集中在这一处实现。

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/

/**
 * 逐行变换，fenced code block 内的行原样保留。
 * lineFn 只会收到代码块之外的整行（不含换行符）。
 */
export function mapLinesOutsideFencedCode(text: string, lineFn: (line: string) => string): string {
  let fence: string | null = null
  return text
    .split('\n')
    .map((line) => {
      if (fence) {
        const close = FENCE_CLOSE.exec(line)
        if (close && close[1]!.charAt(0) === fence.charAt(0) && close[1]!.length >= fence.length) {
          fence = null
        }
        return line
      }
      const open = FENCE_OPEN.exec(line)
      if (open) {
        fence = open[1]!
        return line
      }
      return lineFn(line)
    })
    .join('\n')
}

/**
 * 分段变换：fenced code block 与行内 code span 原样保留，
 * 其余文本合并成尽量大的片段交给 fn（片段可跨多行，便于处理跨行公式）。
 */
export function mapTextSegmentsOutsideCode(text: string, fn: (segment: string) => string): string {
  const lines = text.split('\n')
  const out: string[] = []
  let buf: string[] = []
  let fence: string | null = null

  const flush = () => {
    if (buf.length > 0) {
      out.push(mapOutsideInlineCode(buf.join('\n'), fn))
      buf = []
    }
  }

  for (const line of lines) {
    if (fence) {
      out.push(line)
      const close = FENCE_CLOSE.exec(line)
      if (close && close[1]!.charAt(0) === fence.charAt(0) && close[1]!.length >= fence.length) {
        fence = null
      }
      continue
    }
    const open = FENCE_OPEN.exec(line)
    if (open) {
      flush()
      out.push(line)
      fence = open[1]!
    } else {
      buf.push(line)
    }
  }
  flush()
  return out.join('\n')
}

function mapOutsideInlineCode(segment: string, fn: (s: string) => string): string {
  // split 带捕获组：奇数下标是 code span，原样保留
  return segment
    .split(/(`+[^`]*`+)/)
    .map((part, i) => (i % 2 === 1 ? part : fn(part)))
    .join('')
}
