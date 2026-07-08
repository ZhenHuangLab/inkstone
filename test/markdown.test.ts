import { describe, expect, test } from 'bun:test'
import { conversationToMarkdown, filenameFor } from '../src/convert/markdown'
import type { ConversationDetail } from '../src/types'
import fixtureJson from './fixtures/basic.json'

const fixture = fixtureJson as unknown as ConversationDetail
const { markdown, title } = conversationToMarkdown(fixture)

describe('conversationToMarkdown', () => {
  test('frontmatter 字段齐全', () => {
    expect(title).toBe('质能方程推导')
    expect(markdown.startsWith('---\n')).toBe(true)
    expect(markdown).toContain('title: "质能方程推导"')
    expect(markdown).toContain('chat_id: abc12345-6789-4def-8012-3456789abcde')
    expect(markdown).toContain('url: https://chatgpt.com/c/abc12345-6789-4def-8012-3456789abcde')
    expect(markdown).toContain('model: gpt-5-thinking')
    expect(markdown).toContain('created: 2025-07-02T')
    expect(markdown).toContain('tags:\n  - chatgpt')
  })

  test('User / ChatGPT 作为最高级标题', () => {
    expect(markdown).toContain('\n# User\n')
    expect(markdown).toContain('\n# ChatGPT\n')
  })

  test('旧分支内容不出现', () => {
    expect(markdown).not.toContain('旧回答')
  })

  test('正文标题整体降一级', () => {
    expect(markdown).toContain('\n## 我的问题\n') // 用户消息里的 H1
    expect(markdown).toContain('\n### 推导\n') // 助手消息里的 H2
    expect(markdown).toContain('\n#### 代码示例\n')
  })

  test('公式定界符转换', () => {
    expect(markdown).toContain('$E=mc^2$')
    expect(markdown).toContain('$$\nE = mc^2\n$$')
    expect(markdown).toContain('其中 $c$ 是光速')
    expect(markdown).toContain('\\$100')
  })

  test('引用标记剥离，不留乱码', () => {
    expect(markdown).not.toContain('turn0search1')
    expect(markdown).not.toContain(String.fromCharCode(0xe200))
    expect(markdown).not.toContain('【3†source】')
    expect(markdown).toContain('从动量守恒出发，得到：')
  })

  test('代码块与行内代码原样保留', () => {
    expect(markdown).toContain('# 这行注释不该被降级')
    expect(markdown).toContain('print("\\(not math\\)")')
    expect(markdown).toContain('`\\(x\\)`')
  })

  test('代码解释器：代码围栏 + 运行输出折叠 callout', () => {
    expect(markdown).toContain('```python\nm = 2')
    expect(markdown).toContain('> [!note]- 运行输出')
    expect(markdown).toContain('1.7975103574736352e+17')
  })

  test('思维链折叠 callout', () => {
    expect(markdown).toContain('> [!quote]- 思考过程')
    expect(markdown).toContain('> **分析问题**')
  })

  test('未知内容类型进折叠 callout，不静默丢弃', () => {
    expect(markdown).toContain('未识别的内容类型 `mystery_blob`')
    expect(markdown).toContain('"foo": 1')
  })
})

describe('filenameFor', () => {
  test('非法字符换成空格并压缩', () => {
    expect(filenameFor('a/b:c*d?"<>|#^[]e', 'abc12345-rest')).toBe('a b c d e ~abc12345.md')
  })

  test('空标题回退 Untitled', () => {
    expect(filenameFor('', 'abc12345-rest')).toBe('Untitled ~abc12345.md')
  })

  test('超长标题截断到 80 字符', () => {
    const name = filenameFor('长'.repeat(200), 'abc12345-rest')
    expect(name.length).toBeLessThanOrEqual(80 + ' ~abc12345.md'.length)
  })
})
