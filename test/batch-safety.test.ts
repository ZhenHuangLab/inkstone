import { describe, expect, test } from 'bun:test'
import {
  BatchSafetyError,
  createBatchSafetyGuard,
  failureLimitReached,
  type BatchPolicy,
} from '../src/core/batch-safety'
import type { FetchStats } from '../src/core/fetcher'

const policy: BatchPolicy = {
  concurrency: 1,
  retryFailed: false,
  retryDelayMs: 0,
  failureAbortMin: 5,
  failureAbortRatio: 0.25,
  max429Hits: 3,
  maxRetryAfterHits: 1,
  maxRequests: 1000,
}

const stats = (patch: Partial<FetchStats> = {}): FetchStats => ({
  spacingMs: 1500,
  requests: 0,
  hits429: 0,
  retryAfterHits: 0,
  cooldownMs: 0,
  maxRetryAfterSec: 0,
  ...patch,
})

describe('批量导出限流熔断', () => {
  test('只计算本批次新增的 429，不受此前统计污染', () => {
    let current = stats({ hits429: 7, retryAfterHits: 2 })
    const check = createBatchSafetyGuard(policy, () => current)
    expect(() => check()).not.toThrow()

    current = stats({ hits429: 9, retryAfterHits: 2 })
    expect(() => check()).not.toThrow()
  })

  test('无 Retry-After 的 429 累计达到 3 次就停止', () => {
    let current = stats()
    const check = createBatchSafetyGuard(policy, () => current)
    current = stats({ hits429: 3 })
    expect(() => check()).toThrow(BatchSafetyError)
    expect(() => check()).toThrow('本批次已遇到 3 次 HTTP 429')
  })

  test('一次带 Retry-After 的全局限流信号就停止', () => {
    let current = stats()
    const check = createBatchSafetyGuard(policy, () => current)
    current = stats({ hits429: 1, retryAfterHits: 1, maxRetryAfterSec: 60 })
    expect(() => check()).toThrow('Retry-After')
  })

  test('总请求数包含内部重试，达到批次上限就停止', () => {
    let current = stats({ requests: 40 })
    const check = createBatchSafetyGuard({ ...policy, maxRequests: 3 }, () => current)
    current = stats({ requests: 43 })
    expect(() => check()).toThrow('达到安全上限')
  })
})

describe('批量导出失败率护栏', () => {
  test('未达到最小失败数时不误杀小样本', () => {
    expect(failureLimitReached(policy, 4, 4)).toBe(false)
  })

  test('同时达到最小失败数并超过失败率才停止', () => {
    expect(failureLimitReached(policy, 5, 20)).toBe(false)
    expect(failureLimitReached(policy, 6, 20)).toBe(true)
  })
})
