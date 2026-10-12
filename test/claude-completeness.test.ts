import { describe, expect, test } from 'bun:test'
import { claudeAdapter } from '../src/sites/claude'
import { renderConversation } from '../src/core/render'
import type { ClaudeConversation } from '../src/sites/claude/types'
import { listSandboxFiles } from '../src/sites/claude/api'

const conversation: ClaudeConversation = {
  uuid: 'conversation',
  chat_messages: [{ uuid: 'message', sender: 'assistant', content: [
    { type: 'text', text: '保留下来的正文' },
    { type: 'tool_use', name: 'present_files', input: { filepaths: ['/mnt/user-data/outputs/report.md'] } },
  ] }],
}

describe('Claude 附件发现完整性', () => {
  test('清单中混有无效文件时不能静默丢弃后宣称发现完整', async () => {
    const originalFetch = globalThis.fetch
    const originalLocation = Object.getOwnPropertyDescriptor(globalThis, 'location')
    Object.defineProperty(globalThis, 'location', { configurable: true, value: { origin: 'https://claude.ai' } })
    globalThis.fetch = (() => Promise.resolve(Response.json({ files_metadata: [
      { path: '/mnt/user-data/outputs/report.md', size: 12 },
      { size: 12 },
    ] }))) as unknown as typeof fetch
    try {
      await expect(listSandboxFiles('org', 'conversation')).rejects.toThrow('清单结构已变化')
    } finally {
      globalThis.fetch = originalFetch
      if (originalLocation) Object.defineProperty(globalThis, 'location', originalLocation)
      else Reflect.deleteProperty(globalThis, 'location')
    }
  })

  test('清单失败时显式标记不完整，同时保留正文和文件卡片说明', () => {
    const ir = claudeAdapter.toIR(conversation, '', { sandboxFiles: [], sandboxUnavailable: true })
    expect(ir.assetDiscoveryFailed).toBe(true)
    const result = renderConversation(ir)
    expect(result.markdown).toContain('保留下来的正文')
    expect(result.markdown).toContain('生成文件清单获取失败')
    expect(result.assets).toHaveLength(0)
  })

  test('成功的空清单不等同于清单发现失败', () => {
    expect(claudeAdapter.toIR(conversation, '', { sandboxFiles: [] }).assetDiscoveryFailed).toBeUndefined()
  })
})
