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
import type {
  ConversationDetail,
  ConversationListItem,
  ConversationListPage,
  GizmoConversationsPage,
  GizmoSidebarPage,
  ProjectInfo,
  SessionResponse,
} from './types'

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

// ===== Projects（gizmo）=====
// 主列表接口只返回侧栏「Chats」那份平铺列表，project 里的会话必须按 project
// 逐个走 gizmos 接口拿。两个坐标系完全不同：主列表是 offset，gizmos 是字符串游标。
const PROJECT_PAGE_LIMIT = 50

const projectNames = new Map<string, string>()

/** 已知的 project 名（需先 listProjects 拉过）；不在 project 侧栏里的 gizmo 返回 undefined。 */
export const projectNameOf = (gizmoId: string | null | undefined): string | undefined =>
  gizmoId ? projectNames.get(gizmoId) : undefined

// 面板来源下拉与归并分页器会几乎同时取列表；只合并正在进行的请求，避免长期缓存陈数据。
let projectsInFlight: Promise<ProjectInfo[]> | null = null

export function listProjects(token: string, cancel?: CancelToken): Promise<ProjectInfo[]> {
  projectsInFlight ??= fetchProjects(token, cancel).finally(() => {
    projectsInFlight = null
  })
  return projectsInFlight
}

async function fetchProjects(token: string, cancel?: CancelToken): Promise<ProjectInfo[]> {
  const out: ProjectInfo[] = []
  let cursor: number | null = null
  for (;;) {
    ensureAlive(cancel)
    const url =
      `${location.origin}/backend-api/gizmos/snorlax/sidebar?conversations_per_gizmo=0` +
      (cursor == null ? '' : `&cursor=${encodeURIComponent(String(cursor))}`)
    const res = await fetcher.request(url, { headers: auth(token) }, cancel)
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

async function listProjectConversationsPage(
  token: string,
  gizmoId: string,
  cursor: string,
  cancel?: CancelToken,
): Promise<GizmoConversationsPage> {
  const url =
    `${location.origin}/backend-api/gizmos/${encodeURIComponent(gizmoId)}/conversations` +
    `?cursor=${encodeURIComponent(cursor)}&limit=${PROJECT_PAGE_LIMIT}`
  const res = await fetcher.request(url, { headers: auth(token) }, cancel)
  return (await res.json()) as GizmoConversationsPage
}

export interface ConversationPager {
  /** 拉下一页；done=true 表示所有来源都到底（此后再调直接返回空页 + done） */
  next(): Promise<{ items: ConversationListItem[]; done: boolean }>
}

const SOURCE_ALL = 'all'
const SOURCE_MAIN = 'main'

function timeOf(i: ConversationListItem): number {
  const t = i.update_time ?? i.create_time
  if (typeof t === 'number') return t
  if (typeof t === 'string') {
    const ms = Date.parse(t)
    return Number.isNaN(ms) ? -Infinity : ms / 1000
  }
  return -Infinity
}

interface SourceStream {
  done: boolean
  peek(): ConversationListItem | undefined
  take(): ConversationListItem
  fill(): Promise<void>
}

function makeStream(nextPage: () => Promise<ConversationListItem[] | null>): SourceStream {
  const buf: ConversationListItem[] = []
  const stream: SourceStream = {
    done: false,
    peek: () => buf[0],
    take: () => buf.shift()!,
    async fill() {
      const page = await nextPage()
      if (page == null) stream.done = true
      else buf.push(...page)
    },
  }
  return stream
}

/** 主列表与各 project 的多源惰性分页器，按更新时间倒序归并并按 id 去重。 */
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
  let streams: SourceStream[] | null = null
  let done = false

  async function mainPage(): Promise<ConversationListItem[] | null> {
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

  function projectPages(gizmoId: string): () => Promise<ConversationListItem[] | null> {
    let cursor: string | null = '0'
    return async () => {
      if (cursor == null) return null
      ensureAlive(cancel)
      const page = await listProjectConversationsPage(token, gizmoId, cursor, cancel)
      cursor = page.cursor ?? null
      return (page.items ?? []).map((i) => ({ ...i, gizmo_id: i.gizmo_id ?? gizmoId }))
    }
  }

  async function buildStreams(): Promise<SourceStream[]> {
    if (onlyProject != null) return [makeStream(projectPages(onlyProject))]
    if (source === SOURCE_MAIN) return [makeStream(mainPage)]
    const projects = await listProjects(token, cancel)
    return [makeStream(mainPage), ...projects.map((p) => makeStream(projectPages(p.id)))]
  }

  return {
    async next() {
      if (done) return { items: [], done: true }
      streams ??= await buildStreams()
      for (;;) {
        for (const s of streams) {
          while (!s.done && s.peek() === undefined) await s.fill()
        }
        const out: ConversationListItem[] = []
        for (;;) {
          let best: SourceStream | undefined
          for (const s of streams) {
            const head = s.peek()
            if (head === undefined) continue
            if (best === undefined || timeOf(head) > timeOf(best.peek()!)) best = s
          }
          if (best === undefined) {
            done = true
            break
          }
          const item = best.take()
          if (!seen.has(item.id)) {
            seen.add(item.id)
            out.push(item)
          }
          if (best.peek() === undefined && !best.done) break
        }
        if (out.length > 0 || done) return { items: out, done }
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
