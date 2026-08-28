// claude.ai 内部 API JSON → IR。
//
// 与 ChatGPT adapter 的结构性差异：那边一条消息只有一种 content_type，这边一条
// 消息是多个 typed block 按序交错（text / thinking / tool_use / tool_result），
// 所以分发发生在块级而不是消息级。产出的 IR 形态两边完全一致。

import type { AssetRef, IRBlock, IRConversation, IRTurn, SourceLink } from '../../core/ir'
import { toIso, yamlQuote } from '../../core/render'
import { artifactDocType, blockKey, replayArtifacts, type ArtifactOp } from './artifacts'
import type { ClaudeContentBlock, ClaudeConversation, ClaudeMessage } from './types'

interface Ctx {
  /** blockKey → 重放成功的 artifact 操作；不在表里的走原始 JSON 兜底 */
  artifacts: Map<string, ArtifactOp>
}

export function conversationToIR(conv: ClaudeConversation, fallbackId = ''): IRConversation {
  const convId = String(conv.uuid ?? fallbackId)
  const title = (conv.name ?? '').trim() || 'Untitled'
  const messages = linearize(conv)
  const ctx: Ctx = { artifacts: replayArtifacts(messages) }

  const turns: IRTurn[] = groupTurns(messages).map((t) => ({
    role: t.role,
    blocks: t.messages.flatMap((m) => messageBlocks(m, ctx)),
  }))

  // Projects：ChatGPT 侧没有的层级，写进 frontmatter 供 Dataview 分组
  const extra: Array<[string, string]> = []
  const projectName = (conv.project?.name ?? '').trim()
  if (projectName) extra.push(['project', yamlQuote(projectName)])

  return {
    source: 'claude',
    id: convId,
    title,
    url: `https://claude.ai/chat/${convId}`,
    created: toIso(conv.created_at),
    updated: toIso(conv.updated_at),
    model: conv.model || undefined,
    extra,
    tags: ['claude'],
    assistantHeading: 'Claude',
    turns,
  }
}

/**
 * 沿 current_leaf_message_uuid 的 parent 链回溯，得到网页上实际可见的主线
 * （重新生成的旧分支不含在内）。leaf 缺失时退回 index 排序——分支对话下可能不准，
 * 但总好过丢消息。
 */
export function linearize(conv: ClaudeConversation): ClaudeMessage[] {
  const all = conv.chat_messages ?? []
  if (all.length === 0) return []

  const byUuid = new Map(all.map((m) => [m.uuid, m]))
  const leaf = conv.current_leaf_message_uuid
  let chain: ClaudeMessage[] | null = null

  if (leaf && byUuid.has(leaf)) {
    const path: ClaudeMessage[] = []
    const seen = new Set<string>()
    let cur: ClaudeMessage | undefined = byUuid.get(leaf)
    while (cur && !seen.has(cur.uuid)) {
      seen.add(cur.uuid)
      path.push(cur)
      cur = cur.parent_message_uuid ? byUuid.get(cur.parent_message_uuid) : undefined
    }
    if (path.length > 0) chain = path.reverse()
  }

  if (!chain) chain = [...all].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
  // 只按 sender 过滤：接口也会返回 UI 从不显示的消息，但内容层面的取舍留给块级，
  // 空块由 render 统一丢弃——不在这里提前判断「有没有内容」，免得误杀
  return chain.filter((m) => m.sender === 'human' || m.sender === 'assistant')
}

interface Turn {
  role: 'user' | 'assistant'
  messages: ClaudeMessage[]
}

/** 相邻同侧消息合并成轮次。 */
export function groupTurns(messages: readonly ClaudeMessage[]): Turn[] {
  const turns: Turn[] = []
  for (const msg of messages) {
    const role: Turn['role'] = msg.sender === 'human' ? 'user' : 'assistant'
    const last = turns[turns.length - 1]
    if (last && last.role === role) last.messages.push(msg)
    else turns.push({ role, messages: [msg] })
  }
  return turns
}

function messageBlocks(msg: ClaudeMessage, ctx: Ctx): IRBlock[] {
  const blocks: IRBlock[] = []
  const content = msg.content ?? []

  for (let i = 0; i < content.length; i++) {
    const b = content[i]!
    switch (b.type) {
      case 'text':
        blocks.push(proseBlock(b))
        break
      case 'thinking':
        blocks.push(thinkingBlock(b))
        break
      case 'tool_use':
        blocks.push(...toolUseBlocks(b, msg.uuid, i, ctx))
        break
      case 'tool_result':
        blocks.push(toolResultBlock(b))
        break
      default:
        // 未知类型：原始 JSON 塞进折叠 callout，永不静默丢内容
        blocks.push({
          kind: 'raw',
          label: `未识别的内容块 \`${b.type}\`（原始 JSON）`,
          json: b,
        })
    }
  }

  blocks.push(...attachmentBlocks(msg))

  // 未完成的回复如实标注，但不替读者下判断：user_canceled 是正常结束（用户自己停的），
  // truncated 的触发条件未经证实，只陈述服务端给了这个标记
  if (msg.stop_reason === 'user_canceled') {
    blocks.push({ kind: 'note', text: '*(这条回复被用户中止)*' })
  }
  if (msg.truncated === true) {
    blocks.push({ kind: 'note', text: '*(服务端将这条消息标记为 truncated)*' })
  }

  return blocks
}

/**
 * 正文 + 引用。
 *
 * 首版只把引用汇总进文末 Sources，正文一字不动：Claude 通常自己就在正文里写了
 * Markdown 链接，行内再插一遍会重复；而 citations 的字符级锚定字段尚未实测，
 * 猜着插入的风险高于收益。等实测确认锚定形态后再做行内还原。
 */
function proseBlock(b: ClaudeContentBlock): IRBlock {
  const sources: SourceLink[] = []
  for (const c of b.citations ?? []) {
    // 过期的搜索结果不写进笔记——死链比没有链接更糟
    if (c.is_expired === true) continue
    const url = str(c.url)
    if (!url) continue
    sources.push({ title: str(c.title) || hostOf(url) || url, url })
  }
  return { kind: 'prose', text: str(b.text), sources }
}

function thinkingBlock(b: ClaudeContentBlock): IRBlock {
  const text = str(b.thinking) || str(b.text)
  const summary =
    (b.summaries ?? [])
      .map((s) => str(s?.summary))
      .filter((s) => s !== '')
      .join(' · ') || undefined
  return { kind: 'thinking', items: [{ summary, text }] }
}

function toolUseBlocks(
  b: ClaudeContentBlock,
  msgUuid: string,
  index: number,
  ctx: Ctx,
): IRBlock[] {
  const name = str(b.name)
  const input = b.input ?? {}

  if (name === 'artifacts') {
    const op = ctx.artifacts.get(blockKey(msgUuid, index))
    if (!op) {
      // 重放失败：原始 JSON 兜底，不随 toolTraces 开关——这是「不丢内容」而非工具痕迹
      return [
        {
          kind: 'tool',
          title: '工具调用 → `artifacts`（重放失败，原始 JSON）',
          body: JSON.stringify(b, null, 2),
          lang: 'json',
          gated: false,
        },
      ]
    }
    if (op.finalContent != null) {
      return [
        {
          kind: 'document',
          label: `Artifact · ${op.title || 'untitled'}`,
          docType: artifactDocType(op.mime, op.language),
          content: op.finalContent,
        },
      ]
    }
    return [
      {
        kind: 'note',
        text:
          op.kind === 'create'
            ? `*(Artifact 创建「${op.title || 'untitled'}」，终稿见后)*`
            : `*(Artifact 更新「${op.title || 'untitled'}」，终稿见后)*`,
      },
    ]
  }

  if (name === 'create_file' && typeof input['file_text'] === 'string') {
    const path = str(input['path']) || 'file'
    return [
      {
        kind: 'document',
        label: `文件 · ${path}`,
        docType: `code/${langOfPath(path)}`,
        content: input['file_text'],
      },
    ]
  }

  if (name === 'visualize:show_widget' && typeof input['widget_code'] === 'string') {
    return [
      {
        kind: 'document',
        label: `Widget · ${str(input['title']) || 'untitled'}`,
        docType: 'code/jsx',
        content: input['widget_code'],
      },
    ]
  }

  // 其余工具（web 搜索、bash、文件读写…）：工具痕迹，随 toolTraces 开关
  return [
    {
      kind: 'tool',
      title: `工具调用 → \`${name || 'unknown'}\``,
      body: JSON.stringify(input, null, 2),
      lang: 'json',
    },
  ]
}

function toolResultBlock(b: ClaudeContentBlock): IRBlock {
  const isText = typeof b.content === 'string'
  return {
    kind: 'tool',
    tone: 'note',
    title: b.is_error === true ? '工具返回（错误）' : '工具返回',
    body: isText ? (b.content as string) : JSON.stringify(b.content ?? null, null, 2),
    lang: isText ? '' : 'json',
  }
}

/**
 * 附件两处来源，按各自实际提供的东西处理：
 *   files[]       —— 上传的原件。图片有 preview_url（内联嵌入），文档有
 *                    document_asset.url（列为链接），blob 类没有可用地址（留说明）
 *   attachments[] —— 文本抽取件（.md/.docx/…）。没有地址，但正文就在
 *                    extracted_content 里，整块嵌进展开的 callout —— 附件自身的
 *                    标题因此不会进文档大纲，导出的笔记对全文检索是自包含的
 */
function attachmentBlocks(msg: ClaudeMessage): IRBlock[] {
  const out: IRBlock[] = []
  const fileRefs: AssetRef[] = []

  for (const f of msg.files ?? []) {
    const name = str(f.file_name) || 'file'
    const size = typeof f.size_bytes === 'number' ? f.size_bytes : undefined
    const kind = str(f.file_kind)

    if (kind === 'image') {
      const url = str(f.preview_url) || str(f.preview_asset?.url)
      if (url) {
        out.push({ kind: 'asset', ref: { fileId: assetId(f, url), kind: 'image', name, url, sizeBytes: size } })
        continue
      }
    } else if (kind === 'document') {
      const url = str(f.document_asset?.url)
      if (url) {
        fileRefs.push({ fileId: assetId(f, url), kind: 'file', name, url, sizeBytes: size })
        continue
      }
    }
    // blob（音频等）与拿不到地址的：留名字，不假装能下载
    out.push({ kind: 'note', text: `*(附件：${name}${kind ? ` · ${kind}` : ''} — 无可下载地址)*` })
  }

  if (fileRefs.length > 0) out.push({ kind: 'assetList', refs: fileRefs })

  for (const a of msg.attachments ?? []) {
    const name = str(a.file_name) || str(a.name) || 'attachment'
    const content = str(a.extracted_content).trim()
    if (content === '') {
      out.push({ kind: 'note', text: `*(附件：${name})*` })
      continue
    }
    out.push({
      kind: 'document',
      label: `附件 · ${name}（文本抽取）`,
      docType: 'document',
      content,
    })
  }

  return out
}

/** 附件在正文里的占位键：优先用服务端 uuid，缺失时用地址兜底（同一附件只下载一次）。 */
function assetId(f: { file_uuid?: string | null; uuid?: string | null }, url: string): string {
  return str(f.file_uuid) || str(f.uuid) || url
}

const EXT_LANG: Record<string, string> = {
  py: 'python',
  js: 'javascript',
  jsx: 'jsx',
  ts: 'typescript',
  tsx: 'tsx',
  md: 'markdown',
  html: 'html',
  css: 'css',
  json: 'json',
  sh: 'bash',
  yml: 'yaml',
  yaml: 'yaml',
  sql: 'sql',
  java: 'java',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  c: 'c',
  cpp: 'cpp',
  txt: '',
}

function langOfPath(path: string): string {
  const file = path.split('/').pop() ?? path
  const ext = file.includes('.') ? file.split('.').pop()!.toLowerCase() : ''
  return EXT_LANG[ext] ?? ''
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}
