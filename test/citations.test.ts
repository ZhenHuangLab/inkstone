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

describe('token 通道（官方导出 zip 无 matched_text）', () => {
  const M = (cp: number): string => String.fromCharCode(cp)
  const mark = (...segs: string[]) => `${M(0xe200)}${segs.join(M(0xe202))}${M(0xe201)}`

  test('web 引用按 turn/ref_type/ref_index 重建', () => {
    const refs = [
      {
        type: 'grouped_webpages',
        alt: null,
        items: [
          {
            title: 'NIST Handbook',
            url: 'https://nist.gov/x',
            attribution: 'NIST',
            refs: [{ ref_index: 0, ref_type: 'view', turn_index: 8 }],
          },
        ],
      },
    ]
    const { text, sources } = restoreCitations(`结论${mark('cite', 'turn8view0')}。`, refs)
    expect(text).toBe('结论（[NIST](https://nist.gov/x)）。')
    expect(sources).toEqual([{ title: 'NIST Handbook', url: 'https://nist.gov/x' }])
  })

  test('一个标记多 token：去重 url 后并列', () => {
    const item = (u: string, t: number) => ({
      title: u,
      url: u,
      attribution: '',
      refs: [{ ref_index: 0, ref_type: 'search', turn_index: t }],
    })
    const refs = [
      { type: 'grouped_webpages', items: [item('https://a.com/1', 1)] },
      { type: 'grouped_webpages', items: [item('https://b.com/2', 2)] },
    ]
    const { text } = restoreCitations(mark('cite', 'turn1search0', 'turn2search0'), refs)
    expect(text).toBe('（[a.com](https://a.com/1)，[b.com](https://b.com/2)）')
  })

  test('filecite 用 input_pointer 定位', () => {
    const refs = [
      {
        type: 'file',
        name: '推导.md',
        input_pointer: { message_index: 4, file_index: 5 },
      },
    ]
    const { text } = restoreCitations(`见文件${mark('filecite', 'turn4file5')}`, refs)
    expect(text).toBe('见文件 *(引用文件: 推导.md)*')
  })

  test('解析不到的 token 仍旧剥离，不留乱码', () => {
    const refs = [{ type: 'grouped_webpages', items: [] }]
    const { text } = restoreCitations(`甲${mark('cite', 'turn9search9')}乙`, refs)
    expect(text).toBe('甲乙')
  })

  test('navlist：标题段跳过，token 段照收', () => {
    const refs = [
      {
        type: 'grouped_webpages',
        items: [
          {
            title: 'News',
            url: 'https://n.com/1',
            attribution: 'N',
            refs: [{ ref_index: 0, ref_type: 'news', turn_index: 3 }],
          },
        ],
      },
    ]
    const { text } = restoreCitations(mark('navlist', 'Top stories', 'turn3news0'), refs)
    expect(text).toBe('（[N](https://n.com/1)）')
  })
})

describe('cite 标记按顺序配对（官方导出的大数 turn 号）', () => {
  const M = (cp: number): string => String.fromCharCode(cp)
  const mark = (...segs: string[]) => `${M(0xe200)}${segs.join(M(0xe202))}${M(0xe201)}`
  const webRef = (url: string, label: string) => ({
    type: 'grouped_webpages',
    items: [{ title: label, url, attribution: label, refs: [{ ref_index: 0, ref_type: 'view', turn_index: 8 }] }],
  })

  test('标记数与 web 引用数吻合：按出现顺序配对（token 对不上也能还原）', () => {
    const refs = [webRef('https://a.com/', 'A'), webRef('https://b.com/', 'B')]
    const text = `甲${mark('cite', 'turn913783view0')}乙${mark('cite', 'turn711152view0')}`
    const { text: out } = restoreCitations(text, refs)
    expect(out).toBe('甲（[A](https://a.com/)）乙（[B](https://b.com/)）')
  })

  test('数量不吻合：不硬配，退回精确 token（对不上则剥离）', () => {
    const refs = [webRef('https://a.com/', 'A')]
    const text = `甲${mark('cite', 'turn913783view0')}乙${mark('cite', 'turn711152view0')}`
    const { text: out } = restoreCitations(text, refs)
    expect(out).toBe('甲乙')
  })

  test('filecite 与 cite 混排互不干扰', () => {
    const refs = [
      { type: 'file', name: 'notes.md', input_pointer: { message_index: 2, file_index: 3 } },
      webRef('https://a.com/', 'A'),
    ]
    const text = `见${mark('filecite', 'turn2file3')}和${mark('cite', 'turn999999view0')}`
    const { text: out } = restoreCitations(text, refs)
    expect(out).toBe('见 *(引用文件: notes.md)*和（[A](https://a.com/)）')
  })
})
