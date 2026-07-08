import type {
  AttachmentMeta,
  ContentReference,
  ConversationDetail,
  ImageAssetPart,
  Message,
  MessageContent,
} from '../types'
import { groupTurns, linearize, type Turn } from './linearize'
import { convertMath } from './math'
import { demoteHeadings } from './headings'
import { restoreCitations, stripResidualMarkers, type SourceLink } from './citations'
import { mapTextSegmentsOutsideCode } from './codeaware'

export interface AssetRef {
  fileId: string
  kind: 'image' | 'file'
  name?: string
  sizeBytes?: number
  mime?: string
}

export interface ConvertResult {
  markdown: string
  title: string
  /** 正文里以 assetToken 占位，待下载后由调用方替换成真实链接 */
  assets: AssetRef[]
}

/** 附件占位符：转换层不做网络请求，下载与链接改写由调用方完成。 */
export const assetToken = (fileId: string): string => `%%GEXPORT-ASSET-${fileId}%%`

// 控制字符用码点构造，避免源码里出现不可见字面量
const CONTROL_CHARS = new RegExp(`[${String.fromCharCode(0)}-${String.fromCharCode(31)}]`, 'g')

interface RenderCtx {
  sources: SourceLink[]
  assets: AssetRef[]
}

export function conversationToMarkdown(conv: ConversationDetail, fallbackId = ''): ConvertResult {
  const convId = String(conv.conversation_id ?? conv.id ?? fallbackId)
  const title = (conv.title ?? '').trim() || 'Untitled'
  const messages = linearize(conv)
  const model =
    conv.default_model_slug ??
    messages.find(m => m.author.role === 'assistant' && m.metadata?.model_slug)?.metadata?.model_slug

  const ctx: RenderCtx = { sources: [], assets: [] }
  const turns = groupTurns(messages)
  let body = turns
    .map(t => renderTurn(t, ctx))
    .filter((s): s is string => s != null)
    .join('\n\n')

  const sources = dedupeSources(ctx.sources)
  if (sources.length > 0) {
    body += `\n\n# Sources\n\n${sources.map(s => `- [${escapeLinkLabel(s.title)}](${s.url})`).join('\n')}`
  }

  // 收尾排版：正文里 3 连以上空行压成 1 个空行（代码块内不动）
  const tidied = mapTextSegmentsOutsideCode(body, s => s.replace(/\n{3,}/g, '\n\n'))

  const fm = [
    '---',
    `title: ${yamlQuote(title)}`,
    `chat_id: ${convId}`,
    `url: https://chatgpt.com/c/${convId}`,
    `created: ${toIso(conv.create_time)}`,
    `updated: ${toIso(conv.update_time)}`,
    model ? `model: ${model}` : null,
    'tags:',
    '  - chatgpt',
    '---',
  ]
    .filter((l): l is string => l != null)
    .join('\n')

  return { markdown: `${fm}\n\n${tidied.trim()}\n`, title, assets: ctx.assets }
}

/** `标题 ~短id.md`：防重名，且 id 稳定保证增量重导时覆盖同一文件。 */
export function filenameFor(title: string, convId: string): string {
  const safe = sanitizeName(title).slice(0, 80).trim() || 'Untitled'
  return `${safe} ~${convId.slice(0, 8)}.md`
}

/** 文件名净化（跨平台非法字符 + Obsidian 链接敏感字符 + 控制字符）。 */
export function sanitizeName(name: string): string {
  return name
    .replace(/[/\\:*?"<>|#^[\]]/g, ' ')
    .replace(CONTROL_CHARS, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
}

function renderTurn(turn: Turn, ctx: RenderCtx): string | null {
  const rendered = turn.messages
    .map(m => renderMessage(m, ctx))
    .filter((s): s is string => s != null && s.trim() !== '')
  if (rendered.length === 0) return null
  const heading = turn.role === 'user' ? '# User' : '# ChatGPT'
  return [heading, ...rendered].join('\n\n')
}

function renderMessage(msg: Message, ctx: RenderCtx): string | null {
  const c = msg.content
  const recipient = msg.recipient ?? 'all'
  const refs = msg.metadata?.content_references
  const blocks: string[] = []
  const inlineImageIds = new Set<string>()

  switch (c.content_type) {
    case 'text': {
      const raw = joinTextParts(c)
      if (msg.author.role === 'assistant' && recipient !== 'all') {
        // Canvas / 联网等工具调用载荷（多为 JSON）：整块折叠嵌入，不丢内容
        blocks.push(callout('example', `工具调用 → \`${recipient}\``, fence(stripResidualMarkers(raw)), true))
      } else {
        blocks.push(renderProse(raw, refs, ctx))
      }
      break
    }
    case 'multimodal_text':
      for (const p of c.parts ?? []) {
        if (typeof p === 'string') {
          const s = renderProse(p, refs, ctx)
          if (s.trim() !== '') blocks.push(s)
        } else {
          const rendered = renderImageAsset(p, ctx)
          blocks.push(rendered.block)
          if (rendered.fileId) inlineImageIds.add(rendered.fileId)
        }
      }
      break
    case 'code':
      blocks.push(fence(c.text ?? '', codeLanguage(c, recipient)))
      break
    case 'execution_output':
      blocks.push(callout('note', '运行输出', fence(stripResidualMarkers(c.text ?? '')), true))
      break
    case 'thoughts': {
      const t = renderThoughts(c, refs, ctx)
      if (t != null) blocks.push(t)
      break
    }
    default:
      // 未知类型：原始 JSON 塞进折叠 callout，永不静默丢内容
      blocks.push(
        callout(
          'warning',
          `未识别的内容类型 \`${c.content_type}\`（原始 JSON）`,
          fence(JSON.stringify(c, null, 2), 'json'),
          true,
        ),
      )
  }

  // 用户上传的附件（图片已在正文里内联的不重复列出）
  const attachments = (msg.metadata?.attachments ?? []).filter(a => a?.id && !inlineImageIds.has(a.id))
  if (attachments.length > 0) {
    blocks.push(attachments.map(a => `- ${registerFileAsset(a, ctx)}`).join('\n'))
  }

  const out = blocks.filter(s => s.trim() !== '').join('\n\n')
  return out === '' ? null : out
}

function renderProse(raw: string, refs: ContentReference[] | undefined, ctx: RenderCtx): string {
  const { text, sources } = restoreCitations(raw, refs)
  ctx.sources.push(...sources)
  return demoteHeadings(convertMath(text))
}

function renderThoughts(c: MessageContent, refs: ContentReference[] | undefined, ctx: RenderCtx): string | null {
  const blocks = (c.thoughts ?? [])
    .map(t => {
      const head = t.summary?.trim() ? `**${t.summary.trim()}**\n\n` : ''
      return head + renderProse(t.content ?? '', refs, ctx)
    })
    .filter(s => s.trim() !== '')
  if (blocks.length === 0) return null
  return callout('quote', '思考过程', blocks.join('\n\n'), true)
}

function renderImageAsset(p: ImageAssetPart, ctx: RenderCtx): { block: string; fileId: string | null } {
  const pointer = typeof p.asset_pointer === 'string' ? p.asset_pointer : ''
  const fileId = pointer.split('//')[1] ?? ''
  if (!fileId) {
    // 没有可下载指针的多模态 part（音频等）：塞原始 JSON，不丢内容
    return {
      block: callout(
        'warning',
        `未识别的多模态 part \`${p.content_type}\`（原始 JSON）`,
        fence(JSON.stringify(p, null, 2), 'json'),
        true,
      ),
      fileId: null,
    }
  }
  ctx.assets.push({
    fileId,
    kind: 'image',
    sizeBytes: typeof p.size_bytes === 'number' ? p.size_bytes : undefined,
  })
  return { block: assetToken(fileId), fileId }
}

function registerFileAsset(a: AttachmentMeta, ctx: RenderCtx): string {
  ctx.assets.push({
    fileId: a.id,
    kind: 'file',
    name: a.name ?? undefined,
    sizeBytes: typeof a.size === 'number' ? a.size : undefined,
    mime: a.mime_type ?? undefined,
  })
  return assetToken(a.id)
}

function joinTextParts(c: MessageContent): string {
  return (c.parts ?? []).filter((p): p is string => typeof p === 'string').join('\n')
}

function codeLanguage(c: MessageContent, recipient: string): string {
  const lang = (c.language ?? '').trim()
  if (lang && lang !== 'unknown') return lang
  return recipient === 'python' ? 'python' : ''
}

function fence(code: string, lang = ''): string {
  // 围栏比内容里最长的反引号串再长一格，避免被内容截断
  const longest = (code.match(/`+/g) ?? []).reduce((n, run) => Math.max(n, run.length), 2)
  const f = '`'.repeat(Math.max(3, longest + 1))
  return `${f}${lang}\n${code.replace(/\n$/, '')}\n${f}`
}

function callout(type: string, title: string, body: string, folded = false): string {
  const head = `> [!${type}]${folded ? '-' : ''} ${title}`
  const quoted = body
    .split('\n')
    .map(l => (l === '' ? '>' : `> ${l}`))
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

function escapeLinkLabel(s: string): string {
  return s.replace(/([[\]])/g, '\\$1')
}

function yamlQuote(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function toIso(t: number | string | null | undefined): string {
  if (t == null || t === '') return ''
  const d = typeof t === 'number' ? new Date(t * 1000) : new Date(t)
  return Number.isNaN(d.getTime()) ? '' : d.toISOString()
}
