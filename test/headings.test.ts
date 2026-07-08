import { describe, expect, test } from 'bun:test'
import { demoteHeadings } from '../src/convert/headings'

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
