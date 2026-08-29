import { afterEach, describe, expect, test } from 'bun:test'
import { createConversationPager, projectNameOf } from '../src/api'

// api.ts 依赖 location.origin 拼 URL，bun 环境里补一个
;(globalThis as unknown as { location: { origin: string } }).location = { origin: 'https://chatgpt.com' }

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

interface Item {
  id: string
  /** 真实列表接口给的是 ISO 字符串，归并排序走的就是这条路径 */
  update_time: string
}

interface MainCall {
  offset: number
  limit: number
}

interface MockSpec {
  /** 主列表：第 n 次请求（含降级重试）返回什么 */
  main?: (call: MainCall, n: number) => { status?: number; items?: Item[] }
  /** project 侧栏返回的 project 列表 */
  projects?: { id: string; name: string }[]
  /** 每个 project 的会话页序列；cursor 就是页下标，末页回 cursor=null */
  pages?: Record<string, Item[][]>
}

interface Mock {
  mainCalls: MainCall[]
  /** 请求过的路径（按顺序），用来断言「什么时候才去问 projects」 */
  paths: string[]
}

/** 按 URL 路由的 backend-api 假实现：主列表 / project 侧栏 / project 会话三条路径 */
function mockApi(spec: MockSpec): Mock {
  const mock: Mock = { mainCalls: [], paths: [] }
  const json = (body: unknown, status = 200): Promise<Response> =>
    Promise.resolve(new Response(JSON.stringify(body), { status }))

  globalThis.fetch = ((input: string) => {
    const u = new URL(input)
    mock.paths.push(u.pathname)

    if (u.pathname === '/backend-api/conversations') {
      const call = {
        offset: Number(u.searchParams.get('offset')),
        limit: Number(u.searchParams.get('limit')),
      }
      mock.mainCalls.push(call)
      const r = spec.main?.(call, mock.mainCalls.length) ?? { items: [] }
      return json({ items: r.items ?? [] }, r.status ?? 200)
    }

    if (u.pathname === '/backend-api/gizmos/snorlax/sidebar') {
      const items = (spec.projects ?? []).map((p) => ({
        gizmo: { gizmo: { id: p.id, display: { name: p.name } } },
      }))
      return json({ cursor: null, items })
    }

    const m = /^\/backend-api\/gizmos\/(.+)\/conversations$/.exec(u.pathname)
    if (m) {
      const gizmo = decodeURIComponent(m[1]!)
      const idx = Number(u.searchParams.get('cursor'))
      const pages = spec.pages?.[gizmo] ?? []
      return json({
        items: pages[idx] ?? [],
        cursor: idx + 1 < pages.length ? String(idx + 1) : null,
      })
    }

    throw new Error(`未预期的请求：${input}`)
  }) as typeof fetch

  return mock
}

/** t 越大越新；造成 ISO 字符串，和真实接口一致 */
const item = (id: string, t: number): Item => ({ id, update_time: new Date(t * 1000).toISOString() })

/** 一页递减时间的条目，模拟 order=updated 的倒序页 */
const items = (n: number, from = 0): Item[] =>
  Array.from({ length: n }, (_, i) => item(`c${from + i}`, 10_000 - (from + i)))

/** 抽干分页器，返回全部条目 */
async function drain(pager: { next(): Promise<{ items: unknown[]; done: boolean }> }): Promise<
  { id: string; gizmo_id?: string | null }[]
> {
  const all: { id: string; gizmo_id?: string | null }[] = []
  for (;;) {
    const { items: page, done } = await pager.next()
    all.push(...(page as { id: string; gizmo_id?: string | null }[]))
    if (done) return all
  }
}

describe('createConversationPager · 主列表', () => {
  test('逐页返回，offset 按实际条数推进', async () => {
    const mock = mockApi({
      main: (call) => (call.offset === 0 ? { items: items(100) } : { items: items(3, 100) }),
    })
    const pager = createConversationPager('tok', undefined, 'main')

    const p1 = await pager.next()
    expect(p1.items).toHaveLength(100)
    expect(p1.done).toBe(false)
    // 单源时一次 next() 只打一个请求——这正是懒加载的前提
    expect(mock.paths).toHaveLength(1)

    const p2 = await pager.next()
    expect(p2.items).toHaveLength(3)
    // 短页不代表到底（服务端会按自己的上限截页），仍不置 done
    expect(p2.done).toBe(false)
    expect(mock.mainCalls[1]).toEqual({ offset: 100, limit: 100 })
  }, 20_000)

  test('全空账号：先问 projects 再建流，done 之后不再发请求', async () => {
    const mock = mockApi({})
    const pager = createConversationPager('tok')

    expect(await pager.next()).toEqual({ items: [], done: true })
    // 归并要先知道有哪些源，所以侧栏请求排在主列表之前
    expect(mock.paths).toEqual([
      '/backend-api/gizmos/snorlax/sidebar',
      '/backend-api/conversations',
    ])

    expect(await pager.next()).toEqual({ items: [], done: true })
    expect(mock.paths).toHaveLength(2)
  }, 20_000)

  test('非限流 4xx 把 limit 降到 50 重试一次', async () => {
    const mock = mockApi({ main: (_call, n) => (n === 1 ? { status: 422 } : { items: items(50) }) })
    const pager = createConversationPager('tok', undefined, 'main')

    const page = await pager.next()
    expect(page.items).toHaveLength(50)
    expect(mock.mainCalls.map((c) => c.limit)).toEqual([100, 50])
  }, 20_000)
})

describe('createConversationPager · projects', () => {
  test('source=all：主列表与各 project 按 update_time 归并，条目补上 gizmo_id', async () => {
    mockApi({
      // c-tail 永远排最后，主列表在本例里不会被取空（避开空页重试的十几秒真 sleep）
      main: () => ({ items: [item('c-new', 100), item('c-old', 70), item('c-tail', 10)] }),
      projects: [
        { id: 'g-p-a', name: '项目甲' },
        { id: 'g-p-b', name: '项目乙' },
      ],
      pages: {
        // 两页，验证字符串游标确实被回传（只翻第一页是这套接口的经典 bug）
        'g-p-a': [[item('a-90', 90)], [item('a-60', 60)]],
        'g-p-b': [[item('b-80', 80)]],
      },
    })

    // 收齐 6 条就够判定顺序；不跟具体分批方式绑定
    const pager = createConversationPager('tok')
    const all: { id: string; gizmo_id?: string | null }[] = []
    for (let i = 0; i < 8 && all.length < 6; i++) {
      const { items: page } = await pager.next()
      all.push(...(page as typeof all))
    }

    // 三个来源交错排序，而不是一源接一源
    expect(all.map((i) => i.id)).toEqual(['c-new', 'a-90', 'b-80', 'c-old', 'a-60', 'c-tail'])
    expect(all.filter((i) => i.gizmo_id === 'g-p-a').map((i) => i.id)).toEqual(['a-90', 'a-60'])
    expect(all.filter((i) => i.gizmo_id === 'g-p-b').map((i) => i.id)).toEqual(['b-80'])
    expect(all.filter((i) => i.gizmo_id == null)).toHaveLength(3)
    // 侧栏顺带把 gizmo_id → project 名喂给了转换层（列表里的项目标签靠它）
    expect(projectNameOf('g-p-a')).toBe('项目甲')
    expect(projectNameOf('g-p-b')).toBe('项目乙')
  }, 30_000)

  test('source=main 只翻主列表，不碰 gizmos 接口', async () => {
    const mock = mockApi({
      main: (call) => (call.offset === 0 ? { items: items(2, 40) } : { items: [] }),
      projects: [{ id: 'g-p-x', name: '不该被拉到' }],
      pages: { 'g-p-x': [items(1, 50)] },
    })

    const all = await drain(createConversationPager('tok', undefined, 'main'))

    expect(all.map((i) => i.id)).toEqual(['c40', 'c41'])
    expect(mock.paths.every((p) => p === '/backend-api/conversations')).toBe(true)
  }, 45_000)

  test('source=<gizmo id> 直奔该 project，不碰主列表也不拉侧栏', async () => {
    const mock = mockApi({
      main: () => ({ items: items(2, 60) }),
      projects: [{ id: 'g-p-solo', name: '项目丁' }],
      pages: { 'g-p-solo': [items(2, 70), items(1, 72)] },
    })

    const all = await drain(createConversationPager('tok', undefined, 'g-p-solo'))

    expect(all.map((i) => i.id)).toEqual(['c70', 'c71', 'c72'])
    expect(all.every((i) => i.gizmo_id === 'g-p-solo')).toBe(true)
    // 选定单个 project 时连 project 列表都不用拉
    expect(mock.paths).toEqual([
      '/backend-api/gizmos/g-p-solo/conversations',
      '/backend-api/gizmos/g-p-solo/conversations',
    ])
    expect(mock.mainCalls).toHaveLength(0)
  }, 20_000)

  test('跨源重复的 id 只交出一次，且不会把整页重复当成到底', async () => {
    mockApi({
      main: (call) => (call.offset === 0 ? { items: items(2) } : { items: [] }),
      projects: [{ id: 'g-p-dup', name: '项目丙' }],
      // 第一页整页与主列表重复，真正的新条目在第二页
      pages: { 'g-p-dup': [items(2), items(1, 30)] },
    })

    const all = await drain(createConversationPager('tok'))

    expect(all.map((i) => i.id)).toEqual(['c0', 'c1', 'c30'])
  }, 45_000)
})

// 未覆盖：列表中段返回空页时的「隔 4s / 8s 重试确认，连续空 3 次才算到底」路径。
// 该路径内建十几秒的真实 sleep，放进单测会把整个套件拖慢一个数量级。
