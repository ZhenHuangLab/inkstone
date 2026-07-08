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

describe('附件与引用（P2）', () => {
  const M = (cp: number): string => String.fromCharCode(cp)
  const cite = `${M(0xe200)}cite${M(0xe202)}turn0search1${M(0xe201)}`
  const conv = {
    title: '附件测试',
    conversation_id: 'deadbeef-0000-0000-0000-000000000000',
    current_node: 'a1',
    mapping: {
      u1: {
        id: 'u1',
        parent: null,
        children: ['a1'],
        message: {
          id: 'u1',
          author: { role: 'user' },
          content: {
            content_type: 'multimodal_text',
            parts: [
              {
                content_type: 'image_asset_pointer',
                asset_pointer: 'sediment://file_img123',
                width: 10,
                height: 10,
                size_bytes: 5,
              },
              '看这张图',
            ],
          },
          metadata: {
            attachments: [
              { id: 'file_img123', name: 'x.png', mime_type: 'image/png', size: 5 },
              { id: 'file_doc456', name: '文档.pdf', mime_type: 'application/pdf', size: 123 },
            ],
          },
        },
      },
      a1: {
        id: 'a1',
        parent: 'u1',
        children: [],
        message: {
          id: 'a1',
          author: { role: 'assistant' },
          content: { content_type: 'text', parts: [`有出处。${cite}`] },
          metadata: {
            content_references: [
              {
                matched_text: cite,
                type: 'grouped_webpages',
                items: [{ title: '示例标题', url: 'https://example.com/a', attribution: '示例站' }],
              },
            ],
          },
        },
      },
    },
  }
  const result = conversationToMarkdown(conv as unknown as ConversationDetail)

  test('图片 part → 占位符 + assets 登记', () => {
    expect(result.markdown).toContain('%%GEXPORT-ASSET-file_img123%%')
    expect(result.assets.some((a) => a.fileId === 'file_img123' && a.kind === 'image')).toBe(true)
  })

  test('上传附件登记；已内联的图片不重复列出', () => {
    expect(result.markdown).toContain('%%GEXPORT-ASSET-file_doc456%%')
    expect(result.markdown.split('%%GEXPORT-ASSET-file_img123%%').length - 1).toBe(1)
    expect(result.assets.filter((a) => a.fileId === 'file_img123')).toHaveLength(1)
  })

  test('引用 → 行内链接 + 文末 Sources', () => {
    expect(result.markdown).toContain('（[示例站](https://example.com/a)）')
    expect(result.markdown).toContain('# Sources\n\n- [示例标题](https://example.com/a)')
    expect(result.markdown).not.toContain(M(0xe200))
  })
})

describe('Branch 对话', () => {
  const conv = {
    title: 'Branch · 原对话标题',
    conversation_id: 'bbbbbbbb-0000-0000-0000-000000000000',
    current_node: 'a1',
    mapping: {
      u1: {
        id: 'u1',
        parent: null,
        children: ['a1'],
        message: {
          id: 'u1',
          author: { role: 'user' },
          content: { content_type: 'text', parts: ['继续分析'] },
          metadata: {},
        },
      },
      a1: {
        id: 'a1',
        parent: 'u1',
        children: [],
        message: {
          id: 'a1',
          author: { role: 'assistant' },
          content: { content_type: 'text', parts: ['好的'] },
          metadata: {
            branching_from_conversation_id: 'aaaaaaaa-1111-0000-0000-000000000000',
            branching_from_conversation_title: '原对话标题',
          },
        },
      },
    },
  }
  const { markdown } = conversationToMarkdown(conv as unknown as ConversationDetail)

  test('frontmatter 链接回父对话的导出文件', () => {
    expect(markdown).toContain('branched_from: "[[原对话标题 ~aaaaaaaa]]"')
    expect(markdown).toContain(
      'branched_from_url: https://chatgpt.com/c/aaaaaaaa-1111-0000-0000-000000000000',
    )
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
