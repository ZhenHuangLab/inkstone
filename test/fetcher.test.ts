import { describe, expect, test } from 'bun:test'
import { createFetcher, parseRetryAfterSeconds, type CancelToken, type Fetcher } from '../src/core/fetcher'
import { createBatchSafetyGuard, type BatchPolicy } from '../src/core/batch-safety'

const batchPolicy: BatchPolicy = {
  concurrency: 1,
  retryFailed: false,
  retryDelayMs: 0,
  failureAbortMin: 5,
  failureAbortRatio: 0.25,
  maxRetryAfterHits: 1,
}

// 用虚拟时钟执行真实重试循环，检查是否进入了 60 秒冷却，而不实际等待。
async function withResponses(
  responses: Response[],
  run: (fetcher: Fetcher, waits: number[]) => Promise<void>,
): Promise<void> {
  const originalFetch = globalThis.fetch
  const originalNow = Date.now
  const originalTimeout = globalThis.setTimeout
  let now = Date.parse('2026-10-10T00:00:00Z')
  const waits: number[] = []
  Date.now = () => now
  globalThis.setTimeout = ((callback: () => void, ms = 0) => {
    waits.push(ms)
    now += ms
    queueMicrotask(callback)
    return 0
  }) as unknown as typeof setTimeout
  globalThis.fetch = (() => Promise.resolve(responses.shift() ?? new Response('OK'))) as unknown as typeof fetch
  try {
    await run(createFetcher({
      spacingBaseMs: 0,
      spacingMaxMs: 0,
      restEveryN: 0,
      restDurationMs: 0,
      maxAttempts: 1,
    }), waits)
  } finally {
    globalThis.fetch = originalFetch
    Date.now = originalNow
    globalThis.setTimeout = originalTimeout
  }
}

function batchToken(fetcher: Fetcher, policy = batchPolicy): CancelToken {
  return { cancelled: false, beforeRequest: createBatchSafetyGuard(policy, fetcher.stats) }
}

describe('Fetcher 限流统计', () => {
  test('Retry-After 同时支持秒数和 HTTP-date', () => {
    const now = Date.parse('2026-08-29T00:00:00Z')
    expect(parseRetryAfterSeconds('60', now)).toBe(60)
    expect(parseRetryAfterSeconds('Sat, 29 Aug 2026 00:01:00 GMT', now)).toBe(60)
  })

  test('重试耗尽的最后一次 429 也必须计入熔断统计', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response('', { status: 429, headers: { 'Retry-After': '60' } }),
      )) as unknown as typeof fetch
    try {
      const fetcher = createFetcher({
        spacingBaseMs: 0,
        spacingMaxMs: 0,
        restEveryN: 0,
        restDurationMs: 0,
        maxAttempts: 0,
      })
      await expect(fetcher.request('https://example.test/rate-limited')).rejects.toThrow('HTTP 429')
      expect(fetcher.stats()).toMatchObject({
        requests: 1,
        hits429: 1,
        retryAfterHits: 1,
        maxRetryAfterSec: 60,
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe('Fetcher 在内部重试前执行批次护栏', () => {
  for (const retryAfter of ['60', 'Sat, 10 Oct 2026 00:01:00 GMT']) {
    test(`首次 Retry-After (${retryAfter}) 立即中止，不等待也不重试`, async () => {
      await withResponses([
        new Response('', { status: 429, headers: { 'Retry-After': retryAfter } }),
      ], async (fetcher, waits) => {
        const cancel = batchToken(fetcher)
        await expect(fetcher.request('https://example.test/limited', {}, cancel)).rejects.toThrow('Retry-After')
        expect(fetcher.stats()).toMatchObject({ requests: 1, hits429: 1, retryAfterHits: 1, cooldownMs: 60_000 })
        expect(waits).toEqual([])
        // 同一批次后续请求也不能排进冷却队列或发出去。
        await expect(fetcher.request('https://example.test/next', {}, cancel)).rejects.toThrow('Retry-After')
        expect(fetcher.stats().requests).toBe(1)
        expect(waits).toEqual([])
      })
    })
  }

  test('503 耗尽请求预算时，在退避和内部重试前中止', async () => {
    await withResponses([new Response('', { status: 503 })], async (fetcher, waits) => {
      const cancel = batchToken(fetcher, { ...batchPolicy, maxRequests: 1 })
      await expect(fetcher.request('https://example.test/unavailable', {}, cancel)).rejects.toThrow('达到安全上限')
      expect(fetcher.stats().requests).toBe(1)
      expect(waits).toEqual([])
    })
  })

  test('其他站点的 429 次数上限同样在重试等待前执行', async () => {
    await withResponses([
      new Response('', { status: 429 }),
      new Response('', { status: 429, headers: { 'Retry-After': '60' } }),
    ], async (fetcher, waits) => {
      const cancel = batchToken(fetcher, { ...batchPolicy, maxRetryAfterHits: undefined, max429Hits: 2 })
      await expect(fetcher.request('https://example.test/limited', {}, cancel)).rejects.toThrow('2 次 HTTP 429')
      expect(fetcher.stats()).toMatchObject({ requests: 2, hits429: 2, retryAfterHits: 1 })
      expect(waits.reduce((total, ms) => total + ms, 0)).toBeLessThan(4000)
    })
  })

  test('没有批次护栏的单条请求仍可重试一次并遵守全局冷却', async () => {
    await withResponses([
      new Response('', { status: 429, headers: { 'Retry-After': '60' } }),
    ], async (fetcher, waits) => {
      const response = await fetcher.request('https://example.test/single', {}, { cancelled: false })
      expect(response.ok).toBe(true)
      expect(fetcher.stats().requests).toBe(2)
      expect(waits.reduce((total, ms) => total + ms, 0)).toBe(60_000)
    })
  })

  test('并发请求在取得时隙后仍核对预算，不能超过 HTTP 尝试上限', async () => {
    await withResponses([], async (fetcher) => {
      const cancel = batchToken(fetcher, { ...batchPolicy, maxRequests: 1 })
      const results = await Promise.allSettled([
        fetcher.request('https://example.test/a', {}, cancel),
        fetcher.request('https://example.test/b', {}, cancel),
      ])
      expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected'])
      expect(fetcher.stats().requests).toBe(1)
    })
  })

  test('新的批次使用新基线，不被上次熔断统计锁死；共享冷却仍保留', async () => {
    await withResponses([
      new Response('', { status: 429, headers: { 'Retry-After': '60' } }),
    ], async (fetcher, waits) => {
      await expect(fetcher.request('https://example.test/first', {}, batchToken(fetcher))).rejects.toThrow('Retry-After')
      expect(waits).toEqual([])
      const response = await fetcher.request('https://example.test/new-batch', {}, batchToken(fetcher))
      expect(response.ok).toBe(true)
      expect(fetcher.stats().requests).toBe(2)
      expect(waits.reduce((total, ms) => total + ms, 0)).toBe(60_000)
    })
  })
})
