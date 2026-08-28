// 站点无关的取数内核：限速、退避、并发池、取消。
//
// 这一层是本项目最贵的资产——ChatGPT 侧 344 + 432 对话实测踩出来的教训
// （见 PLAN.md 实战经验）。换站点时端点会变、字段会变，但下面这套节奏控制
// 的形状不变，所以它值得站点无关：
//   1) 所有请求共享起跑间距，宁慢勿快
//   2) 一旦吃到 429，间距自适应放大且本次运行内不回落
//   3) 带 Retry-After 的 429 = 真全局信号，共享冷却
//      不带 Retry-After 的 429 = 条目级问题，快速放弃（别拖停整条流水线）
//      跨 URL 连续多次 429 = 无头全局限流的兜底，短冷却
//
// 每个站点持有自己的 Fetcher 实例：节奏参数互不干扰，一边的限流不拖累另一边。

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

export class SizeLimitError extends Error {
  constructor(readonly actualBytes: number) {
    super(`附件大小 ${actualBytes} 字节超出上限`)
    this.name = 'SizeLimitError'
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

export interface ThrottleConfig {
  /** 请求之间的起跑间距 */
  spacingBaseMs: number
  /** 吃 429 后间距放大的上限 */
  spacingMaxMs: number
  /** 每这么多个请求整体歇一次（贴合突发桶回填节奏）；0 表示不歇 */
  restEveryN: number
  restDurationMs: number
  /** 单个请求的最大重试次数 */
  maxAttempts: number
}

/**
 * 观测快照：小规模试探时，节奏是否被服务端推着变慢，全看这里。
 * 未知站点的限流画像只能实测得来，所以先让它可见，再谈调参。
 */
export interface FetchStats {
  /** 当前起跑间距（会被 429 推大） */
  spacingMs: number
  requests: number
  /** 命中 429 的次数 */
  hits429: number
  /** 服务端明确给出 Retry-After 的次数（真全局限流信号） */
  retryAfterHits: number
  /** 还需冷却多久 */
  cooldownMs: number
  /** 观察到的最大 Retry-After 秒数 */
  maxRetryAfterSec: number
}

export interface Fetcher {
  request(url: string, init?: RequestInit, cancel?: CancelToken): Promise<Response>
  stats(): FetchStats
}

export function createFetcher(cfg: ThrottleConfig): Fetcher {
  let spacingMs = cfg.spacingBaseMs
  let requestsSinceRest = 0
  let nextSlotAt = 0
  let cooldownUntil = 0
  // 跨 URL 连续 429 计数：区分「全局限流」和「条目级 429」的关键信号
  let global429Streak = 0
  let requests = 0
  let hits429 = 0
  let retryAfterHits = 0
  let maxRetryAfterSec = 0

  /** 429 后调用：全局节奏永久放慢（本次运行内不回落）。 */
  const slowDown = (): void => {
    spacingMs = Math.min(spacingMs * 1.5, cfg.spacingMaxMs)
  }

  const acquireSlot = async (cancel?: CancelToken): Promise<void> => {
    for (;;) {
      ensureAlive(cancel)
      const now = Date.now()
      const target = Math.max(nextSlotAt, cooldownUntil)
      if (now >= target) {
        nextSlotAt = now + jitter(spacingMs, spacingMs * 0.4)
        if (cfg.restEveryN > 0 && ++requestsSinceRest >= cfg.restEveryN) {
          requestsSinceRest = 0
          cooldownUntil = Math.max(cooldownUntil, now + cfg.restDurationMs)
        }
        return
      }
      await sleep(Math.min(target - now, 500))
    }
  }

  // 429/5xx 指数退避重试；页内同源 fetch 自带登录 cookie。
  // 实测教训：部分对话会**永久性 429/404**（条目级问题，同一时刻其他请求全 200），
  // 把它们当全局限流会拖停整条流水线。
  const request = async (
    url: string,
    init: RequestInit = {},
    cancel?: CancelToken,
  ): Promise<Response> => {
    let delay = 2000
    let headerless429s = 0
    for (let attempt = 0; ; attempt++) {
      await acquireSlot(cancel)
      requests++
      const res = await fetch(url, { credentials: 'include', ...init })
      if (res.ok) {
        global429Streak = 0
        return res
      }
      const retryable = res.status === 429 || res.status >= 500
      if (!retryable || attempt >= cfg.maxAttempts) {
        throw new ApiError(res.status, `HTTP ${res.status}: ${url}`)
      }
      if (res.status === 429) {
        hits429++
        global429Streak++
        slowDown()
        const retryAfterSec = Number(res.headers.get('retry-after'))
        const retryAfterMs = retryAfterSec * 1000
        if (retryAfterMs > 0) {
          retryAfterHits++
          maxRetryAfterSec = Math.max(maxRetryAfterSec, retryAfterSec)
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

  return {
    request,
    stats: () => ({
      spacingMs: Math.round(spacingMs),
      requests,
      hits429,
      retryAfterHits,
      cooldownMs: Math.max(0, cooldownUntil - Date.now()),
      maxRetryAfterSec,
    }),
  }
}

/** 附件元数据里的 size 不可靠（ChatGPT library 文件报 0），上限以实际传输为准。 */
export async function fetchBinary(
  fetcher: Fetcher,
  url: string,
  cancel?: CancelToken,
  maxBytes?: number,
): Promise<{ bytes: Uint8Array; contentType: string | null }> {
  const res = await fetcher.request(url, {}, cancel)
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
