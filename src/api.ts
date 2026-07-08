import type {
  ConversationDetail,
  ConversationListItem,
  ConversationListPage,
  SessionResponse,
} from './types'

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export class CancelledError extends Error {
  constructor() {
    super('已取消')
    this.name = 'CancelledError'
  }
}

export interface CancelToken {
  cancelled: boolean
}

export const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
export const jitter = (base: number, spread = base): number => base + Math.random() * spread

function ensureAlive(cancel?: CancelToken): void {
  if (cancel?.cancelled) throw new CancelledError()
}

// 429/5xx 指数退避重试；页内同源 fetch 自带登录 cookie
async function backoffFetch(url: string, init: RequestInit = {}, cancel?: CancelToken): Promise<Response> {
  let delay = 1000
  for (let attempt = 0; ; attempt++) {
    ensureAlive(cancel)
    const res = await fetch(url, { credentials: 'include', ...init })
    if (res.ok) return res
    const retryable = res.status === 429 || res.status >= 500
    if (!retryable || attempt >= 4) throw new ApiError(res.status, `HTTP ${res.status}: ${url}`)
    const retryAfter = Number(res.headers.get('retry-after')) * 1000
    await sleep(retryAfter > 0 ? retryAfter : jitter(delay))
    delay = Math.min(delay * 2, 30_000)
  }
}

export async function getAccessToken(cancel?: CancelToken): Promise<string> {
  const res = await backoffFetch(`${location.origin}/api/auth/session`, {}, cancel)
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
  const res = await backoffFetch(url, { headers: auth(token) }, cancel)
  return (await res.json()) as ConversationListPage
}

export async function listAllConversations(
  token: string,
  onProgress?: (fetched: number, total: number) => void,
  cancel?: CancelToken,
): Promise<ConversationListItem[]> {
  const all: ConversationListItem[] = []
  let offset = 0
  let limit = 100
  let total = Infinity
  while (offset < total) {
    ensureAlive(cancel)
    let page: ConversationListPage
    try {
      page = await listConversationsPage(token, offset, limit, cancel)
    } catch (e) {
      // limit 上限历史上收紧过；非限流的 4xx 先降到 50 重试一次
      if (e instanceof ApiError && e.status >= 400 && e.status < 500 && limit > 50) {
        limit = 50
        continue
      }
      throw e
    }
    const items = page.items ?? []
    all.push(...items)
    total = typeof page.total === 'number' ? page.total : all.length
    onProgress?.(all.length, total)
    if (items.length === 0) break
    offset += items.length
    await sleep(jitter(250))
  }
  return all
}

export async function fetchConversation(
  token: string,
  id: string,
  cancel?: CancelToken,
): Promise<ConversationDetail> {
  const res = await backoffFetch(`${location.origin}/backend-api/conversation/${id}`, { headers: auth(token) }, cancel)
  return (await res.json()) as ConversationDetail
}

// 简易并发池：fn 抛错即整体中止（逐条的容错由调用方在 fn 里自己 catch）
export async function mapConcurrent<T>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<void>,
  cancel?: CancelToken,
): Promise<void> {
  let next = 0
  let aborted: unknown = null
  const n = Math.max(1, Math.min(concurrency, items.length))
  const workers = Array.from({ length: n }, async () => {
    while (aborted == null && !cancel?.cancelled) {
      const i = next++
      if (i >= items.length) return
      try {
        await fn(items[i]!, i)
      } catch (e) {
        aborted = e
        return
      }
    }
  })
  await Promise.all(workers)
  if (aborted != null) throw aborted
  ensureAlive(cancel)
}
