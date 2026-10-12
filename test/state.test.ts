import { beforeEach, describe, expect, test } from 'bun:test'
import { clearWatermarks, loadWatermark, saveWatermark, selectChanged } from '../src/state'

// bun 环境无 GM/localStorage，注入一个内存版
const store = new Map<string, string>()
;(globalThis as unknown as { localStorage: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, String(v)),
}

describe('watermark 存取', () => {
  beforeEach(() => store.clear())

  test('空状态返回空对象', () => {
    expect(loadWatermark('markdown')).toEqual({})
  })

  test('往返一致，kind 之间隔离', () => {
    saveWatermark('markdown', { a: '2026-07-08T00:00:00Z' })
    saveWatermark('json', { b: '1' })
    expect(loadWatermark('markdown')).toEqual({ a: '2026-07-08T00:00:00Z' })
    expect(loadWatermark('json')).toEqual({ b: '1' })
  })

  test('损坏数据回退空对象', () => {
    store.set('inkstone:wm:markdown', '{oops')
    expect(loadWatermark('markdown')).toEqual({})
  })

  test('clearWatermarks 清空指定 kind', () => {
    saveWatermark('markdown', { a: '1' })
    clearWatermarks(['markdown'])
    expect(loadWatermark('markdown')).toEqual({})
  })

  test('升级时将两种旧水位线迁移到 ChatGPT，增量仍跳过未变化项', () => {
    for (const kind of ['markdown', 'json']) {
      saveWatermark(kind, { a: '1' })
      expect(loadWatermark(`chatgpt:${kind}`)).toEqual({ a: '1' })
      expect(store.get(`inkstone:wm:chatgpt:${kind}`)).toBe('{"a":"1"}')
      expect(selectChanged([{ id: 'a', update_time: '1' }], loadWatermark(`chatgpt:${kind}`))).toEqual([])
      expect(loadWatermark(`claude:${kind}`)).toEqual({})
    }
  })

  test('已有新水位线优先，重置后不复活旧记录', () => {
    saveWatermark('markdown', { old: '1' })
    saveWatermark('chatgpt:markdown', { fresh: '2' })
    expect(loadWatermark('chatgpt:markdown')).toEqual({ fresh: '2' })
    clearWatermarks(['chatgpt:markdown'])
    expect(loadWatermark('chatgpt:markdown')).toEqual({})
    expect(loadWatermark('markdown')).toEqual({ old: '1' })
  })

  test('迁移只执行一次，后续旧表变化不影响新表', () => {
    saveWatermark('json', { a: '1' })
    expect(loadWatermark('chatgpt:json')).toEqual({ a: '1' })
    saveWatermark('json', { b: '2' })
    expect(loadWatermark('chatgpt:json')).toEqual({ a: '1' })
  })

  test('旧数据损坏不报错，已有损坏新表也不恢复旧记录', () => {
    store.set('inkstone:wm:json', '[1]')
    expect(loadWatermark('chatgpt:json')).toEqual({})
    saveWatermark('markdown', { a: '1' })
    store.set('inkstone:wm:chatgpt:markdown', '{oops')
    expect(loadWatermark('chatgpt:markdown')).toEqual({})
  })

  test('GM 存储升级和重置遵循相同规则', () => {
    const gm = new Map<string, string>([['inkstone:wm:markdown', '{"a":"1"}']])
    const globals = globalThis as unknown as {
      GM_getValue?: (key: string) => string | undefined
      GM_setValue?: (key: string, value: string) => void
    }
    const previousGet = globals.GM_getValue
    const previousSet = globals.GM_setValue
    globals.GM_getValue = (key) => gm.get(key)
    globals.GM_setValue = (key, value) => { gm.set(key, value) }
    try {
      expect(loadWatermark('chatgpt:markdown')).toEqual({ a: '1' })
      expect(gm.get('inkstone:wm:chatgpt:markdown')).toBe('{"a":"1"}')
      expect(store.size).toBe(0)
      clearWatermarks(['chatgpt:markdown'])
      expect(loadWatermark('chatgpt:markdown')).toEqual({})
    } finally {
      globals.GM_getValue = previousGet
      globals.GM_setValue = previousSet
    }
  })
})

describe('selectChanged 增量筛选', () => {
  const items = [
    { id: 'a', update_time: '2026-07-01T00:00:00Z' },
    { id: 'b', update_time: '2026-07-02T00:00:00Z' },
    { id: 'c', update_time: null },
    { id: 'd', update_time: 1751500000.5 },
  ]

  test('水位线为空 → 全部要导', () => {
    expect(selectChanged(items, {}).map((i) => i.id)).toEqual(['a', 'b', 'c', 'd'])
  })

  test('一致的跳过，变化的和新增的保留', () => {
    const wm = {
      a: '2026-07-01T00:00:00Z', // 未变 → 跳过
      b: '2026-06-30T00:00:00Z', // 有更新 → 保留
      d: '1751500000.5', // 数字时间戳字符串化后一致 → 跳过
    }
    expect(selectChanged(items, wm).map((i) => i.id)).toEqual(['b', 'c'])
  })

  test('update_time 缺失的对话与空串水位线视为一致', () => {
    expect(selectChanged([{ id: 'c', update_time: null }], { c: '' })).toEqual([])
  })
})
