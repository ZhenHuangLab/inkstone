import { describe, expect, test } from 'bun:test'
import { groupTurns, linearize } from '../src/convert/linearize'
import type { ConversationDetail } from '../src/types'
import fixtureJson from './fixtures/basic.json'

const fixture = fixtureJson as unknown as ConversationDetail

describe('linearize', () => {
  test('沿 current_node 取主线，过滤 system/隐藏节点', () => {
    const ids = linearize(fixture).map((m) => m.id)
    expect(ids).toEqual(['u1', 'a1', 'a2', 'u2', 'a3', 't1', 'a4', 'x1'])
  })

  test('被重新生成的旧分支不在主线上', () => {
    const ids = linearize(fixture).map((m) => m.id)
    expect(ids).not.toContain('a1old')
  })

  test('current_node 缺失时回退到最新叶子', () => {
    const noCursor = { ...fixture, current_node: null }
    const ids = linearize(noCursor).map((m) => m.id)
    expect(ids[ids.length - 1]).toBe('x1')
  })
})

describe('groupTurns', () => {
  test('相邻同侧消息合并；assistant/tool 同归 ChatGPT 轮', () => {
    const turns = groupTurns(linearize(fixture))
    expect(turns.map((t) => t.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(turns.map((t) => t.messages.length)).toEqual([1, 2, 1, 4])
  })
})
