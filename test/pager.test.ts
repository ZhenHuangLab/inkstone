import { afterEach, describe, expect, test } from 'bun:test'
import { createConversationPager } from '../src/api'

// api.ts 依赖 location.origin 拼 URL，bun 环境里补一个
;(globalThis as unknown as { location: { origin: string } }).location = { origin: 'https://chatgpt.com' }

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

interface Call {
  offset: number
  limit: number
}

/** 用一批「响应生成器」替换 fetch，并记录每次请求的 offset/limit */
function mockPages(
  responder: (call: Call, n: number) => { status?: number; items?: unknown[] },
): Call[] {
  const calls: Call[] = []
  globalThis.fetch = ((url: string) => {
    const u = new URL(url)
    const call = {
      offset: Number(u.searchParams.get('offset')),
      limit: Number(u.searchParams.get('limit')),
    }
    calls.push(call)
    const r = responder(call, calls.length)
    const status = r.status ?? 200
    return Promise.resolve(
      new Response(JSON.stringify({ items: r.items ?? [] }), { status }),
    )
  }) as typeof fetch
  return calls
}

const items = (n: number, from = 0): { id: string }[] =>
  Array.from({ length: n }, (_, i) => ({ id: `c${from + i}` }))

describe('createConversationPager', () => {
  test('逐页返回，offset 按实际条数推进', async () => {
    const calls = mockPages((call) => (call.offset === 0 ? { items: items(100) } : { items: items(3, 100) }))
    const pager = createConversationPager('tok')

    const p1 = await pager.next()
    expect(p1.items).toHaveLength(100)
    expect(p1.done).toBe(false)
    // 一次 next() 只打一个请求——这正是懒加载的前提
    expect(calls).toHaveLength(1)

    const p2 = await pager.next()
    expect(p2.items).toHaveLength(3)
    // 短页不代表到底（服务端会按自己的上限截页），仍不置 done
    expect(p2.done).toBe(false)
    expect(calls[1]).toEqual({ offset: 100, limit: 100 })
  }, 20_000)

  test('首页即空 = 到底，且 done 之后不再发请求', async () => {
    const calls = mockPages(() => ({ items: [] }))
    const pager = createConversationPager('tok')

    expect(await pager.next()).toEqual({ items: [], done: true })
    expect(calls).toHaveLength(1)

    expect(await pager.next()).toEqual({ items: [], done: true })
    expect(calls).toHaveLength(1)
  }, 20_000)

  test('非限流 4xx 把 limit 降到 50 重试一次', async () => {
    const calls = mockPages((_call, n) => (n === 1 ? { status: 422 } : { items: items(50) }))
    const pager = createConversationPager('tok')

    const page = await pager.next()
    expect(page.items).toHaveLength(50)
    expect(calls.map((c) => c.limit)).toEqual([100, 50])
  }, 20_000)
})

// 未覆盖：列表中段返回空页时的「隔 4s / 8s 重试确认，连续空 3 次才算到底」路径。
// 该路径内建十几秒的真实 sleep，放进单测会把整个套件拖慢一个数量级。
