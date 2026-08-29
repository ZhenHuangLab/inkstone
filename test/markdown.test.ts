import { describe, expect, test } from 'bun:test'
import { assetLink, conversationToMarkdown, filenameFor, sanitizeSubdir } from '../src/convert/markdown'
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

  test('project 会话使用 gizmo 地址并写入 project 名', () => {
    const conv = { ...fixture, gizmo_id: 'g-p-project' }
    const { markdown: md } = conversationToMarkdown(conv, '', { projectName: '研究计划' })
    expect(md).toContain(
      'url: https://chatgpt.com/g/g-p-project/c/abc12345-6789-4def-8012-3456789abcde',
    )
    expect(md).toContain('project: "研究计划"')
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

  test('工具运行痕迹默认不写入（代码解释器代码 / 运行输出）', () => {
    expect(markdown).not.toContain('m = 2')
    expect(markdown).not.toContain('工具调用')
    expect(markdown).not.toContain('> [!note]- 运行输出')
    expect(markdown).not.toContain('1.7975103574736352e+17')
  })

  test('toolTraces 打开：代码/运行输出各自折叠 callout 包裹', () => {
    const { markdown: md } = conversationToMarkdown(fixture, '', { toolTraces: true })
    expect(md).toContain('> [!example]- 工具调用 → `python`')
    expect(md).toContain('> ```python')
    expect(md).toContain('> m = 2')
    expect(md).toContain('> [!note]- 运行输出')
    expect(md).toContain('1.7975103574736352e+17')
  })

  test('发给工具的 text 载荷（联网搜索等）随 toolTraces 开关', () => {
    const conv = {
      title: '搜索测试',
      conversation_id: 'feedface-0000-0000-0000-000000000000',
      current_node: 's1',
      mapping: {
        s1: {
          id: 's1',
          parent: null,
          children: [],
          message: {
            id: 's1',
            author: { role: 'assistant' },
            recipient: 'web.run',
            content: { content_type: 'text', parts: ['{"search_query":[{"q":"Synology DSM"}]}'] },
          },
        },
      },
    } as unknown as ConversationDetail
    const { markdown: off } = conversationToMarkdown(conv)
    expect(off).not.toContain('search_query')
    expect(off).not.toContain('工具调用')
    const { markdown: on } = conversationToMarkdown(conv, '', { toolTraces: true })
    expect(on).toContain('工具调用 → `web.run`')
    expect(on).toContain('search_query')
  })

  test('思考过程默认不写入', () => {
    expect(markdown).not.toContain('思考过程')
    expect(markdown).not.toContain('分析问题')
  })

  test('thoughts 打开：思维链折叠 callout', () => {
    const { markdown: md } = conversationToMarkdown(fixture, '', { thoughts: true })
    expect(md).toContain('> [!quote]- 思考过程')
    expect(md).toContain('> **分析问题**')
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
    expect(result.markdown).toContain('%%INKSTONE-ASSET-file_img123%%')
    expect(result.assets.some((a) => a.fileId === 'file_img123' && a.kind === 'image')).toBe(true)
  })

  test('上传附件登记；已内联的图片不重复列出', () => {
    expect(result.markdown).toContain('%%INKSTONE-ASSET-file_doc456%%')
    expect(result.markdown.split('%%INKSTONE-ASSET-file_img123%%').length - 1).toBe(1)
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
    expect(markdown).toContain('branched_from: "[[原对话标题-aaaaaaaa]]"')
    expect(markdown).toContain(
      'branched_from_url: https://chatgpt.com/c/aaaaaaaa-1111-0000-0000-000000000000',
    )
  })
})

describe('filenameFor', () => {
  test('非法字符与空白归一为 - 并折叠', () => {
    expect(filenameFor('a/b:c*d?"<>|#^[]e', 'abc12345-rest')).toBe('a-b-c-d-e-abc12345.md')
    expect(filenameFor('带 空格 的  标题', 'abc12345-rest')).toBe('带-空格-的-标题-abc12345.md')
  })

  test('文件名不含空格和波浪线', () => {
    const name = filenameFor('质能方程 E=mc^2 推导?', 'abc12345-rest')
    expect(name).not.toMatch(/[\s~]/)
  })

  test('空标题回退 Untitled', () => {
    expect(filenameFor('', 'abc12345-rest')).toBe('Untitled-abc12345.md')
  })

  test('超长标题截断到 80 字符', () => {
    const name = filenameFor('长'.repeat(200), 'abc12345-rest')
    expect(name.length).toBeLessThanOrEqual(80 + '-abc12345.md'.length)
  })
})

describe('sanitizeSubdir', () => {
  test('普通名与嵌套路径原样保留', () => {
    expect(sanitizeSubdir('conversations')).toBe('conversations')
    expect(sanitizeSubdir('ChatGPT/对话')).toBe('ChatGPT/对话')
  })

  test('非法字符逐段归一为 -', () => {
    expect(sanitizeSubdir('a:b*c/d e')).toBe('a-b-c/d-e')
  })

  test('目录逃逸段被丢弃', () => {
    expect(sanitizeSubdir('../etc')).toBe('etc')
    expect(sanitizeSubdir('a/../b')).toBe('a/b')
    expect(sanitizeSubdir('./a')).toBe('a')
  })

  test('首尾与连续斜杠折叠', () => {
    expect(sanitizeSubdir('/a//b/')).toBe('a/b')
  })

  test('空串与纯垃圾输入归为空（不套子文件夹）', () => {
    expect(sanitizeSubdir('')).toBe('')
    expect(sanitizeSubdir('  ')).toBe('')
    expect(sanitizeSubdir('..')).toBe('')
    expect(sanitizeSubdir('//')).toBe('')
  })
})

describe('model 检测', () => {
  const chainConv = (slugs: Array<string | undefined>, dflt?: string): ConversationDetail => {
    const mapping: Record<string, unknown> = {}
    let parent: string | null = null
    let last = ''
    slugs.forEach((slug, i) => {
      const uid = `u${i}`
      const aid = `a${i}`
      mapping[uid] = {
        id: uid,
        parent,
        children: [aid],
        message: { id: uid, author: { role: 'user' }, content: { content_type: 'text', parts: ['问'] } },
      }
      mapping[aid] = {
        id: aid,
        parent: uid,
        children: [],
        message: {
          id: aid,
          author: { role: 'assistant' },
          content: { content_type: 'text', parts: ['答'] },
          metadata: slug ? { model_slug: slug } : {},
        },
      }
      if (parent) (mapping[parent] as { children: string[] }).children.push(uid)
      parent = aid
      last = aid
    })
    return {
      title: 'model 测试',
      conversation_id: 'cccccccc-0000-0000-0000-000000000000',
      current_node: last,
      default_model_slug: dflt,
      mapping,
    } as unknown as ConversationDetail
  }

  test('消息级 model_slug 优先于 default_model_slug', () => {
    const { markdown } = conversationToMarkdown(chainConv(['gpt-5-6-sol-pro'], 'gpt-5-6-pro'))
    expect(markdown).toContain('model: gpt-5-6-sol-pro')
    expect(markdown).not.toContain('model: gpt-5-6-pro')
  })

  test('中途切换模型：model 取最后一条，models 去重列出全部', () => {
    const { markdown } = conversationToMarkdown(
      chainConv(['gpt-5-6-pro', 'gpt-5-6-sol-pro', 'gpt-5-6-sol-pro'], 'gpt-5-6-pro'),
    )
    expect(markdown).toContain('model: gpt-5-6-sol-pro')
    expect(markdown).toContain('models:\n  - gpt-5-6-pro\n  - gpt-5-6-sol-pro')
  })

  test('模型 A→B→A 回切：model 取实际最后使用的 A，而非去重序列末位的 B', () => {
    const { markdown } = conversationToMarkdown(
      chainConv(['gpt-5-6-sol-pro', 'gpt-5-6-pro', 'gpt-5-6-sol-pro']),
    )
    expect(markdown).toContain('model: gpt-5-6-sol-pro')
    expect(markdown).toContain('models:\n  - gpt-5-6-sol-pro\n  - gpt-5-6-pro')
  })

  test('单一模型不输出 models 列表', () => {
    const { markdown } = conversationToMarkdown(chainConv(['gpt-5-6-sol-pro']))
    expect(markdown).not.toContain('models:')
  })

  test('无消息级 slug 时回退 default_model_slug', () => {
    const { markdown } = conversationToMarkdown(chainConv([undefined], 'gpt-5-6-pro'))
    expect(markdown).toContain('model: gpt-5-6-pro')
  })
})

describe('思考过程开关', () => {
  test('默认不写入，thoughts: true 时含思考过程', () => {
    expect(markdown).not.toContain('思考过程')
    const on = conversationToMarkdown(fixture, '', { thoughts: true })
    expect(on.markdown).toContain('> [!quote]- 思考过程')
    expect(on.markdown).toContain('分析问题')
    // 正文其他内容不受影响
    expect(on.markdown).toContain('$E=mc^2$')
  })
})

describe('assetLink（P3 链接风格）', () => {
  test('wikilink：图片嵌入 / 文件带别名', () => {
    expect(assetLink('wikilink', 'attachments/ab-img.png', { embed: true })).toBe('![[attachments/ab-img.png]]')
    expect(assetLink('wikilink', 'attachments/ab-doc.pdf', { label: '论文.pdf' })).toBe('[[attachments/ab-doc.pdf|论文.pdf]]')
  })

  test('wikilink 别名里的 | 和 ] 被替换', () => {
    expect(assetLink('wikilink', 'a/b.pdf', { label: 'x|y]z' })).toBe('[[a/b.pdf|x-y-z]]')
  })

  test('markdown 标准链接：路径 URL 编码，标签转义', () => {
    expect(assetLink('markdown', 'attachments/ab-图 1.png', { embed: true, label: '图 1.png' })).toBe('![图 1.png](attachments/ab-%E5%9B%BE%201.png)')
    expect(assetLink('markdown', 'a/b.pdf', { label: 'x[1].pdf' })).toBe('[x\\[1\\].pdf](a/b.pdf)')
  })
})

describe('headingMode（P3 排版风格）', () => {
  test('strip 模式：消息内标题剥离为加粗行，角色标题保留', () => {
    const { markdown: stripped } = conversationToMarkdown(fixture, '', { headingMode: 'strip' })
    expect(stripped).toContain('\n# User\n')
    expect(stripped).toContain('\n**我的问题**\n')
    expect(stripped).not.toContain('\n## 我的问题\n')
    expect(stripped).toContain('# 这行注释不该被降级') // 代码块不受影响
  })
})
