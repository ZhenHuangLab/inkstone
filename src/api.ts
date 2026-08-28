// ChatGPT backend-api 客户端。节奏控制在 core/fetcher，这里只负责端点与字段。

import {
  ApiError,
  CancelledError,
  createFetcher,
  ensureAlive,
  fetchBinary as fetchBinaryWith,
  jitter,
  mapConcurrent,
  SizeLimitError,
  sleep,
  type CancelToken,
  type Fetcher,
  type ThrottleConfig,
} from './core/fetcher'
import type { ConversationDetail, ConversationListItem, ConversationListPage, SessionResponse } from './types'

export {
  ApiError,
  CancelledError,
  SizeLimitError,
  ensureAlive,
  jitter,
  mapConcurrent,
  sleep,
  type CancelToken,
}

// 后端是突发桶型限流，且持续高频抓取会触发账号级反滥用（实测：旧对话渐进式
// 变 429→404、列表截断，恢复要数小时）。所以宁慢勿快。
export const CHATGPT_THROTTLE: ThrottleConfig = {
  spacingBaseMs: 800,
  spacingMaxMs: 4000,
  // 喘息暂停：贴合突发桶回填节奏，每 ~80 个请求整体歇一段
  restEveryN: 80,
  restDurationMs: 25_000,
  maxAttempts: 7,
}

const fetcher: Fetcher = createFetcher(CHATGPT_THROTTLE)

/** 当前节奏快照（面板用来显示限流观测）。 */
export const throttleStats = (): ReturnType<Fetcher['stats']> => fetcher.stats()

export async function getAccessToken(cancel?: CancelToken): Promise<string> {
  const res = await fetcher.request(`${location.origin}/api/auth/session`, {}, cancel)
  const data = (await res.json()) as SessionResponse
  if (!data.accessToken) throw new Error('拿不到 accessToken：请确认已登录 ChatGPT 后重试')
  return data.accessToken
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` })

export async function listConversationsPage(
  token: string,
  offset: number,
  limit: number,
  cancel?: CancelToken,
): Promise<ConversationListPage> {
  const url = `${location.origin}/backend-api/conversations?offset=${offset}&limit=${limit}&order=updated`
  const res = await fetcher.request(url, { headers: auth(token) }, cancel)
  return (await res.json()) as ConversationListPage
}

export async function listAllConversations(
  token: string,
  onProgress?: (fetched: number) => void,
  cancel?: CancelToken,
): Promise<ConversationListItem[]> {
  const all: ConversationListItem[] = []
  let offset = 0
  let limit = 100
  let emptyRetries = 0
  // 注意：接口的 total 字段不可靠（实测翻页途中返回 offset+len+1），
  // 终止条件只认「空页」或「不足一页」。
  for (;;) {
    ensureAlive(cancel)
    let page: ConversationListPage
    try {
      page = await listConversationsPage(token, offset, limit, cancel)
    } catch (e) {
      // limit 上限历史上收紧过；非限流的 4xx 先降到 50 重试一次
      if (e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 429 && limit > 50) {
        limit = 50
        continue
      }
      throw e
    }
    const items = page.items ?? []
    all.push(...items)
    onProgress?.(all.length)
    // 服务端可能按自己的上限截页（返回数 < 请求 limit 不代表到底），只认空页；
    // 而且列表索引实测会瞬时降级、提前返回空页/短列表（对话本身还在），
    // 所以空页也不轻信，隔几秒重试确认，连续空 3 次才算到底。
    if (items.length === 0) {
      if (all.length === 0 || emptyRetries >= 2) break
      emptyRetries++
      await sleep(4000 * emptyRetries)
      continue
    }
    emptyRetries = 0
    offset += items.length
  }
  return all
}

export interface ConversationPager {
  /** 拉下一页；done=true 表示已确认到底（此后再调直接返回空页 + done） */
  next(): Promise<{ items: ConversationListItem[]; done: boolean }>
}

/**
 * 惰性分页器：把 listAllConversations 的翻页与防御逻辑逐页化，供「选择对话」
 * 的懒加载使用（切到「选择」不再一次性翻完全部页）。终止条件与全量版一致：
 * 只认空页，且空页要隔几秒重试确认，连续空 3 次才算到底。
 */
export function createConversationPager(token: string, cancel?: CancelToken): ConversationPager {
  let offset = 0
  let limit = 100
  let emptyRetries = 0
  let done = false
  return {
    async next() {
      if (done) return { items: [], done: true }
      for (;;) {
        ensureAlive(cancel)
        let page: ConversationListPage
        try {
          page = await listConversationsPage(token, offset, limit, cancel)
        } catch (e) {
          if (e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 429 && limit > 50) {
            limit = 50
            continue
          }
          throw e
        }
        const items = page.items ?? []
        if (items.length === 0) {
          // 首页即空 = 账号真没对话；否则可能是列表索引瞬时降级，隔几秒重试确认
          if (offset === 0 || emptyRetries >= 2) {
            done = true
            return { items: [], done: true }
          }
          emptyRetries++
          await sleep(4000 * emptyRetries)
          continue
        }
        emptyRetries = 0
        offset += items.length
        return { items, done: false }
      }
    },
  }
}

export async function fetchConversation(
  token: string,
  id: string,
  cancel?: CancelToken,
): Promise<ConversationDetail> {
  const res = await fetcher.request(
    `${location.origin}/backend-api/conversation/${id}`,
    { headers: auth(token) },
    cancel,
  )
  return (await res.json()) as ConversationDetail
}

export interface FileDownloadTarget {
  url: string
  filename: string | null
}

/** 换取附件的签名下载地址（对 sediment:// 图片与用户上传文件均有效，fn 参数带原始文件名）。 */
export async function resolveFileDownload(
  token: string,
  fileId: string,
  cancel?: CancelToken,
): Promise<FileDownloadTarget> {
  const res = await fetcher.request(
    `${location.origin}/backend-api/files/${fileId}/download`,
    { headers: auth(token) },
    cancel,
  )
  const data = (await res.json()) as { status?: string; download_url?: string }
  if (!data.download_url) throw new Error(`files/${fileId}/download 未返回 download_url`)
  let filename: string | null = null
  try {
    filename = new URL(data.download_url, location.origin).searchParams.get('fn')
  } catch {
    /* 签名地址解析失败不致命 */
  }
  return { url: data.download_url, filename }
}

export function fetchBinary(
  url: string,
  cancel?: CancelToken,
  maxBytes?: number,
): Promise<{ bytes: Uint8Array; contentType: string | null }> {
  return fetchBinaryWith(fetcher, url, cancel, maxBytes)
}
