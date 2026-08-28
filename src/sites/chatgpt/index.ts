import {
  createConversationPager,
  fetchBinary,
  fetchConversation,
  getAccessToken,
  listAllConversations,
  resolveFileDownload,
  throttleStats,
} from '../../api'
import type { AssetRef } from '../../core/ir'
import type { CancelToken } from '../../core/fetcher'
import type { ConversationDetail, ConversationListItem } from '../../types'
import type { AssetPayload, SiteAdapter, SiteConversationItem } from '../types'
import { conversationToIR } from './convert'

const toItem = (i: ConversationListItem): SiteConversationItem => ({
  id: i.id,
  title: i.title ?? '',
  update_time: i.update_time ?? null,
})

export const chatgptAdapter: SiteAdapter = {
  id: 'chatgpt',
  label: 'ChatGPT',
  supportsBatch: true,

  matches: () => /(^|\.)chatgpt\.com$|(^|\.)chat\.openai\.com$/.test(location.hostname),

  currentConversationId() {
    const m = /\/c\/([0-9a-f][0-9a-f-]{10,})/i.exec(location.pathname)
    return m ? m[1]! : null
  },

  prepare: (cancel) => getAccessToken(cancel),

  fetchRaw: (session, id, cancel) => fetchConversation(session, id, cancel),

  toIR: (raw, fallbackId) => conversationToIR(raw as ConversationDetail, fallbackId),

  async fetchAsset(
    session: string,
    ref: AssetRef,
    cancel?: CancelToken,
    maxBytes?: number,
  ): Promise<AssetPayload> {
    // ChatGPT 的附件要先用 file id 换一个签名下载地址（fn 参数带原始文件名）
    const target = await resolveFileDownload(session, ref.fileId, cancel)
    const { bytes, contentType } = await fetchBinary(target.url, cancel, maxBytes)
    return { bytes, filename: target.filename, contentType }
  },

  throttleStats,

  batch: {
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
    headerAnchor: () =>
      (document.querySelector('[data-testid="share-chat-button"]') ??
        document.querySelector('#conversation-header-actions')) as HTMLElement | null,

    composerAnchor: () =>
      (document.querySelector('#prompt-textarea')?.closest('form') ??
        document.querySelector('form[data-type="unified-composer"]')) as HTMLElement | null,

    isDark: () => document.documentElement.classList.contains('dark'),

    themeAttributes: ['class', 'data-chat-theme'],

    // ChatGPT 的 accent 方案（2026-07 实测）：html[data-chat-theme="purple"] +
    // 每主题一族变量 --{theme}-theme-submit-btn-bg/-text 与 --{theme}-theme-entity-accent。
    // 直接读当前主题的发送键配色作主色；变量消失（改版）时返回 null，交给通用兜底。
    accent(parse) {
      const rootEl = document.documentElement
      const cs = getComputedStyle(rootEl)
      const theme = rootEl.getAttribute('data-chat-theme') || 'default'
      const bg = parse(cs.getPropertyValue(`--${theme}-theme-submit-btn-bg`))
      if (!bg) return null
      return {
        bg,
        fg: parse(cs.getPropertyValue(`--${theme}-theme-submit-btn-text`)),
        ring: parse(cs.getPropertyValue(`--${theme}-theme-entity-accent`)),
      }
    },
  },
}
