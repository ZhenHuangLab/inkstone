import { describe, expect, test } from 'bun:test'
import { renderConversation } from '../src/core/render'
import { replayArtifacts } from '../src/sites/claude/artifacts'
import { conversationToIR, linearize } from '../src/sites/claude/convert'
import type { ClaudeConversation, ClaudeMessage } from '../src/sites/claude/types'
import fixtureJson from './fixtures/claude-basic.json'

const fixture = fixtureJson as unknown as ClaudeConversation

const md = (conv: ClaudeConversation, opts = {}): string =>
  renderConversation(conversationToIR(conv, 'fallback'), opts).markdown

/** 只有 assistant 一轮的最小对话，用来单点验证块渲染。 */
function withBlocks(blocks: unknown[]): ClaudeConversation {
  return {
    uuid: 'c1',
    name: 'T',
    current_leaf_message_uuid: 'a1',
    chat_messages: [
      {
        uuid: 'a1',
        parent_message_uuid: null,
        sender: 'assistant',
        content: blocks,
      } as unknown as ClaudeMessage,
    ],
  }
}

describe('linearize', () => {
  test('沿 current_leaf 回溯主线，丢弃被重新生成的旧分支', () => {
    const ids = linearize(fixture).map((m) => m.uuid)
    expect(ids).toEqual(['m1', 'm2', 'm3', 'm4'])
    expect(ids).not.toContain('m2-abandoned')
  })

  test('leaf 缺失时退回 index 排序而不是丢消息', () => {
    const ids = linearize({ ...fixture, current_leaf_message_uuid: null }).map((m) => m.uuid)
    expect(ids.length).toBe(5)
    expect(ids[0]).toBe('m1')
  })

  test('parent 链成环也能收敛', () => {
    const conv: ClaudeConversation = {
      current_leaf_message_uuid: 'x',
      chat_messages: [
        { uuid: 'x', parent_message_uuid: 'y', sender: 'human' },
        { uuid: 'y', parent_message_uuid: 'x', sender: 'assistant' },
      ] as ClaudeMessage[],
    }
    expect(linearize(conv).map((m) => m.uuid).sort()).toEqual(['x', 'y'])
  })

  test('非 human/assistant 的消息不参与轮次', () => {
    const conv: ClaudeConversation = {
      current_leaf_message_uuid: 'b',
      chat_messages: [
        { uuid: 'a', parent_message_uuid: null, sender: 'system' },
        { uuid: 'b', parent_message_uuid: 'a', sender: 'human' },
      ] as ClaudeMessage[],
    }
    expect(linearize(conv).map((m) => m.uuid)).toEqual(['b'])
  })
})

describe('artifact 折叠', () => {
  test('create + update 折叠成终稿，只在最后一次编辑处出现', () => {
    const out = md(fixture)
    expect(out).toContain('function a() {')
    expect(out).toContain('return 2')
    expect(out).not.toContain('return 1')
    // 终稿整块出现一次；创建处只留一行指引
    expect(out.match(/> \[!abstract\] Artifact · 工具函数/g)?.length).toBe(1)
    expect(out).toContain('*(Artifact 创建「工具函数」，终稿见后)*')
  })

  test('new_str 里的 $& 等替换模式按字面量写入，不被 replace 语义吞掉', () => {
    // 字符串形式的 replace 会把 $& 展开成匹配到的文本，静默损坏代码
    const conv = withBlocks([
      {
        type: 'tool_use',
        name: 'artifacts',
        input: { command: 'create', id: 'a', type: 'application/vnd.ant.code', content: 'X', version_uuid: 'v1' },
      },
      {
        type: 'tool_use',
        name: 'artifacts',
        input: { command: 'update', id: 'a', old_str: 'X', new_str: 'cost($&) + $` + $$9', version_uuid: 'v2' },
      },
    ])
    expect(md(conv)).toContain('cost($&) + $` + $$9')
  })

  test('old_str 匹配不上就放弃重放，原始 JSON 兜底且不受 toolTraces 开关', () => {
    const conv = withBlocks([
      {
        type: 'tool_use',
        name: 'artifacts',
        input: { command: 'create', id: 'a', content: 'hello', version_uuid: 'v1' },
      },
      {
        type: 'tool_use',
        name: 'artifacts',
        input: { command: 'update', id: 'a', old_str: '不存在的文本', new_str: 'x', version_uuid: 'v2' },
      },
    ])
    const out = md(conv) // 注意：没开 toolTraces
    expect(out).toContain('重放失败，原始 JSON')
    expect(out).toContain('不存在的文本')
    // 失配之前的终稿仍要留下，不能因为一次失败就整份丢掉
    expect(out).toContain('hello')
  })

  test('rewrite 重新奠定基线，之前的失配不影响后续', () => {
    const messages = [
      {
        uuid: 'm',
        sender: 'assistant',
        content: [
          { type: 'tool_use', name: 'artifacts', input: { command: 'create', id: 'a', content: 'v1', version_uuid: '1' } },
          { type: 'tool_use', name: 'artifacts', input: { command: 'update', id: 'a', old_str: 'zzz', new_str: 'q', version_uuid: '2' } },
          { type: 'tool_use', name: 'artifacts', input: { command: 'rewrite', id: 'a', content: '全新内容', version_uuid: '3' } },
        ],
      },
    ] as unknown as ClaudeMessage[]
    const ops = replayArtifacts(messages)
    expect(ops.get('m#2')?.finalContent).toBe('全新内容')
  })

  test('artifact 类型决定是否套围栏', () => {
    const codeOut = md(
      withBlocks([
        {
          type: 'tool_use',
          name: 'artifacts',
          input: {
            command: 'create',
            id: 'a',
            title: 'demo',
            type: 'application/vnd.ant.code',
            language: 'python',
            content: 'print(1)',
            version_uuid: 'v1',
          },
        },
      ]),
    )
    expect(codeOut).toContain('```python')

    const mdOut = md(
      withBlocks([
        {
          type: 'tool_use',
          name: 'artifacts',
          input: {
            command: 'create',
            id: 'a',
            title: 'doc',
            type: 'text/markdown',
            content: '# 文档标题',
            version_uuid: 'v1',
          },
        },
      ]),
    )
    // Markdown artifact 走正文管道：标题降一级，不套围栏
    expect(mdOut).toContain('## 文档标题')
    expect(mdOut).not.toContain('```')
  })
})

describe('内容块分发', () => {
  test('thinking 默认不写入，开关打开后进折叠 callout', () => {
    expect(md(fixture)).not.toContain('用户要一个最小函数')
    const withThoughts = md(fixture, { thoughts: true })
    expect(withThoughts).toContain('> [!quote]- 思考过程')
    expect(withThoughts).toContain('**分析需求**')
    expect(withThoughts).toContain('用户要一个最小函数')
  })

  test('工具痕迹默认不写入，开关打开后进折叠 callout', () => {
    const out = md(fixture)
    expect(out).not.toContain('web_search')
    expect(out).not.toContain('搜索返回了三条结果')

    const traced = md(fixture, { toolTraces: true })
    expect(traced).toContain('工具调用 → `web_search`')
    expect(traced).toContain('搜索返回了三条结果')
  })

  test('未识别的块类型留原始 JSON，永不静默丢内容', () => {
    const out = md(withBlocks([{ type: 'future_block', payload: { keep: '这段不能丢' } }]))
    expect(out).toContain('未识别的内容块 `future_block`')
    expect(out).toContain('这段不能丢')
  })

  test('用户中止与 truncated 如实标注', () => {
    const conv = withBlocks([{ type: 'text', text: '半句话' }])
    conv.chat_messages![0]!.stop_reason = 'user_canceled'
    conv.chat_messages![0]!.truncated = true
    const out = md(conv)
    expect(out).toContain('*(这条回复被用户中止)*')
    expect(out).toContain('*(服务端将这条消息标记为 truncated)*')
  })

  test('create_file 与 widget 作为内容承载块写入', () => {
    const out = md(
      withBlocks([
        { type: 'tool_use', name: 'create_file', input: { path: 'src/a.py', file_text: 'print(1)' } },
        { type: 'tool_use', name: 'visualize:show_widget', input: { title: '图表', widget_code: '<div/>' } },
      ]),
    )
    expect(out).toContain('> [!abstract] 文件 · src/a.py')
    expect(out).toContain('```python')
    expect(out).toContain('> [!abstract] Widget · 图表')
  })
})

describe('附件', () => {
  test('图片留占位符，文本抽取件整块内联', () => {
    const out = md(fixture)
    expect(out).toContain('%%INKSTONE-ASSET-img-1%%')
    expect(out).toContain('> [!abstract] 附件 · 说明.md（文本抽取）')
    // 附件自带的标题被降级并包在 callout 里，不污染文档大纲
    expect(out).toContain('> ## 附件自带的标题')
  })

  test('图片附件带上下载地址交给编排层', () => {
    const { assets } = renderConversation(conversationToIR(fixture, ''))
    const img = assets.find((a) => a.fileId === 'img-1')
    expect(img?.kind).toBe('image')
    expect(img?.url).toBe('/api/files/img-1/preview')
  })

  test('拿不到地址的附件留名字，不假装能下载', () => {
    const conv = withBlocks([{ type: 'text', text: 'x' }])
    conv.chat_messages![0]!.files = [{ file_kind: 'blob', file_name: '录音.m4a' }]
    const out = md(conv)
    expect(out).toContain('*(附件：录音.m4a · blob — 无可下载地址)*')
  })
})

describe('引用与 frontmatter', () => {
  test('引用汇总进 Sources，过期来源不写入', () => {
    const out = md(fixture)
    expect(out).toContain('# Sources')
    expect(out).toContain('- [参考 A](https://example.com/a)')
    expect(out).not.toContain('expired.example.com')
  })

  test('frontmatter 带站点标记、项目与地址', () => {
    const out = md(fixture)
    expect(out).toContain('chat_id: 3f9a1c20-77b4-4e0d-9f21-0a5b6c7d8e9f')
    expect(out).toContain('url: https://claude.ai/chat/3f9a1c20-77b4-4e0d-9f21-0a5b6c7d8e9f')
    expect(out).toContain('created: 2026-08-01T10:00:00.000Z')
    expect(out).toContain('model: claude-opus-5')
    expect(out).toContain('project: "研究笔记"')
    expect(out).toContain('  - claude')
  })

  test('轮次标题用 Claude 而不是 ChatGPT', () => {
    const out = md(fixture)
    expect(out).toContain('# User')
    expect(out).toContain('# Claude')
    expect(out).not.toContain('# ChatGPT')
  })

  test('公式定界符照样转换（与 ChatGPT 侧共用同一段管道）', () => {
    expect(md(fixture)).toContain('$x^2$')
  })

  test('标题为空时回退 Untitled', () => {
    expect(md({ ...fixture, name: '   ' })).toContain('title: "Untitled"')
  })
})
