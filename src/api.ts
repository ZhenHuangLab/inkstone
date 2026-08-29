import type {
  ConversationDetail,
  ConversationListItem,
  ConversationListPage,
  GizmoConversationsPage,
  GizmoSidebarPage,
  ProjectInfo,
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

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
export const jitter = (base: number, spread = base): number => base + Math.random() * spread

export function ensureAlive(cancel?: CancelToken): void {
  if (cancel?.cancelled) throw new CancelledError()
}

// ===== 全局限速 =====
// 后端是突发桶型限流，且持续高频抓取会触发账号级反滥用（实测：旧对话渐进式
// 变 429→404、列表截断，恢复要数小时）。所以宁慢勿快：
// 1) 所有请求共享起跑间距；2) 一旦吃到 429，间距自适应放大且不回落；
// 3) 任何全局性 429 让全部 worker 共享冷却。
const REQUEST_SPACING_BASE_MS = 800
const REQUEST_SPACING_MAX_MS = 4000
// 喘息暂停：贴合突发桶回填节奏，每 ~80 个请求整体歇一段
const REST_EVERY_N_REQUESTS = 80
const REST_DURATION_MS = 25_000
let requestSpacingMs = REQUEST_SPACING_BASE_MS
let requestsSinceRest = 0
let nextSlotAt = 0
let cooldownUntil = 0

/** 429 后调用：全局节奏永久放慢（本次运行内不回落）。 */
function slowDown(): void {
  requestSpacingMs = Math.min(requestSpacingMs * 1.5, REQUEST_SPACING_MAX_MS)
}

async function acquireSlot(cancel?: CancelToken): Promise<void> {
  for (;;) {
    ensureAlive(cancel)
    const now = Date.now()
    const target = Math.max(nextSlotAt, cooldownUntil)
    if (now >= target) {
      nextSlotAt = now + jitter(requestSpacingMs, requestSpacingMs * 0.4)
      if (++requestsSinceRest >= REST_EVERY_N_REQUESTS) {
        requestsSinceRest = 0
        cooldownUntil = Math.max(cooldownUntil, now + REST_DURATION_MS)
      }
      return
    }
    await sleep(Math.min(target - now, 500))
  }
}

// 跨 URL 连续 429 计数：区分「全局限流」和「条目级 429」的关键信号
let global429Streak = 0

// 429/5xx 指数退避重试；页内同源 fetch 自带登录 cookie。
// 实测教训：部分对话会**永久性 429/404**（条目级问题，同一时刻其他请求全 200），
// 把它们当全局限流会拖停整条流水线——所以：
//  - 带 Retry-After 的 429 → 真全局信号，共享冷却
//  - 不带 Retry-After 的 429 → 条目级，快速放弃（结尾重试环节还有一次机会）
//  - 跨 URL 连续多次 429 → 无头全局限流的兜底，短冷却
async function backoffFetch(url: string, init: RequestInit = {}, cancel?: CancelToken): Promise<Response> {
  let delay = 2000
  let headerless429s = 0
  for (let attempt = 0; ; attempt++) {
    await acquireSlot(cancel)
    const res = await fetch(url, { credentials: 'include', ...init })
    if (res.ok) {
      global429Streak = 0
      return res
    }
    const retryable = res.status === 429 || res.status >= 500
    if (!retryable || attempt >= 7) throw new ApiError(res.status, `HTTP ${res.status}: ${url}`)
    if (res.status === 429) {
      global429Streak++
      slowDown()
      const retryAfterMs = Number(res.headers.get('retry-after')) * 1000
      if (retryAfterMs > 0) {
        cooldownUntil = Math.max(cooldownUntil, Date.now() + retryAfterMs)
      } else if (global429Streak >= 5) {
        cooldownUntil = Math.max(cooldownUntil, Date.now() + 15_000)
      } else {
        headerless429s++
        if (headerless429s > 1) throw new ApiError(429, `HTTP 429（条目级，快速放弃）: ${url}`)
        await sleep(jitter(delay))
      }
    } else {
      await sleep(jitter(delay))
    }
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

// ===== Projects（gizmo）=====
// 主列表接口只返回侧栏「Chats」那份平铺列表，project 里的会话必须按 project
// 逐个走 gizmos 接口拿。两个坐标系完全不同：主列表是 offset，gizmos 是字符串游标。
const PROJECT_PAGE_LIMIT = 50 // gizmos 接口的 limit 上限比主列表小

// gizmo_id → project 名：对话详情只带 gizmo_id，名字要靠 sidebar 接口换；
// listProjects 每拉一次就往这里补，读的一方不用关心何时拉的
const projectNames = new Map<string, string>()

/** 已知的 project 名（需先 listProjects 拉过）；不在 project 侧栏里的 gizmo 返回 undefined。 */
export const projectNameOf = (gizmoId: string | null | undefined): string | undefined =>
  gizmoId ? projectNames.get(gizmoId) : undefined

/** 拉全部 project（顺带填好 gizmo_id → 名字的映射）。 */
export async function listProjects(token: string, cancel?: CancelToken): Promise<ProjectInfo[]> {
  const out: ProjectInfo[] = []
  let cursor: number | null = null
  for (;;) {
    ensureAlive(cancel)
    // conversations_per_gizmo=0：只要 project 本身，别顺带回一堆用不上的会话
    const url =
      `${location.origin}/backend-api/gizmos/snorlax/sidebar?conversations_per_gizmo=0` +
      (cursor == null ? '' : `&cursor=${encodeURIComponent(String(cursor))}`)
    const res = await backoffFetch(url, { headers: auth(token) }, cancel)
    const page = (await res.json()) as GizmoSidebarPage
    for (const entry of page.items ?? []) {
      const g = entry.gizmo?.gizmo
      if (!g?.id) continue
      const name = (g.display?.name ?? '').trim() || '未命名项目'
      projectNames.set(g.id, name)
      out.push({ id: g.id, name })
    }
    cursor = page.cursor ?? null
    if (cursor == null) return out
  }
}

export async function listProjectConversationsPage(
  token: string,
  gizmoId: string,
  cursor: string,
  cancel?: CancelToken,
): Promise<GizmoConversationsPage> {
  const url =
    `${location.origin}/backend-api/gizmos/${encodeURIComponent(gizmoId)}/conversations` +
    `?cursor=${encodeURIComponent(cursor)}&limit=${PROJECT_PAGE_LIMIT}`
  const res = await backoffFetch(url, { headers: auth(token) }, cancel)
  return (await res.json()) as GizmoConversationsPage
}

export interface ConversationPager {
  /** 拉下一页；done=true 表示所有来源都到底（此后再调直接返回空页 + done） */
  next(): Promise<{ items: ConversationListItem[]; done: boolean }>
}

/** 分页来源：`all` 全部 / `main` 仅主列表 / 其余按 gizmo id 视为单个 project。 */
export const SOURCE_ALL = 'all'
export const SOURCE_MAIN = 'main'

/**
 * 多源惰性分页器：先翻主列表（offset），翻完再逐个 project 翻（字符串游标）。
 * source 可把范围收窄到单一来源（面板上的「来源」下拉）；指定单个 project 时
 * 连 project 列表都不用拉，直接翻它自己的会话。
 * 跨源按 id 去重（主列表哪天开始包含 project 会话也不会重复导出）。
 * 主列表的终止条件只认空页（服务端会按自己的上限截页，短页不代表到底），且
 * 列表索引实测会瞬时降级提前返回空页，所以空页要隔几秒重试，连续空 3 次才算到底。
 */
export function createConversationPager(
  token: string,
  cancel?: CancelToken,
  source: string = SOURCE_ALL,
): ConversationPager {
  const onlyProject = source === SOURCE_ALL || source === SOURCE_MAIN ? null : source
  const seen = new Set<string>()
  let offset = 0
  let limit = 100
  let emptyRetries = 0
  // 选单个 project 时直接跳过主列表；选主列表时 projectIds 置空跳过 project 阶段
  let mainDone = onlyProject != null
  let projectIds: string[] | null = source === SOURCE_MAIN ? [] : null
  if (onlyProject != null) projectIds = [onlyProject]
  let projectIdx = 0
  let cursor = '0'
  let done = false

  /** 主列表一页；null = 主列表到底 */
  async function mainPage(): Promise<ConversationListItem[] | null> {
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
      if (items.length === 0) {
        // 首页即空 = 账号真没对话；否则可能是列表索引瞬时降级，隔几秒重试确认
        if (offset === 0 || emptyRetries >= 2) return null
        emptyRetries++
        await sleep(4000 * emptyRetries)
        continue
      }
      emptyRetries = 0
      offset += items.length
      return items
    }
  }

  /** 当前 project 的一页；null = 该 project 已翻完且本页无内容 */
  async function projectPage(gizmoId: string): Promise<ConversationListItem[] | null> {
    ensureAlive(cancel)
    const page = await listProjectConversationsPage(token, gizmoId, cursor, cancel)
    // gizmos 接口的条目不保证带 gizmo_id，补上才能在下游认出归属
    const items = (page.items ?? []).map((i) => ({ ...i, gizmo_id: i.gizmo_id ?? gizmoId }))
    const nextCursor = page.cursor ?? null
    if (nextCursor == null) {
      projectIdx++
      cursor = '0'
      return items.length > 0 ? items : null
    }
    cursor = nextCursor
    return items
  }

  return {
    async next() {
      if (done) return { items: [], done: true }
      for (;;) {
        let batch: ConversationListItem[] | null
        if (!mainDone) {
          batch = await mainPage()
          if (batch == null) mainDone = true
        } else {
          projectIds ??= (await listProjects(token, cancel)).map((p) => p.id)
          const gizmoId = projectIds[projectIdx]
          if (gizmoId == null) {
            done = true
            return { items: [], done: true }
          }
          batch = await projectPage(gizmoId)
        }
        if (batch == null) continue
        // offset 翻页 + order=updated 期间列表会漂移，加上跨源重叠，统一在这里去重；
        // 整页都是重复时继续翻，不把空页交给调用方（会被当成到底）
        const fresh = batch.filter((i) => !seen.has(i.id))
        for (const i of fresh) seen.add(i.id)
        if (fresh.length > 0) return { items: fresh, done: false }
      }
    },
  }
}

export async function listAllConversations(
  token: string,
  onProgress?: (fetched: number) => void,
  cancel?: CancelToken,
): Promise<ConversationListItem[]> {
  const pager = createConversationPager(token, cancel)
  const all: ConversationListItem[] = []
  for (;;) {
    const { items, done } = await pager.next()
    all.push(...items)
    if (items.length > 0) onProgress?.(all.length)
    if (done) return all
  }
}

export async function fetchConversation(
  token: string,
  id: string,
  cancel?: CancelToken,
): Promise<ConversationDetail> {
  const res = await backoffFetch(
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
  const res = await backoffFetch(
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

export class SizeLimitError extends Error {
  constructor(readonly actualBytes: number) {
    super(`附件大小 ${actualBytes} 字节超出上限`)
    this.name = 'SizeLimitError'
  }
}

/** 附件元数据里的 size 不可靠（library 文件报 0），上限以实际传输为准。 */
export async function fetchBinary(
  url: string,
  cancel?: CancelToken,
  maxBytes?: number,
): Promise<{ bytes: Uint8Array; contentType: string | null }> {
  const res = await backoffFetch(url, {}, cancel)
  const declared = Number(res.headers.get('content-length'))
  if (maxBytes != null && declared > maxBytes) {
    try {
      await res.body?.cancel()
    } catch {
      /* 取消流失败无所谓 */
    }
    throw new SizeLimitError(declared)
  }
  const bytes = new Uint8Array(await res.arrayBuffer())
  if (maxBytes != null && bytes.length > maxBytes) throw new SizeLimitError(bytes.length)
  return { bytes, contentType: res.headers.get('content-type') }
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
  const worker = async (): Promise<void> => {
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
  }
  await Promise.all(Array.from({ length: n }, () => worker()))
  if (aborted != null) throw aborted
  ensureAlive(cancel)
}
