import type { AssetRef } from '../../core/ir'
import type { CancelToken } from '../../core/fetcher'
import type { AssetPayload, Rgb, SiteAdapter } from '../types'
import {
  currentConversationId,
  fetchBinary,
  fetchConversation,
  listSandboxFiles,
  resolveOrgId,
  throttleStats,
} from './api'
import { conversationToIR } from './convert'
import type { ClaudeConversation, ClaudeIRContext } from './types'

export const claudeAdapter: SiteAdapter = {
  id: 'claude',
  label: 'Claude',
  // 首版只做「导出当前对话」。批量的地基（分页器、水位线、并发池）都在，
  // 但在 Claude 的限流画像实测清楚之前不开——见 sites/claude/api.ts 的说明。
  supportsBatch: false,

  matches: () => /(^|\.)claude\.ai$/.test(location.hostname),

  currentConversationId,

  prepare: (cancel) => resolveOrgId(cancel),

  fetchRaw: (session, id, cancel) => fetchConversation(session, id, cancel),

  fetchIRContext: async (session, id, raw, cancel): Promise<ClaudeIRContext> => {
    // 普通对话没有 present_files，没必要额外打一遍沙箱接口。
    if (!hasPresentFiles(raw as ClaudeConversation)) return { sandboxFiles: [] }
    try {
      return { sandboxFiles: await listSandboxFiles(session, id, cancel) }
    } catch (error) {
      if (cancel?.cancelled) throw error
      // 附件发现失败不应吞掉整篇正文；转换层会在文件卡片原位留下说明。
      return { sandboxFiles: [], sandboxUnavailable: true }
    }
  },

  toIR: (raw, fallbackId, context) =>
    conversationToIR(
      raw as ClaudeConversation,
      fallbackId,
      (context as ClaudeIRContext | undefined)?.sandboxFiles ?? [],
      (context as ClaudeIRContext | undefined)?.sandboxUnavailable === true,
    ),

  async fetchAsset(
    _session: string,
    ref: AssetRef,
    cancel?: CancelToken,
    maxBytes?: number,
  ): Promise<AssetPayload> {
    // Claude 的普通附件与 Wiggle 下载地址都是同源、登录态直接可取，不需要换签名 URL
    if (!ref.url) throw new Error(`附件 ${ref.name ?? ref.fileId} 没有可下载地址`)
    const { bytes, contentType } = await fetchBinary(ref.url, cancel, maxBytes)
    return { bytes, filename: null, contentType }
  },

  throttleStats,

  ui: {
    // 2026-08-28 真实会话页实测：Files + Share 外层是 actions-group。锚定整个组的
    // 左边界才不会盖住 Files；旧选择器继续留作回退，兼容 Claude 的灰度发布。
    headerAnchor: () =>
      (document.querySelector('[data-testid="wiggle-controls-actions-group"]') ??
        document.querySelector('[data-testid="wiggle-controls-actions"]') ??
        document.querySelector('[data-testid="wiggle-controls-actions-share"]') ??
        document.querySelector('[data-testid="share-button"]') ??
        document.querySelector('[data-testid="chat-menu-trigger"]') ??
        document.querySelector('header button[aria-haspopup="menu"]') ??
        document.querySelector('[data-testid="chat-title-split"]')) as HTMLElement | null,

    composerAnchor: () =>
      ((() => {
        const editor = document.querySelector('[data-testid="chat-input"][contenteditable="true"]')
        return editor?.closest('.rounded-composer') ?? editor?.closest('fieldset')
      })() ??
        document.querySelector('fieldset div[contenteditable="true"]')?.closest('fieldset') ??
        document.querySelector('div[contenteditable="true"][role="textbox"]')?.closest('fieldset') ??
        document.querySelector('div.ProseMirror[contenteditable="true"]')?.parentElement ??
        null) as HTMLElement | null,

    // 明暗判定不赌 class 名：先看常见标记，再退回背景色亮度——任何改版都还成立
    isDark: () => {
      const root = document.documentElement
      if (root.classList.contains('dark')) return true
      if (root.getAttribute('data-mode') === 'dark') return true
      const rgb = /(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(getComputedStyle(document.body).backgroundColor)
      if (!rgb) return false
      const [r, g, b] = [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])]
      return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.5
    },

    themeAttributes: ['class', 'data-mode', 'data-theme'],

    // [待测] Claude 的主色变量名未确认。先试几个常见命名，命中不了就返回 null，
    // 交给界面层的通用兜底（扫描含 accent 的自定义属性，取最饱和的那个）。
    accent(parse: (raw: string) => Rgb | null) {
      const cs = getComputedStyle(document.documentElement)
      for (const name of ['--accent-main-000', '--accent-main-100', '--accent-brand', '--brand']) {
        const bg = parse(cs.getPropertyValue(name))
        if (bg) return { bg, fg: null, ring: null }
      }
      return null
    },
  },
}

function hasPresentFiles(conv: ClaudeConversation): boolean {
  return (conv.chat_messages ?? []).some((msg) =>
    (msg.content ?? []).some((block) => block.type === 'tool_use' && block.name === 'present_files'),
  )
}
