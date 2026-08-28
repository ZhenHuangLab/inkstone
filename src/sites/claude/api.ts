// claude.ai 内部 API 客户端。节奏控制在 core/fetcher，这里只负责端点与字段。
//
// ⚠️ 限流画像未知。ChatGPT 侧的参数是 344 + 432 对话实测调出来的，Claude 侧
// 一条实测数据都没有，现有的开源 claude.ai 导出器也没有一个实现了退避
// （最激进的是 3 并发 + 固定 200ms 间隔，且不看 429）。所以这里的起步值刻意比
// ChatGPT 侧慢一倍，且每 40 个请求就歇一次：宁可慢，不可触发账号级限制。
//
// 调参依据只能来自实测——fetcher.stats() 会记下间距被推大的过程、429 次数与
// 服务端给出的最大 Retry-After，面板把它显示出来。等有了真实数据再谈放宽。

import {
  ApiError,
  createFetcher,
  ensureAlive,
  fetchBinary as fetchBinaryWith,
  sleep,
  type CancelToken,
  type Fetcher,
  type ThrottleConfig,
} from '../../core/fetcher'
import type { ClaudeConversation, ClaudeConversationListItem, ClaudeOrganization } from './types'

export const CLAUDE_THROTTLE: ThrottleConfig = {
  spacingBaseMs: 1500,
  spacingMaxMs: 8000,
  restEveryN: 40,
  restDurationMs: 30_000,
  maxAttempts: 6,
}

const fetcher: Fetcher = createFetcher(CLAUDE_THROTTLE)

/** 当前节奏快照（面板用来显示限流观测）。 */
export const throttleStats = (): ReturnType<Fetcher['stats']> => fetcher.stats()

const api = (path: string): string => `${location.origin}${path}`

/**
 * 拿组织 id。优先问接口——cookie 里的 lastActiveOrg 在多组织账号下会随最近活跃
 * 组织变化，而接口给的是真实归属；接口不可用时才回退 cookie。
 */
export async function resolveOrgId(cancel?: CancelToken): Promise<string> {
  try {
    const res = await fetcher.request(api('/api/organizations'), {}, cancel)
    const data: unknown = await res.json()
    const list = Array.isArray(data)
      ? (data as ClaudeOrganization[])
      : ((data as { organizations?: ClaudeOrganization[] })?.organizations ?? [])
    const uuid = list.find((o) => typeof o?.uuid === 'string')?.uuid
    if (uuid) return uuid
  } catch {
    /* 落到 cookie 兜底 */
  }
  const fromCookie = /(?:^|;\s*)lastActiveOrg=([^;]+)/.exec(document.cookie)?.[1]
  if (fromCookie) return decodeURIComponent(fromCookie)
  throw new Error('拿不到组织 id：请确认已登录 claude.ai 后重试')
}

/** 从地址栏取当前对话 id；不在对话页时返回 null。 */
export function currentConversationId(): string | null {
  const m = /\/chat\/([0-9a-f-]{20,})/i.exec(location.pathname)
  return m ? m[1]! : null
}

export async function fetchConversation(
  orgId: string,
  id: string,
  cancel?: CancelToken,
): Promise<ClaudeConversation> {
  // tree=True 拿完整消息树（分支靠 parent 链自己走），render_all_tools 保证
  // artifact / 文件 / widget 的 tool_use 载荷不被服务端裁掉
  const url = api(
    `/api/organizations/${orgId}/chat_conversations/${id}` +
      `?tree=True&rendering_mode=messages&render_all_tools=true`,
  )
  const res = await fetcher.request(url, { headers: { Accept: 'application/json' } }, cancel)
  return (await res.json()) as ClaudeConversation
}

// ——— 以下是批量导出的地基，当前版本的 UI 不暴露 ———
// 单对话导出只需要上面两个端点。列表接口先按分页写好（形状与 ChatGPT 侧一致，
// 便于后续复用同一套编排），但在限流画像实测清楚之前不接进界面。

export async function listConversationsPage(
  orgId: string,
  offset: number,
  limit: number,
  cancel?: CancelToken,
): Promise<ClaudeConversationListItem[]> {
  const url = api(`/api/organizations/${orgId}/chat_conversations?limit=${limit}&offset=${offset}`)
  const res = await fetcher.request(url, { headers: { Accept: 'application/json' } }, cancel)
  const data: unknown = await res.json()
  // [待测] 分页参数是否被服务端认。若不认，这里会一次性拿回全部——调用方靠
  // 「返回数 < limit」判断到底会误判，所以终止条件同样只认空页。
  return Array.isArray(data) ? (data as ClaudeConversationListItem[]) : []
}

export interface ConversationPager {
  next(): Promise<{ items: ClaudeConversationListItem[]; done: boolean }>
}

export type FetchPage = (
  orgId: string,
  offset: number,
  limit: number,
  cancel?: CancelToken,
) => Promise<ClaudeConversationListItem[]>

export interface PagerOptions {
  /** 翻页请求的实现；默认打真实接口，测试可注入假页 */
  fetchPage?: FetchPage
  /** 空页重试的等待基数（第 n 次等 n 倍）；设 0 即不等待 */
  emptyRetryBaseMs?: number
}

export function createConversationPager(
  orgId: string,
  cancel?: CancelToken,
  opts: PagerOptions = {},
): ConversationPager {
  const fetchPage = opts.fetchPage ?? listConversationsPage
  const emptyRetryBaseMs = opts.emptyRetryBaseMs ?? 4000
  let offset = 0
  let limit = 50
  let emptyRetries = 0
  let done = false
  const seen = new Set<string>()

  return {
    async next() {
      if (done) return { items: [], done: true }
      for (;;) {
        ensureAlive(cancel)
        let items: ClaudeConversationListItem[]
        try {
          items = await fetchPage(orgId, offset, limit, cancel)
        } catch (e) {
          if (e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 429 && limit > 20) {
            limit = 20
            continue
          }
          throw e
        }

        // 真空页：可能只是服务端瞬时抖动（ChatGPT 侧实测过列表索引会短暂降级），
        // 隔几秒重试确认，连续空 3 次才认到底
        if (items.length === 0) {
          if (offset === 0 || emptyRetries >= 2) {
            done = true
            return { items: [], done: true }
          }
          emptyRetries++
          if (emptyRetryBaseMs > 0) await sleep(emptyRetryBaseMs * emptyRetries)
          continue
        }

        // 有返回、但全是见过的：要么服务端忽略了分页参数每次给同一批，要么已到底。
        // 两种都不该重试——再问一次只会拿到同样的东西。
        const fresh = items.filter((i) => typeof i?.uuid === 'string' && !seen.has(i.uuid))
        if (fresh.length === 0) {
          done = true
          return { items: [], done: true }
        }
        for (const i of fresh) seen.add(i.uuid)

        emptyRetries = 0
        offset += items.length
        return { items: fresh, done: false }
      }
    },
  }
}

/** Claude 的附件地址是同源相对路径，登录态直接可取，不需要先换签名 URL。 */
export function fetchBinary(
  url: string,
  cancel?: CancelToken,
  maxBytes?: number,
): Promise<{ bytes: Uint8Array; contentType: string | null }> {
  return fetchBinaryWith(fetcher, absolute(url), cancel, maxBytes)
}

function absolute(url: string): string {
  try {
    return new URL(url, location.origin).href
  } catch {
    return url
  }
}
