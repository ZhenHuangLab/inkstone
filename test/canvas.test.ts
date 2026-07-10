import { describe, expect, test } from 'bun:test'
import { replayCanvas } from '../src/convert/canvas'
import { conversationToMarkdown } from '../src/convert/markdown'
import type { ConversationDetail, Message } from '../src/types'

let seq = 0
function msg(recipient: string, payload: unknown, role: 'assistant' | 'tool' = 'assistant'): Message {
  seq++
  return {
    id: `m${seq}`,
    author: { role, ...(role === 'tool' ? { name: recipient } : {}) },
    recipient,
    content: {
      content_type: 'text',
      parts: [typeof payload === 'string' ? payload : JSON.stringify(payload)],
    },
  }
}

describe('replayCanvas', () => {
  test('仅 create：终稿落在 create 消息上', () => {
    const create = msg('canmore.create_textdoc', { name: 'notes', type: 'document', content: '# 初稿' })
    const ops = replayCanvas([create])
    expect(ops.get(create.id)?.finalContent).toBe('# 初稿')
    expect(ops.get(create.id)?.docName).toBe('notes')
  })

  test('create + 整篇重写 update：终稿移到 update，create 变一行说明', () => {
    const create = msg('canmore.create_textdoc', { name: 'doc', type: 'document', content: '第一版' })
    const update = msg('canmore.update_textdoc', {
      updates: [{ pattern: '.*', multiple: false, replacement: '第二版\n多行内容' }],
    })
    const ops = replayCanvas([create, update])
    expect(ops.get(create.id)?.finalContent).toBeUndefined()
    expect(ops.get(update.id)?.finalContent).toBe('第二版\n多行内容')
  })

  test('multiple:true 全局替换', () => {
    const create = msg('canmore.create_textdoc', { name: 'd', type: 'document', content: 'a foo b foo' })
    const update = msg('canmore.update_textdoc', {
      updates: [{ pattern: 'foo', multiple: true, replacement: 'bar' }],
    })
    const ops = replayCanvas([create, update])
    expect(ops.get(update.id)?.finalContent).toBe('a bar b bar')
  })

  test('dotall：. 跨行匹配（Python re.DOTALL 语义）', () => {
    const create = msg('canmore.create_textdoc', { name: 'd', type: 'document', content: 'A\nB\nC' })
    const update = msg('canmore.update_textdoc', {
      updates: [{ pattern: 'A.*C', replacement: 'X' }],
    })
    expect(replayCanvas([create, update]).get(update.id)?.finalContent).toBe('X')
  })

  test('pattern 匹配不到：update 重放失败，终稿停在上一次成功处', () => {
    const create = msg('canmore.create_textdoc', { name: 'd', type: 'document', content: '原文' })
    const bad = msg('canmore.update_textdoc', {
      updates: [{ pattern: '不存在的内容', replacement: 'x' }],
    })
    const after = msg('canmore.update_textdoc', {
      updates: [{ pattern: '.*', replacement: 'y' }],
    })
    const ops = replayCanvas([create, bad, after])
    expect(ops.has(bad.id)).toBe(false)
    expect(ops.has(after.id)).toBe(false) // broken 后不再信任
    expect(ops.get(create.id)?.finalContent).toBe('原文')
  })

  test('替换串带 Python 反向引用：不硬猜，重放失败', () => {
    const create = msg('canmore.create_textdoc', { name: 'd', type: 'document', content: 'abc' })
    const update = msg('canmore.update_textdoc', {
      updates: [{ pattern: '(a)bc', replacement: '\\1x' }],
    })
    expect(replayCanvas([create, update]).has(update.id)).toBe(false)
  })

  test('替换串里的 $ 按字面量处理', () => {
    const create = msg('canmore.create_textdoc', { name: 'd', type: 'document', content: 'price' })
    const update = msg('canmore.update_textdoc', {
      updates: [{ pattern: 'price', replacement: '$100' }],
    })
    expect(replayCanvas([create, update]).get(update.id)?.finalContent).toBe('$100')
  })

  test('(?s) 行内旗标可吞掉；未知旗标失败', () => {
    const create = msg('canmore.create_textdoc', { name: 'd', type: 'document', content: 'A\nB' })
    const ok = msg('canmore.update_textdoc', {
      updates: [{ pattern: '(?s)A.*B', replacement: 'ok' }],
    })
    expect(replayCanvas([create, ok]).get(ok.id)?.finalContent).toBe('ok')

    const create2 = msg('canmore.create_textdoc', { name: 'd', type: 'document', content: 'A' })
    const bad = msg('canmore.update_textdoc', {
      updates: [{ pattern: '(?x)A', replacement: 'x' }],
    })
    expect(replayCanvas([create2, bad]).has(bad.id)).toBe(false)
  })

  test('非 JSON / 缺字段的载荷不进 map', () => {
    const junk = msg('canmore.create_textdoc', '这不是 JSON')
    const noContent = msg('canmore.create_textdoc', { name: 'x' })
    const ops = replayCanvas([junk, noContent])
    expect(ops.size).toBe(0)
  })

  test('comment_textdoc 收集批注', () => {
    const create = msg('canmore.create_textdoc', { name: 'd', type: 'document', content: 'x' })
    const comment = msg('canmore.comment_textdoc', {
      comments: [{ pattern: 'x', comment: '这里要改' }],
    })
    const op = replayCanvas([create, comment]).get(comment.id)
    expect(op?.kind).toBe('comment')
    expect(op?.comments?.[0]?.comment).toBe('这里要改')
  })
})

describe('conversationToMarkdown × Canvas', () => {
  function convWith(messages: Message[]): ConversationDetail {
    const mapping: ConversationDetail['mapping'] = {
      root: { id: 'root', message: null, parent: null, children: [] },
    }
    let prev = 'root'
    for (const m of messages) {
      mapping[m.id] = { id: m.id, message: m, parent: prev, children: [] }
      mapping[prev]!.children!.push(m.id)
      prev = m.id
    }
    return {
      title: 'Canvas 测试',
      conversation_id: 'c0ffee00-0000-0000-0000-000000000000',
      current_node: prev,
      mapping,
    }
  }

  test('终稿以 abstract callout 嵌入，中间版本一行说明，无原始 JSON', () => {
    const user: Message = {
      id: `m${++seq}`,
      author: { role: 'user' },
      content: { content_type: 'text', parts: ['写篇文档'] },
    }
    const create = msg('canmore.create_textdoc', { name: '方案', type: 'document', content: '# 大纲\n草稿' })
    const confirm = msg('canmore.create_textdoc', '{"result": "ok"}', 'tool')
    const update = msg('canmore.update_textdoc', {
      updates: [{ pattern: '草稿', replacement: '终稿正文' }],
    })
    const { markdown } = conversationToMarkdown(convWith([user, create, confirm, update]))
    expect(markdown).toContain('*(Canvas 创建「方案」，终稿见后)*')
    expect(markdown).toContain('> [!abstract] Canvas · 方案')
    expect(markdown).toContain('> 终稿正文')
    expect(markdown).toContain('> ## 大纲') // 文档标题走降级管道
    expect(markdown).not.toContain('"result"') // tool 回执不重复
    expect(markdown).not.toContain('工具调用')
  })

  test('code 类型 textdoc 用围栏嵌入', () => {
    const create = msg('canmore.create_textdoc', {
      name: 'script',
      type: 'code/python',
      content: 'print(1)',
    })
    const { markdown } = conversationToMarkdown(convWith([create]))
    expect(markdown).toContain('> [!abstract] Canvas · script')
    expect(markdown).toContain('> ```python')
    expect(markdown).toContain('> print(1)')
  })

  test('重放失败回退原始 JSON 折叠嵌入，不丢内容', () => {
    const junk = msg('canmore.update_textdoc', { updates: [{ pattern: '[无效正则', replacement: 'x' }] })
    const { markdown } = conversationToMarkdown(convWith([junk]))
    expect(markdown).toContain('工具调用 → `canmore.update_textdoc`')
    expect(markdown).toContain('无效正则')
  })
})
