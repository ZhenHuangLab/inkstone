import type { ContentReference, ContentReferenceItem } from '../types'

// ChatGPT 用私有区 Unicode（U+E200 区段）包裹引用标记，如 <U+E200>cite<U+E202>turn0search1<U+E201>。
// 源码里不能出现这些不可见字面量（编辑器/工具链会悄悄弄坏它们），统一用码点构造。
const cp = (n: number) => String.fromCharCode(n)
const PUA_MARKER_RUN = new RegExp(`${cp(0xe200)}[^${cp(0xe201)}]*${cp(0xe201)}`, 'g')
const PUA_MARKER_CAPTURE = new RegExp(`${cp(0xe200)}([^${cp(0xe201)}]*)${cp(0xe201)}`, 'g')
const PUA_SEP = cp(0xe202)
const PUA_ANY = new RegExp(`[${cp(0xe000)}-${cp(0xf8ff)}]`, 'g')
const LEGACY_CITATION = /【[^【】\n]*†[^【】\n]*】/g // 【12†source】

export interface SourceLink {
  title: string
  url: string
}

export interface RestoreResult {
  text: string
  sources: SourceLink[]
}

/**
 * 用 metadata.content_references 把正文里的引用标记还原成行内 Markdown 链接，
 * 并收集 SourceLink 供文末 Sources 汇总；还原不了的标记一律剥离，绝不留乱码。
 *
 * 注意：这里刻意不做代码块感知——引用标记是元数据驱动的私有区字符，
 * 不可能合法出现在代码里；而嵌套围栏会让代码感知解析错位、漏掉正文（真实数据已踩过）。
 */
export function restoreCitations(text: string, refs?: ContentReference[]): RestoreResult {
  const sources: SourceLink[] = []
  for (const ref of refs ?? []) {
    const matched = ref.matched_text
    // 只替换真正的引用标记。真实数据里见过 sources_footnote 的 matched_text
    // 是一个裸空格——直接 split/join 会把全文空格删光。
    if (!matched || !isCitationMarker(matched) || !text.includes(matched)) continue
    text = text.split(matched).join(renderRef(ref, sources))
  }
  text = restoreByToken(text, refs ?? [], sources)
  return { text: stripResidualMarkers(text), sources }
}

// —— 无 matched_text 通道（官方导出 zip）：从结构化字段重建标记归属 ——
// 标记形如 <E200>cite<E202>turn8view0<E201>（web，可多 token）/ <E200>filecite<E202>turn4file5<E201>（文件）。
// 三层策略（2026-07 对 432 对话实测）：
// 1. filecite：input_pointer 的 (message_index, file_index) 精确定位，全量命中
// 2. cite：正文标记的 turn 号常是另一套大数编号，token 精确匹配大面积落空；
//    但「cite 标记数 == web 引用数」在 503/503 条消息上成立 → 数量吻合时按出现顺序配对
// 3. 其余种类（navlist…）：用 items[].refs 的 turn{turn_index}{ref_type}{ref_index} 精确匹配

const WEB_REF_TYPES = new Set([
  'webpage',
  'webpage_extended',
  'grouped_webpages',
  'grouped_webpages_model_predicted',
])

type TokenTarget = { kind: 'web'; item: ContentReferenceItem } | { kind: 'file'; name: string }

function buildTokenMap(refs: readonly ContentReference[]): Map<string, TokenTarget> {
  const map = new Map<string, TokenTarget>()
  for (const ref of refs) {
    if (ref.type === 'file') {
      const ip = ref.input_pointer
      if (
        ip &&
        typeof ip.message_index === 'number' &&
        typeof ip.file_index === 'number' &&
        typeof ref.name === 'string' &&
        ref.name !== ''
      ) {
        map.set(`turn${ip.message_index}file${ip.file_index}`, { kind: 'file', name: ref.name })
      }
      continue
    }
    const items = (ref.items?.length ? ref.items : ref.fallback_items) ?? []
    for (const item of items) {
      if (typeof item?.url !== 'string' || item.url === '') continue
      for (const rr of item.refs ?? []) {
        if (typeof rr?.turn_index === 'number' && typeof rr.ref_type === 'string' && typeof rr.ref_index === 'number') {
          map.set(`turn${rr.turn_index}${rr.ref_type}${rr.ref_index}`, { kind: 'web', item })
        }
      }
    }
  }
  return map
}

function restoreByToken(text: string, refs: readonly ContentReference[], sources: SourceLink[]): string {
  const remaining = refs.filter((r) => !r.matched_text) // matched_text 通道已处理的不掺和
  if (remaining.length === 0 || !new RegExp(PUA_MARKER_RUN.source).test(text)) return text

  const tokens = buildTokenMap(remaining)
  const webRefs = remaining.filter((r) => WEB_REF_TYPES.has(r.type ?? ''))
  // cite 标记与 web 引用数量吻合才敢按顺序配对，否则退回精确 token
  const citeMarks = [...text.matchAll(PUA_MARKER_CAPTURE)].filter(
    (m) => m[1]!.split(PUA_SEP)[0] === 'cite',
  ).length
  const positional = citeMarks > 0 && citeMarks === webRefs.length ? webRefs : null
  let citeIdx = 0

  return text.replace(PUA_MARKER_CAPTURE, (whole, inner: string) => {
    const segs = inner.split(PUA_SEP)
    if (segs[0] === 'cite' && positional) {
      return renderRef(positional[citeIdx++]!, sources)
    }
    // 精确 token：首段是标记种类（cite/filecite/navlist…），其余段里凡能解析的都收
    const items: ContentReferenceItem[] = []
    const files: string[] = []
    const seenUrl = new Set<string>()
    for (const seg of segs.slice(1)) {
      const hit = tokens.get(seg)
      if (!hit) continue
      if (hit.kind === 'file') {
        if (!files.includes(hit.name)) files.push(hit.name)
      } else if (!seenUrl.has(hit.item.url!)) {
        seenUrl.add(hit.item.url!)
        items.push(hit.item)
      }
    }
    if (items.length === 0 && files.length === 0) return whole // 留给兜底剥离
    const parts: string[] = []
    if (items.length > 0) parts.push(renderItems(items, sources))
    if (files.length > 0) parts.push(` *(引用文件: ${files.join('、')})*`)
    return parts.join('')
  })
}

function isCitationMarker(matched: string): boolean {
  // 用非全局正则测试（全局正则的 lastIndex 有状态，test 会跳步）
  return new RegExp(PUA_ANY.source).test(matched) || new RegExp(LEGACY_CITATION.source).test(matched)
}

/** 兜底剥离：残余私有区标记 + 旧版 【12†source】。 */
export function stripResidualMarkers(text: string): string {
  return text.replace(PUA_MARKER_RUN, '').replace(PUA_ANY, '').replace(LEGACY_CITATION, '')
}

function renderRef(ref: ContentReference, sources: SourceLink[]): string {
  switch (ref.type) {
    case 'webpage':
    case 'webpage_extended':
    case 'grouped_webpages':
    case 'grouped_webpages_model_predicted': {
      const items = (ref.items?.length ? ref.items : ref.fallback_items) ?? []
      return renderItems(items, sources)
    }
    case 'file':
      return ref.name ? ` *(引用文件: ${ref.name})*` : ''
    default:
      // sources_footnote / hidden / 未知类型：这些是 UI 装饰性标记，直接移除
      return ''
  }
}

/** 网页引用条目 → 行内 `（[label](url)，…）`，同时收集 Sources。 */
function renderItems(items: readonly ContentReferenceItem[], sources: SourceLink[]): string {
  const links = items
    .filter((i): i is ContentReferenceItem & { url: string } => typeof i?.url === 'string' && i.url !== '')
    .map((i) => {
      const title = (i.title ?? '').trim() || i.url
      sources.push({ title, url: i.url })
      const label = (i.attribution ?? '').trim() || hostOf(i.url) || title
      return `[${escapeLabel(label)}](${i.url})`
    })
  return links.length > 0 ? `（${links.join('，')}）` : ''
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

function escapeLabel(s: string): string {
  return s.replace(/([[\]])/g, '\\$1')
}
