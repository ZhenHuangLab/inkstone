// ChatGPT backend-api JSON → IR。
//
// 这里是 ChatGPT 数据模型的全部知识所在：content_type 分发、recipient 语义、
// canmore（Canvas）重放、私有区引用标记还原。core/render 对这些一无所知。

import { replayCanvas, type CanvasOp } from '../../convert/canvas'
import { restoreCitations, stripResidualMarkers } from '../../convert/citations'
import { groupTurns, linearize } from '../../convert/linearize'
import type { AssetRef, IRBlock, IRConversation, IRTurn, SourceLink } from '../../core/ir'
import { filenameFor, toIso, yamlQuote } from '../../core/render'
import type {
  AttachmentMeta,
  ContentReference,
  ConversationDetail,
  ImageAssetPart,
  Message,
  MessageContent,
} from '../../types'

interface Ctx {
  /** msgId → 重放成功的 Canvas 操作；重放失败的 canmore 消息走原始 JSON 兜底 */
  canvas: Map<string, CanvasOp>
}

export function conversationToIR(conv: ConversationDetail, fallbackId = ''): IRConversation {
  const convId = String(conv.conversation_id ?? conv.id ?? fallbackId)
  const title = (conv.title ?? '').trim() || 'Untitled'
  const messages = linearize(conv)

  // 消息级 model_slug 才是实际生成回复的模型（default_model_slug 只是对话的默认档位，仅作回退）；
  // 中途切换过模型时以最后一条为准——须在去重前取（Set 保留首现顺序，A→B→A 会错取 B），
  // 去重序列只用于 models 列表
  const rawSlugs = messages
    .filter((m) => m.author.role === 'assistant' && m.metadata?.model_slug)
    .map((m) => m.metadata!.model_slug!)
  const modelSlugs = [...new Set(rawSlugs)]
  const model = rawSlugs[rawSlugs.length - 1] ?? conv.default_model_slug

  const ctx: Ctx = { canvas: replayCanvas(messages) }
  const turns: IRTurn[] = groupTurns(messages).map((t) => ({
    role: t.role,
    blocks: t.messages.flatMap((m) => messageBlocks(m, ctx)),
  }))

  // Branch · 对话：链接回父对话的导出文件（文件名规则可预测），Obsidian 图谱直接连起来
  const branchMeta = messages.map((m) => m.metadata).find((md) => md?.branching_from_conversation_id)
  const extra: Array<[string, string]> = []
  if (branchMeta) {
    const branchedFrom = filenameFor(
      branchMeta.branching_from_conversation_title ?? '',
      branchMeta.branching_from_conversation_id!,
    ).replace(/\.md$/, '')
    extra.push(['branched_from', yamlQuote(`[[${branchedFrom}]]`)])
    extra.push([
      'branched_from_url',
      `https://chatgpt.com/c/${branchMeta.branching_from_conversation_id}`,
    ])
  }

  return {
    source: 'chatgpt',
    id: convId,
    title,
    url: `https://chatgpt.com/c/${convId}`,
    created: toIso(conv.create_time),
    updated: toIso(conv.update_time),
    model: model || undefined,
    models: modelSlugs,
    extra,
    tags: ['chatgpt'],
    assistantHeading: 'ChatGPT',
    turns,
  }
}

function messageBlocks(msg: Message, ctx: Ctx): IRBlock[] {
  const c = msg.content
  const recipient = msg.recipient ?? 'all'
  const refs = msg.metadata?.content_references
  const blocks: IRBlock[] = []
  const inlineImageIds = new Set<string>()

  // canmore 工具的确认回执（role=tool）：内容已由重放侧呈现，不重复
  if (msg.author.role === 'tool' && (msg.author.name ?? '').startsWith('canmore.')) return []

  switch (c.content_type) {
    case 'text': {
      const raw = joinTextParts(c)
      if (msg.author.role === 'assistant' && recipient.startsWith('canmore.')) {
        // Canvas：patch 重放还原终稿；重放失败回退原始 JSON 折叠嵌入
        const op = ctx.canvas.get(msg.id)
        if (op) {
          blocks.push(canvasBlock(op))
        } else {
          blocks.push({
            kind: 'tool',
            title: `工具调用 → \`${recipient}\``,
            body: stripResidualMarkers(raw),
            gated: false, // 兜底不丢内容，不随 toolTraces 开关
          })
        }
      } else if (msg.author.role === 'assistant' && recipient !== 'all') {
        // 联网等其他工具调用载荷（多为 JSON）：默认不写入，toolTraces 打开时整块折叠嵌入
        blocks.push({
          kind: 'tool',
          title: `工具调用 → \`${recipient}\``,
          body: stripResidualMarkers(raw),
        })
      } else {
        blocks.push(proseBlock(raw, refs))
      }
      break
    }

    case 'multimodal_text':
      for (const p of c.parts ?? []) {
        if (typeof p === 'string') {
          blocks.push(proseBlock(p, refs))
        } else {
          const { block, fileId } = imageAssetBlock(p)
          blocks.push(block)
          if (fileId) inlineImageIds.add(fileId)
        }
      }
      break

    case 'code':
      // content_type=code 都是工具调用载荷（代码解释器 python、联网检索 search_query/open/click 等），
      // 随 toolTraces 开关；折叠 callout 包裹，与其他工具痕迹一致
      blocks.push({
        kind: 'tool',
        title: `工具调用 → \`${recipient}\``,
        body: c.text ?? '',
        lang: codeLanguage(c, recipient),
      })
      break

    case 'execution_output':
      blocks.push({
        kind: 'tool',
        tone: 'note',
        title: '运行输出',
        body: stripResidualMarkers(c.text ?? ''),
      })
      break

    case 'thoughts': {
      const sources: SourceLink[] = []
      const items = (c.thoughts ?? []).map((t) => {
        const restored = restoreCitations(t.content ?? '', refs)
        sources.push(...restored.sources)
        return { summary: t.summary, text: restored.text }
      })
      blocks.push({ kind: 'thinking', items, sources })
      break
    }

    default:
      // 未知类型：原始 JSON 塞进折叠 callout，永不静默丢内容
      blocks.push({
        kind: 'raw',
        label: `未识别的内容类型 \`${c.content_type}\`（原始 JSON）`,
        json: c,
      })
  }

  // 用户上传的附件（图片已在正文里内联的不重复列出）
  const attachments = (msg.metadata?.attachments ?? []).filter(
    (a) => a?.id && !inlineImageIds.has(a.id),
  )
  if (attachments.length > 0) {
    blocks.push({ kind: 'assetList', refs: attachments.map(fileAssetRef) })
  }

  return blocks
}

function proseBlock(raw: string, refs: ContentReference[] | undefined): IRBlock {
  const { text, sources } = restoreCitations(raw, refs)
  return { kind: 'prose', text, sources }
}

/** Canvas 操作的呈现：终稿整块嵌入，中间版本一行说明。 */
function canvasBlock(op: CanvasOp): IRBlock {
  if (op.kind === 'comment') {
    return {
      kind: 'tool',
      title: `Canvas 批注${op.docName ? ` · ${op.docName}` : ''}`,
      body: (op.comments ?? []).map((c) => `- ${c.comment}`).join('\n'),
      gated: false,
      fenced: false,
    }
  }
  if (op.finalContent != null) {
    return {
      kind: 'document',
      label: `Canvas · ${op.docName}`,
      docType: op.docType,
      content: op.finalContent,
    }
  }
  return {
    kind: 'note',
    text:
      op.kind === 'create'
        ? `*(Canvas 创建「${op.docName}」，终稿见后)*`
        : `*(Canvas 更新「${op.docName}」，终稿见后)*`,
  }
}

function imageAssetBlock(p: ImageAssetPart): { block: IRBlock; fileId: string | null } {
  const pointer = typeof p.asset_pointer === 'string' ? p.asset_pointer : ''
  const fileId = pointer.split('//')[1] ?? ''
  if (!fileId) {
    // 没有可下载指针的多模态 part（音频等）：塞原始 JSON，不丢内容
    return {
      block: {
        kind: 'raw',
        label: `未识别的多模态 part \`${p.content_type}\`（原始 JSON）`,
        json: p,
      },
      fileId: null,
    }
  }
  return {
    block: {
      kind: 'asset',
      ref: {
        fileId,
        kind: 'image',
        sizeBytes: typeof p.size_bytes === 'number' ? p.size_bytes : undefined,
      },
    },
    fileId,
  }
}

function fileAssetRef(a: AttachmentMeta): AssetRef {
  return {
    fileId: a.id,
    kind: 'file',
    name: a.name ?? undefined,
    sizeBytes: typeof a.size === 'number' ? a.size : undefined,
    mime: a.mime_type ?? undefined,
  }
}

function joinTextParts(c: MessageContent): string {
  return (c.parts ?? []).filter((p): p is string => typeof p === 'string').join('\n')
}

function codeLanguage(c: MessageContent, recipient: string): string {
  const lang = (c.language ?? '').trim()
  if (lang && lang !== 'unknown') return lang
  return recipient === 'python' ? 'python' : ''
}
