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
import type {
  ClaudeConversation,
  ClaudeConversationListItem,
  ClaudeOrganization,
  ClaudeSandboxFile,
} from './types'

export const CLAUDE_THROTTLE: ThrottleConfig = {
  spacingBaseMs: 1500,
  spacingMaxMs: 8000,
  restEveryN: 40,
  restDurationMs: 30_000,
  // 首次失败后最多再试一次；批量层随后依据完整 429 统计决定是否熔断。
  maxAttempts: 1,
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
    ensureAlive(cancel)
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

/**
 * 会话沙箱清单：用户上传件与 Claude 生成的最终文件都在这里。
 * 注意端点是 conversations，不是主对话接口使用的 chat_conversations。
 */
export async function listSandboxFiles(
  orgId: string,
  conversationId: string,
  cancel?: CancelToken,
): Promise<ClaudeSandboxFile[]> {
  const listUrl = api(
    `/api/organizations/${orgId}/conversations/${conversationId}/wiggle/list-files?prefix=`,
  )
  const res = await fetcher.request(listUrl, { headers: { Accept: 'application/json' } }, cancel)
  const data: unknown = await res.json()
  if (!data || typeof data !== 'object' || !Array.isArray((data as { files_metadata?: unknown }).files_metadata)) {
    throw new Error('Claude 沙箱文件清单结构已变化')
  }
  const files = (data as { files_metadata: unknown[] }).files_metadata

  return files.flatMap((item): ClaudeSandboxFile[] => {
    if (!item || typeof item !== 'object') return []
    const raw = item as Record<string, unknown>
    if (typeof raw['path'] !== 'string' || raw['path'] === '') return []
    const path = raw['path']
    const downloadUrl = api(
      `/api/organizations/${orgId}/conversations/${conversationId}/wiggle/download-file` +
        `?path=${encodeURIComponent(path)}`,
    )
    return [{ ...(raw as Omit<ClaudeSandboxFile, 'download_url'>), path, download_url: downloadUrl }]
  })
}

// ——— 批量导出列表 —— 与 ChatGPT 共用编排，但使用 Claude 专属的保守节奏与熔断。———

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
  if (Array.isArray(data)) return data as ClaudeConversationListItem[]
  if (data && typeof data === 'object') {
    const nested = (data as { chat_conversations?: unknown }).chat_conversations
    if (Array.isArray(nested)) return nested as ClaudeConversationListItem[]
  }
  throw new Error('Claude 对话列表结构已变化：预期数组')
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
  /** 单个分页器最多发出的列表请求数，防接口忽略 offset 或结构漂移后空转。 */
  maxRequests?: number
  /** 单个分页器最多接收的去重对话数。 */
  maxItems?: number
}

export function createConversationPager(
  orgId: string,
  cancel?: CancelToken,
  opts: PagerOptions = {},
): ConversationPager {
  const fetchPage = opts.fetchPage ?? listConversationsPage
  const emptyRetryBaseMs = opts.emptyRetryBaseMs ?? 4000
  const maxRequests = opts.maxRequests ?? 250
  const maxItems = opts.maxItems ?? 10_000
  let offset = 0
  let limit = 50
  let emptyRetries = 0
  let done = false
  let requests = 0
  const seen = new Set<string>()

  return {
    async next() {
      if (done) return { items: [], done: true }
      for (;;) {
        ensureAlive(cancel)
        if (requests >= maxRequests) {
          throw new Error(`Claude 列表分页请求已达安全上限（${maxRequests} 次），已停止以防空转`)
        }
        requests++
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
        const valid = items.filter((i) => typeof i?.uuid === 'string' && i.uuid !== '')
        if (valid.length === 0) throw new Error('Claude 对话列表结构已变化：返回条目缺少 uuid')
        const fresh = valid.filter((i) => !seen.has(i.uuid))
        if (fresh.length === 0) {
          done = true
          return { items: [], done: true }
        }
        if (seen.size + fresh.length > maxItems) {
          throw new Error(`Claude 对话数已超过安全上限（${maxItems} 条），已停止本次列表拉取`)
        }
        for (const i of fresh) seen.add(i.uuid)

        emptyRetries = 0
        offset += items.length
        return { items: fresh, done: false }
      }
    },
  }
}

/** 全量列表与选择器共用同一套去重、空页确认和安全上限。 */
export async function listAllConversations(
  orgId: string,
  onProgress?: (fetched: number) => void,
  cancel?: CancelToken,
  opts: PagerOptions = {},
): Promise<ClaudeConversationListItem[]> {
  const pager = createConversationPager(orgId, cancel, opts)
  const all: ClaudeConversationListItem[] = []
  for (;;) {
    const { items, done } = await pager.next()
    all.push(...items)
    if (items.length > 0) onProgress?.(all.length)
    if (done) return all
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
