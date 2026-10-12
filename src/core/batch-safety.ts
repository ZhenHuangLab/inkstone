import type { FetchStats } from './fetcher'

/** 站点级批量策略：显式写出并发、失败处理与限流熔断，避免未知站点沿用激进默认值。 */
export interface BatchPolicy {
  concurrency: number
  retryFailed: boolean
  retryDelayMs: number
  failureAbortMin: number
  failureAbortRatio: number
  /** 本批次新增 429 达到此数即中止；缺省表示不额外熔断。 */
  max429Hits?: number
  /** 带 Retry-After 的 429 是全局限流信号，达到此数即中止。 */
  maxRetryAfterHits?: number
  /** 本批次所有 HTTP 尝试的总上限（含内部重试与附件请求）。 */
  maxRequests?: number
}

export class BatchSafetyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BatchSafetyError'
  }
}

/**
 * Fetcher 统计是页面生命周期累计值；熔断只看当前批次相对创建时的增量，
 * 不能让用户此前一次单对话请求留下的 429 永久锁死后续批量导出。
 */
export function createBatchSafetyGuard(
  policy: BatchPolicy,
  getStats: () => FetchStats,
): () => void {
  const baseline = getStats()
  return () => {
    const current = getStats()
    const requests = Math.max(0, current.requests - baseline.requests)
    if (policy.maxRequests != null && requests >= policy.maxRequests) {
      throw new BatchSafetyError(`本批次已发出 ${requests} 次 HTTP 请求，达到安全上限并停止`)
    }

    const retryAfterHits = Math.max(0, current.retryAfterHits - baseline.retryAfterHits)
    if (policy.maxRetryAfterHits != null && retryAfterHits >= policy.maxRetryAfterHits) {
      throw new BatchSafetyError(
        `服务端已返回 Retry-After 全局限流信号，本批次安全中止（最长等待 ${current.maxRetryAfterSec}s）`,
      )
    }

    const hits429 = Math.max(0, current.hits429 - baseline.hits429)
    if (policy.max429Hits != null && hits429 >= policy.max429Hits) {
      throw new BatchSafetyError(`本批次已遇到 ${hits429} 次 HTTP 429，为保护账号安全停止后续请求`)
    }
  }
}

/** 小样本偶发失败不误杀；达到最小失败数后才看失败比例。 */
export function failureLimitReached(
  policy: BatchPolicy,
  failed: number,
  attempted: number,
): boolean {
  return (
    failed >= policy.failureAbortMin &&
    attempted > 0 &&
    failed / attempted > policy.failureAbortRatio
  )
}
