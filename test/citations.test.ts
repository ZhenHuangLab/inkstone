import { describe, expect, test } from 'bun:test'
import { restoreCitations, stripResidualMarkers } from '../src/convert/citations'
import type { ContentReference } from '../src/types'

// 私有区字符统一用码点构造，避免源码里出现不可见字面量
const M = (cp: number): string => String.fromCharCode(cp)
const marker = (body: string): string => `${M(0xe200)}${body.replace(/\|/g, M(0xe202))}${M(0xe201)}`

describe('stripResidualMarkers', () => {
  test('剥离成对的私有区引用标记', () => {
    expect(stripResidualMarkers(`依据${marker('cite|turn0search1')}成立`)).toBe('依据成立')
  })

  test('剥离孤立的私有区字符（如 PDF 提取字形）', () => {
    expect(stripResidualMarkers(`孤儿${M(0xf070)}标记`)).toBe('孤儿标记')
  })

  test('剥离旧版 【12†source】', () => {
    expect(stripResidualMarkers('见【3†source】。')).toBe('见。')
  })

  test('正常文本原样保留', () => {
    expect(stripResidualMarkers('普通【中括号】和 † 单独出现都不动')).toBe(
      '普通【中括号】和 † 单独出现都不动',
    )
  })

  test('代码块里的标记也剥（引用标记不可能合法出现在代码里）', () => {
    expect(stripResidualMarkers('```\nx = 1 ' + marker('cite|turn0search0') + '\n```')).toBe(
      '```\nx = 1 \n```',
    )
  })
})

describe('restoreCitations', () => {
  // 按真实 backend-api 数据结构构造（见 grouped_webpages / file 两类）
  const webRef: ContentReference = {
    matched_text: marker('cite|turn216358view2'),
    type: 'grouped_webpages',
    alt: '([OpenAI Developers](https://developers.openai.com/codex/guides/agents-md))',
    items: [
      {
        title: 'Custom instructions with AGENTS.md – Codex | OpenAI Developers',
        url: 'https://developers.openai.com/codex/guides/agents-md',
        attribution: 'OpenAI Developers',
      },
    ],
  }
  const fileRef: ContentReference = {
    matched_text: marker('filecite|turn1file6'),
    type: 'file',
    alt: null,
    name: '实现方案(基础设施与阶段1-2).md',
    items: [],
  }
  const footnoteRef: ContentReference = {
    matched_text: M(0xe20b),
    type: 'sources_footnote',
    alt: '',
  }

  test('网页引用 → 行内链接 + sources 收集', () => {
    const { text, sources } = restoreCitations(`官方文档有说明。${webRef.matched_text}`, [webRef])
    expect(text).toBe(
      '官方文档有说明。（[OpenAI Developers](https://developers.openai.com/codex/guides/agents-md)）',
    )
    expect(sources).toEqual([
      {
        title: 'Custom instructions with AGENTS.md – Codex | OpenAI Developers',
        url: 'https://developers.openai.com/codex/guides/agents-md',
      },
    ])
  })

  test('文件引用 → 文件名说明', () => {
    const { text } = restoreCitations(`见方案。${fileRef.matched_text}`, [fileRef])
    expect(text).toBe('见方案。 *(引用文件: 实现方案(基础设施与阶段1-2).md)*')
  })

  test('sources_footnote 等装饰性标记移除', () => {
    const { text } = restoreCitations(`结尾${footnoteRef.matched_text}`, [footnoteRef])
    expect(text).toBe('结尾')
  })

  test('同一标记多次出现全部替换', () => {
    const { text } = restoreCitations(`A${fileRef.matched_text}B${fileRef.matched_text}`, [fileRef])
    expect(text).toBe(
      'A *(引用文件: 实现方案(基础设施与阶段1-2).md)*B *(引用文件: 实现方案(基础设施与阶段1-2).md)*',
    )
  })

  test('匹配不上的标记兜底剥离', () => {
    const { text } = restoreCitations(`遗留${marker('cite|turn9search9')}标记`, [])
    expect(text).toBe('遗留标记')
  })

  test('退化的 matched_text（裸空格）不做替换，防止删光全文空格', () => {
    const degenerate: ContentReference = { matched_text: ' ', type: 'sources_footnote', alt: '' }
    const { text } = restoreCitations('a b c', [degenerate])
    expect(text).toBe('a b c')
  })

  test('refs 缺失时等价于纯剥离', () => {
    const { text, sources } = restoreCitations(`文本${marker('cite|x')}`, undefined)
    expect(text).toBe('文本')
    expect(sources).toEqual([])
  })
})
