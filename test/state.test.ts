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
    store.set('gexport:wm:markdown', '{oops')
    expect(loadWatermark('markdown')).toEqual({})
  })

  test('clearWatermarks 清空指定 kind', () => {
    saveWatermark('markdown', { a: '1' })
    clearWatermarks(['markdown'])
    expect(loadWatermark('markdown')).toEqual({})
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
    expect(selectChanged(items, {}).map(i => i.id)).toEqual(['a', 'b', 'c', 'd'])
  })

  test('一致的跳过，变化的和新增的保留', () => {
    const wm = {
      a: '2026-07-01T00:00:00Z', // 未变 → 跳过
      b: '2026-06-30T00:00:00Z', // 有更新 → 保留
      d: '1751500000.5', // 数字时间戳字符串化后一致 → 跳过
    }
    expect(selectChanged(items, wm).map(i => i.id)).toEqual(['b', 'c'])
  })

  test('update_time 缺失的对话与空串水位线视为一致', () => {
    expect(selectChanged([{ id: 'c', update_time: null }], { c: '' })).toEqual([])
  })
})
