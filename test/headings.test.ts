import { describe, expect, test } from 'bun:test'
import { demoteHeadings, stripHeadings } from '../src/convert/headings'

describe('demoteHeadings', () => {
  test('H1–H5 降一级', () => {
    expect(demoteHeadings('# A\n## B\n##### E')).toBe('## A\n### B\n###### E')
  })

  test('H6 封顶不再降', () => {
    expect(demoteHeadings('###### F')).toBe('###### F')
  })

  test('fenced code 里的 # 注释不动', () => {
    const src = '```python\n# comment\n```'
    expect(demoteHeadings(src)).toBe(src)
  })

  test('#hashtag（# 后无空格）不是标题', () => {
    expect(demoteHeadings('#hashtag')).toBe('#hashtag')
  })

  test('行中的 # 不动', () => {
    expect(demoteHeadings('数量 # 5')).toBe('数量 # 5')
  })
})

describe('stripHeadings（全部剥离模式）', () => {
  test('各级标题转加粗行', () => {
    expect(stripHeadings('# A\n正文\n### C')).toBe('**A**\n正文\n**C**')
  })

  test('ATX 闭合序列去掉，标题文本里的 # 保留', () => {
    expect(stripHeadings('## 标题 ##')).toBe('**标题**')
    expect(stripHeadings('# C#')).toBe('**C#**')
  })

  test('空标题行清空', () => {
    expect(stripHeadings('#')).toBe('')
  })

  test('fenced code 里的 # 注释不动', () => {
    const src = '```python\n# comment\n```'
    expect(stripHeadings(src)).toBe(src)
  })

  test('#hashtag 不是标题', () => {
    expect(stripHeadings('#hashtag')).toBe('#hashtag')
  })
})
