import type { AssetRef } from '../../core/ir'
import type { CancelToken } from '../../core/fetcher'
import type { AssetPayload, Rgb, SiteAdapter, SiteConversationItem } from '../types'
import {
  createConversationPager,
  currentConversationId,
  fetchBinary,
  fetchConversation,
  listAllConversations,
  listSandboxFiles,
  resolveOrgId,
  throttleStats,
} from './api'
import { conversationToIR } from './convert'
import type { ClaudeConversation, ClaudeConversationListItem, ClaudeIRContext } from './types'

const toItem = (item: ClaudeConversationListItem): SiteConversationItem => ({
  id: item.uuid,
  title: item.name ?? '',
  update_time: item.updated_at ?? null,
})

export const claudeAdapter: SiteAdapter = {
  id: 'claude',
  label: 'Claude',
  supportsBatch: true,

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

  batch: {
    // Claude 限流画像仍未知：单并发、不做整批二次重试；一旦出现明确的全局
    // Retry-After 或累计 3 次 429，立刻保护性中止，未完成条目留给下次增量补齐。
    policy: {
      concurrency: 1,
      retryFailed: false,
      retryDelayMs: 0,
      failureAbortMin: 5,
      failureAbortRatio: 0.25,
      max429Hits: 3,
      maxRetryAfterHits: 1,
      maxRequests: 1000,
    },
    async listAll(session, onProgress, cancel) {
      return (await listAllConversations(session, onProgress, cancel)).map(toItem)
    },
    createPager(session, cancel) {
      const pager = createConversationPager(session, cancel)
      return {
        async next() {
          const { items, done } = await pager.next()
          return { items: items.map(toItem), done }
        },
      }
    },
  },

  ui: {
    // 2026-08-28 真实会话页实测：Files + Share 外层是 actions-group。锚定整个组的
    // 左边界才不会盖住 Files。2026-08-29 首页 /new 没有 wiggle 控件，但有稳定的
    // dframe-header-actions-slot（当前承载隐身模式按钮），同样锚定整组左边界。
    // 旧选择器继续留作回退，兼容 Claude 的灰度发布。
    headerAnchor: () =>
      (document.querySelector('[data-testid="wiggle-controls-actions-group"]') ??
        document.querySelector('[data-testid="wiggle-controls-actions"]') ??
        document.querySelector('[data-testid="wiggle-controls-actions-share"]') ??
        document.querySelector('#dframe-header-actions-slot') ??
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

    // 与 Claude 星形图标接近的品牌珊瑚橙。Claude 页面没有稳定公开的 accent 变量，
    // 固定色比扫描任意同名 CSS 变量更可预测；前景色仍交给通用层按对比度选择。
    accent(_parse: (raw: string) => Rgb | null) {
      const brandOrange: Rgb = [217, 119, 87] // #D97757
      return { bg: brandOrange, fg: null, ring: brandOrange }
    },
  },
}

function hasPresentFiles(conv: ClaudeConversation): boolean {
  return (conv.chat_messages ?? []).some((msg) =>
    (msg.content ?? []).some((block) => block.type === 'tool_use' && block.name === 'present_files'),
  )
}
