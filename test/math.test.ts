import { describe, expect, test } from 'bun:test'
import { convertMath } from '../src/convert/math'

describe('convertMath', () => {
  test('行内 \\(..\\) → $..$', () => {
    expect(convertMath('能量 \\(E=mc^2\\) 守恒')).toBe('能量 $E=mc^2$ 守恒')
  })

  test('行间 \\[..\\] → $$ 独立成行', () => {
    const out = convertMath('推导：\n\\[\nE = mc^2\n\\]\n完毕')
    expect(out).toContain('$$\nE = mc^2\n$$')
  })

  test('夹在句子里的 \\[..\\] 也独立成行', () => {
    expect(convertMath('a \\[x+y\\] b')).toBe('a\n\n$$\nx+y\n$$\n\nb')
  })

  test('定界符内侧空白被吃掉（$ 后跟空格 Obsidian 不渲染）', () => {
    expect(convertMath('\\( x \\)')).toBe('$x$')
  })

  test('fenced code 内不转换', () => {
    const src = '```tex\n\\(x\\)\n```'
    expect(convertMath(src)).toBe(src)
  })

  test('行内代码内不转换', () => {
    expect(convertMath('前 `\\(x\\)` 后 \\(y\\)')).toBe('前 `\\(x\\)` 后 $y$')
  })

  test('货币美元符转义', () => {
    expect(convertMath('价格 $100')).toBe('价格 \\$100')
  })

  test('已转义的美元符不重复转义', () => {
    expect(convertMath('价格 \\$100')).toBe('价格 \\$100')
  })

  test('转换产出的公式 $ 不被货币转义误伤', () => {
    expect(convertMath('\\(3x\\)')).toBe('$3x$')
  })
})
