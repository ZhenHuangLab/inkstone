import { describe, expect, test } from 'bun:test'
import { ApiError } from '../src/core/fetcher'
import {
  createConversationPager,
  listAllConversations,
  resolveOrgId,
  type FetchPage,
} from '../src/sites/claude/api'
import type { ClaudeConversationListItem } from '../src/sites/claude/types'

// api.ts 拼 URL 要用 location.origin，bun 环境里补一个
;(globalThis as unknown as { location: { origin: string } }).location = { origin: 'https://claude.ai' }
;(globalThis as unknown as { document: { cookie: string } }).document = { cookie: 'lastActiveOrg=org-from-cookie' }

const items = (n: number, from = 0): ClaudeConversationListItem[] =>
  Array.from({ length: n }, (_, i) => ({ uuid: `c${from + i}` }))

/** 记录每次翻页请求的 offset/limit，并按脚本返回结果 */
function pages(script: (call: { offset: number; limit: number }, n: number) => ClaudeConversationListItem[]) {
  const calls: { offset: number; limit: number }[] = []
  const fetchPage: FetchPage = (_org, offset, limit) => {
    calls.push({ offset, limit })
    return Promise.resolve(script({ offset, limit }, calls.length))
  }
  return { calls, fetchPage }
}

const drain = async (pager: { next(): Promise<{ items: ClaudeConversationListItem[]; done: boolean }> }) => {
  const all: ClaudeConversationListItem[] = []
  for (;;) {
    const { items: page, done } = await pager.next()
    all.push(...page)
    if (done) return all
  }
}

describe('claude 分页器', () => {
  test('按 offset 逐页翻；空页要连续确认 3 次才认到底', async () => {
    // 空页不轻信是继承自 ChatGPT 侧的防御：那边实测过列表索引会瞬时降级，
    // 提前返回空页而对话其实都还在。宁可多问两次，也不要漏掉半个历史。
    const { calls, fetchPage } = pages(({ offset }) => (offset < 100 ? items(50, offset) : []))
    const all = await drain(createConversationPager('org', undefined, { fetchPage, emptyRetryBaseMs: 0 }))
    expect(all.length).toBe(100)
    expect(calls.map((c) => c.offset)).toEqual([0, 50, 100, 100, 100])
  })

  test('服务端忽略分页参数、每次返回同一批时立即收尾，不空转', async () => {
    // 这是 claude.ai 侧尚未实测的分支：limit/offset 可能根本不被认。
    // 一旦发生，第二页会原样返回第一页——只能就此收尾，再问也是同样的东西。
    const { calls, fetchPage } = pages(() => items(30))
    const all = await drain(createConversationPager('org', undefined, { fetchPage, emptyRetryBaseMs: 0 }))
    expect(all.length).toBe(30)
    expect(calls.length).toBe(2)
  })

  test('部分重复时只保留新条目', async () => {
    const { fetchPage } = pages((_c, n) => (n === 1 ? items(10) : n === 2 ? items(10, 5) : []))
    const all = await drain(createConversationPager('org', undefined, { fetchPage, emptyRetryBaseMs: 0 }))
    expect(all.map((i) => i.uuid)).toEqual(
      Array.from({ length: 15 }, (_, i) => `c${i}`),
    )
  })

  test('首页即空 = 账号没有对话，不重试', async () => {
    const { calls, fetchPage } = pages(() => [])
    const all = await drain(createConversationPager('org', undefined, { fetchPage, emptyRetryBaseMs: 0 }))
    expect(all.length).toBe(0)
    expect(calls.length).toBe(1)
  })

  test('非限流的 4xx 先降 limit 再试一次', async () => {
    const { calls, fetchPage } = pages(({ limit }, n) => {
      if (n === 1 && limit > 20) throw new ApiError(400, 'limit too large')
      return n === 1 ? [] : items(5)
    })
    const pager = createConversationPager('org', undefined, { fetchPage, emptyRetryBaseMs: 0 })
    const first = await pager.next()
    expect(first.items.length).toBe(5)
    expect(calls.map((c) => c.limit)).toEqual([50, 20])
  })

  test('限流错误直接抛出，不降级也不吞掉', async () => {
    const { fetchPage } = pages(() => {
      throw new ApiError(429, 'rate limited')
    })
    const pager = createConversationPager('org', undefined, { fetchPage, emptyRetryBaseMs: 0 })
    await expect(pager.next()).rejects.toThrow('rate limited')
  })

  test('取消后不再发请求', async () => {
    const cancel = { cancelled: true }
    const { calls, fetchPage } = pages(() => items(5))
    const pager = createConversationPager('org', cancel, { fetchPage, emptyRetryBaseMs: 0 })
    await expect(pager.next()).rejects.toThrow('已取消')
    expect(calls.length).toBe(0)
  })

  test('收尾后再调直接返回 done，不重复请求', async () => {
    const { calls, fetchPage } = pages(() => [])
    const pager = createConversationPager('org', undefined, { fetchPage, emptyRetryBaseMs: 0 })
    await pager.next()
    const again = await pager.next()
    expect(again).toEqual({ items: [], done: true })
    expect(calls.length).toBe(1)
  })

  test('listAll 复用同一分页器并逐页报告进度', async () => {
    const { fetchPage } = pages(({ offset }) => (offset < 60 ? items(30, offset) : []))
    const progress: number[] = []
    const all = await listAllConversations('org', (n) => progress.push(n), undefined, {
      fetchPage,
      emptyRetryBaseMs: 0,
    })
    expect(all).toHaveLength(60)
    expect(progress).toEqual([30, 60])
  })

  test('进度回调触发风控异常时立即停止继续翻页', async () => {
    const { calls, fetchPage } = pages(({ offset }) => items(5, offset))
    await expect(
      listAllConversations(
        'org',
        () => {
          throw new Error('stop-by-risk-guard')
        },
        undefined,
        { fetchPage, emptyRetryBaseMs: 0 },
      ),
    ).rejects.toThrow('stop-by-risk-guard')
    expect(calls).toHaveLength(1)
  })

  test('分页请求超过安全上限时停止，不继续空转', async () => {
    const { calls, fetchPage } = pages(({ offset }) => items(5, offset))
    const pager = createConversationPager('org', undefined, {
      fetchPage,
      emptyRetryBaseMs: 0,
      maxRequests: 2,
    })
    await pager.next()
    await pager.next()
    await expect(pager.next()).rejects.toThrow('分页请求已达安全上限')
    expect(calls).toHaveLength(2)
  })

  test('累计条目超过安全上限时停止', async () => {
    const { fetchPage } = pages(({ offset }) => items(5, offset))
    const pager = createConversationPager('org', undefined, {
      fetchPage,
      emptyRetryBaseMs: 0,
      maxItems: 8,
    })
    await pager.next()
    await expect(pager.next()).rejects.toThrow('对话数已超过安全上限')
  })
})

describe('Claude 会话准备', () => {
  test('已取消时不能吞掉取消异常并回退 cookie 继续执行', async () => {
    await expect(resolveOrgId({ cancelled: true })).rejects.toThrow('已取消')
  })
})
