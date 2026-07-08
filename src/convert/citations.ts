import type { ContentReference, ContentReferenceItem } from '../types'

// ChatGPT 用私有区 Unicode（U+E200 区段）包裹引用标记，如 <U+E200>cite<U+E202>turn0search1<U+E201>。
// 源码里不能出现这些不可见字面量（编辑器/工具链会悄悄弄坏它们），统一用码点构造。
const cp = (n: number) => String.fromCharCode(n)
const PUA_MARKER_RUN = new RegExp(`${cp(0xe200)}[^${cp(0xe201)}]*${cp(0xe201)}`, 'g')
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
  return { text: stripResidualMarkers(text), sources }
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
      const links = items
        .filter(
          (i): i is ContentReferenceItem & { url: string } => typeof i?.url === 'string' && i.url !== '',
        )
        .map((i) => {
          const title = (i.title ?? '').trim() || i.url
          sources.push({ title, url: i.url })
          const label = (i.attribution ?? '').trim() || hostOf(i.url) || title
          return `[${escapeLabel(label)}](${i.url})`
        })
      return links.length > 0 ? `（${links.join('，')}）` : ''
    }
    case 'file':
      return ref.name ? ` *(引用文件: ${ref.name})*` : ''
    default:
      // sources_footnote / hidden / 未知类型：这些是 UI 装饰性标记，直接移除
      return ''
  }
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
