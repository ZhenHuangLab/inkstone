import type { AssetRef } from '../../core/ir'
import type { CancelToken } from '../../core/fetcher'
import type { AssetPayload, Rgb, SiteAdapter } from '../types'
import {
  currentConversationId,
  fetchBinary,
  fetchConversation,
  resolveOrgId,
  throttleStats,
} from './api'
import { conversationToIR } from './convert'
import type { ClaudeConversation } from './types'

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

  toIR: (raw, fallbackId) => conversationToIR(raw as ClaudeConversation, fallbackId),

  async fetchAsset(
    _session: string,
    ref: AssetRef,
    cancel?: CancelToken,
    maxBytes?: number,
  ): Promise<AssetPayload> {
    // Claude 的附件地址就在消息里，同源、登录态直接可取，不需要先换签名 URL
    if (!ref.url) throw new Error(`附件 ${ref.name ?? ref.fileId} 没有可下载地址`)
    const { bytes, contentType } = await fetchBinary(ref.url, cancel, maxBytes)
    return { bytes, filename: null, contentType }
  },

  throttleStats,

  ui: {
    // [待测] 以下选择器需要在真实页面上确认。找不到锚点时 FAB 不显示（既有防御），
    // 所以候选写宽是安全的：宁可多试几个，也不要挂在会被本地化的 aria-label 文案上。
    headerAnchor: () =>
      (document.querySelector('[data-testid="share-button"]') ??
        document.querySelector('[data-testid="chat-menu-trigger"]') ??
        document.querySelector('header button[aria-haspopup="menu"]')) as HTMLElement | null,

    composerAnchor: () =>
      (document.querySelector('fieldset div[contenteditable="true"]')?.closest('fieldset') ??
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
