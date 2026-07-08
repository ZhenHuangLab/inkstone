import { describe, expect, test } from 'bun:test'
import { stripCitationMarkers } from '../src/convert/citations'

// 私有区字符统一用码点构造，避免源码里出现不可见字面量
const M = (cp: number): string => String.fromCharCode(cp)

describe('stripCitationMarkers', () => {
  test('剥离成对的私有区引用标记', () => {
    const marked = `依据${M(0xe200)}cite${M(0xe202)}turn0search1${M(0xe201)}成立`
    expect(stripCitationMarkers(marked)).toBe('依据成立')
  })

  test('剥离孤立的私有区字符', () => {
    expect(stripCitationMarkers(`孤儿${M(0xe205)}标记`)).toBe('孤儿标记')
  })

  test('剥离旧版 【12†source】', () => {
    expect(stripCitationMarkers('见【3†source】。')).toBe('见。')
  })

  test('正常文本原样保留', () => {
    expect(stripCitationMarkers('普通【中括号】和 † 单独出现都不动')).toBe(
      '普通【中括号】和 † 单独出现都不动',
    )
  })
})
