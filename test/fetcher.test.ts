import { describe, expect, test } from 'bun:test'
import { createFetcher, parseRetryAfterSeconds } from '../src/core/fetcher'

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
