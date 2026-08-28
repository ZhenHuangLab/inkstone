// IR → Markdown。站点无关：这里不认识 ChatGPT 的 content_type，也不认识
// Claude 的 content block，只认 core/ir 的 IRBlock。
//
// 排版契约（两个站点、油猴端与离线 CLI 四条路径共用）：
//   - `# User` / `# ChatGPT`|`# Claude` 作为轮次分隔，消息内标题整体降一级
//   - 折叠 callout 承载思维链、工具痕迹与未识别内容——永不静默丢内容
//   - 附件在正文里留 assetToken 占位，下载与链接改写由调用方完成

import { mapTextSegmentsOutsideCode } from '../convert/codeaware'
import { transformHeadings, type HeadingMode } from '../convert/headings'
import { convertMath } from '../convert/math'
import type { AssetRef, IRBlock, IRConversation, IRTurn, SourceLink } from './ir'

export interface ConvertOptions {
  /** 是否把思维链写入导出，默认不写入（打开后折叠 callout） */
  thoughts?: boolean
  /** 消息内标题处理：demote 整体降一级（默认）/ strip 全部剥离为加粗行 */
  headingMode?: HeadingMode
  /** 是否写入工具运行痕迹（发给工具的代码/搜索请求与运行输出），默认不写入 */
  toolTraces?: boolean
}

export interface ConvertResult {
  markdown: string
  title: string
  /** 正文里以 assetToken 占位，待下载后由调用方替换成真实链接 */
  assets: AssetRef[]
}

export type LinkStyle = 'wikilink' | 'markdown'

/** 附件链接统一出口：油猴端与离线 CLI 共用，保证两条管道产出一致。 */
export function assetLink(
  style: LinkStyle,
  path: string,
  opts: { label?: string; embed?: boolean } = {},
): string {
  if (style === 'markdown') {
    const label = escapeLinkLabel(opts.label ?? path.split('/').pop() ?? path)
    return `${opts.embed ? '!' : ''}[${label}](${encodeURI(path)})`
  }
  if (opts.embed) return `![[${path}]]`
  // wikilink 别名里 |、] 会破坏链接语法
  const alias = opts.label?.replace(/[[\]|]/g, '-')
  return `[[${path}${alias ? `|${alias}` : ''}]]`
}

/** 附件占位符：转换层不做网络请求，下载与链接改写由调用方完成。 */
export const assetToken = (fileId: string): string => `%%INKSTONE-ASSET-${fileId}%%`

// 控制字符用码点构造，避免源码里出现不可见字面量
const CONTROL_CHARS = new RegExp(`[${String.fromCharCode(0)}-${String.fromCharCode(31)}]`, 'g')

/** `标题-短id.md`：防重名，且 id 稳定保证增量重导时覆盖同一文件。 */
export function filenameFor(title: string, convId: string): string {
  const safe = sanitizeName(title).slice(0, 80).replace(/-+$/, '') || 'Untitled'
  return `${safe}-${convId.slice(0, 8)}.md`
}

/** 文件名净化：非法字符（跨平台 + Obsidian 链接敏感）与空白统一归一为 `-`，不留空格。 */
export function sanitizeName(name: string): string {
  return name
    .replace(CONTROL_CHARS, '')
    .replace(/[/\\:*?"<>|#^[\]\s]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|-+$/g, '')
}

/**
 * 子文件夹设置净化：按 `/` 分段逐段过 sanitizeName（`.`/`..` 被清成空段丢弃，防目录逃逸），
 * 允许 `a/b` 嵌套；返回 `''` 表示不套子文件夹。
 */
export function sanitizeSubdir(input: string): string {
  return input
    .split('/')
    .map((seg) => sanitizeName(seg))
    .filter((seg) => seg !== '')
    .join('/')
}

export function renderConversation(conv: IRConversation, copts: ConvertOptions = {}): ConvertResult {
  const thoughts = copts.thoughts === true
  const toolTraces = copts.toolTraces === true
  const headingMode: HeadingMode = copts.headingMode ?? 'demote'

  const sources: SourceLink[] = []
  const assets: AssetRef[] = []
  const prose = (text: string): string => transformHeadings(convertMath(text), headingMode)

  const renderBlock = (b: IRBlock): string | null => {
    switch (b.kind) {
      case 'prose':
        // 空正文也要收 sources：原文可能只剩引用标记，还原后为空但来源真实存在
        if (b.sources) sources.push(...b.sources)
        return prose(b.text)

      case 'thinking': {
        if (!thoughts) return null
        if (b.sources) sources.push(...b.sources)
        const items = b.items
          .map((t) => (t.summary?.trim() ? `**${t.summary.trim()}**\n\n` : '') + prose(t.text))
          .filter((s) => s.trim() !== '')
        return items.length === 0 ? null : callout('quote', '思考过程', items.join('\n\n'), true)
      }

      case 'tool': {
        if (b.gated !== false && !toolTraces) return null
        const body = b.fenced === false ? b.body : fence(b.body, b.lang ?? '')
        return callout(b.tone ?? 'example', b.title, body, true)
      }

      case 'document': {
        const isCode = b.docType.startsWith('code/')
        const body = isCode ? fence(b.content, b.docType.slice('code/'.length)) : prose(b.content)
        return callout('abstract', b.label, body)
      }

      case 'asset':
        assets.push(b.ref)
        return assetToken(b.ref.fileId)

      case 'assetList':
        assets.push(...b.refs)
        return b.refs.map((r) => `- ${assetToken(r.fileId)}`).join('\n')

      case 'note':
        return b.text

      case 'raw':
        return callout('warning', b.label, fence(JSON.stringify(b.json, null, 2), 'json'), true)
    }
  }

  const renderTurn = (turn: IRTurn): string | null => {
    const rendered = turn.blocks
      .map(renderBlock)
      .filter((s): s is string => s != null && s.trim() !== '')
    if (rendered.length === 0) return null
    const heading = turn.role === 'user' ? '# User' : `# ${conv.assistantHeading}`
    return [heading, ...rendered].join('\n\n')
  }

  let body = conv.turns
    .map(renderTurn)
    .filter((s): s is string => s != null)
    .join('\n\n')

  const deduped = dedupeSources(sources)
  if (deduped.length > 0) {
    body += `\n\n# Sources\n\n${deduped.map((s) => `- [${escapeLinkLabel(s.title)}](${s.url})`).join('\n')}`
  }

  // 收尾排版：正文里 3 连以上空行压成 1 个空行（代码块内不动）
  const tidied = mapTextSegmentsOutsideCode(body, (s) => s.replace(/\n{3,}/g, '\n\n'))

  const fm = [
    '---',
    `title: ${yamlQuote(conv.title)}`,
    `chat_id: ${conv.id}`,
    `url: ${conv.url}`,
    `created: ${conv.created}`,
    `updated: ${conv.updated}`,
    conv.model ? `model: ${conv.model}` : null,
    conv.models && conv.models.length > 1
      ? `models:\n${conv.models.map((s) => `  - ${s}`).join('\n')}`
      : null,
    ...(conv.extra ?? []).map(([k, v]) => `${k}: ${v}`),
    'tags:',
    ...conv.tags.map((t) => `  - ${t}`),
    '---',
  ]
    .filter((l): l is string => l != null)
    .join('\n')

  return { markdown: `${fm}\n\n${tidied.trim()}\n`, title: conv.title, assets }
}

export function fence(code: string, lang = ''): string {
  // 围栏比内容里最长的反引号串再长一格，避免被内容截断
  const longest = (code.match(/`+/g) ?? []).reduce((n, run) => Math.max(n, run.length), 2)
  const f = '`'.repeat(Math.max(3, longest + 1))
  return `${f}${lang}\n${code.replace(/\n$/, '')}\n${f}`
}

export function callout(type: string, title: string, body: string, folded = false): string {
  const head = `> [!${type}]${folded ? '-' : ''} ${title}`
  const quoted = body
    .split('\n')
    .map((l) => (l === '' ? '>' : `> ${l}`))
    .join('\n')
  return `${head}\n${quoted}`
}

function dedupeSources(sources: SourceLink[]): SourceLink[] {
  const seen = new Map<string, SourceLink>()
  for (const s of sources) {
    if (!seen.has(s.url)) seen.set(s.url, s)
  }
  return [...seen.values()]
}

export function escapeLinkLabel(s: string): string {
  return s.replace(/([[\]])/g, '\\$1')
}

export function yamlQuote(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** epoch 秒 / ISO 字符串 → ISO 字符串；取不到时空串（frontmatter 仍保留该行）。 */
export function toIso(t: number | string | null | undefined): string {
  if (t == null || t === '') return ''
  const d = typeof t === 'number' ? new Date(t * 1000) : new Date(t)
  return Number.isNaN(d.getTime()) ? '' : d.toISOString()
}
