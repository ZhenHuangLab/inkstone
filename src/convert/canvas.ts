// Canvas（canmore 工具）patch 重放：create_textdoc 建稿、update_textdoc 按正则 patch，
// 重放到主线末尾即网页所见终稿。任何一步解析/匹配失败都放弃该文档的后续重放，
// 由调用方回退到原始 JSON 折叠嵌入——宁可啰嗦，不可失真。

import type { Message } from '../types'

export type CanvasOpKind = 'create' | 'update' | 'comment'

export interface CanvasComment {
  pattern: string
  comment: string
}

export interface CanvasOp {
  kind: CanvasOpKind
  docName: string
  /** canmore 的 type：document / code/python / code/react … */
  docType: string
  /** 仅当本条是该文档最后一次成功的内容变更：重放出的终稿，调用方在此处整块嵌入 */
  finalContent?: string
  comments?: CanvasComment[]
}

/**
 * 沿线性化后的主线重放全部 canmore 操作。
 * 返回 msgId → CanvasOp；不在 map 里的 canmore 消息表示重放失败，调用方走原始 JSON 兜底。
 */
export function replayCanvas(messages: readonly Message[]): Map<string, CanvasOp> {
  interface DocState {
    name: string
    type: string
    content: string
    /** 某次 update 重放失败后不再信任后续状态，终稿停在最后一次成功处 */
    broken: boolean
    lastGoodMsgId: string
  }

  const ops = new Map<string, CanvasOp>()
  const docs: DocState[] = []
  let current: DocState | null = null

  for (const msg of messages) {
    const recipient = msg.recipient ?? 'all'
    if (msg.author.role !== 'assistant' || !recipient.startsWith('canmore.')) continue
    const raw = (msg.content.parts ?? [])
      .filter((p): p is string => typeof p === 'string')
      .join('\n')
      .trim()
    const payload = parseJson(raw)
    if (payload == null) continue

    if (recipient === 'canmore.create_textdoc') {
      if (typeof payload['content'] !== 'string') continue
      current = {
        name: typeof payload['name'] === 'string' && payload['name'] !== '' ? payload['name'] : 'untitled',
        type: typeof payload['type'] === 'string' && payload['type'] !== '' ? payload['type'] : 'document',
        content: payload['content'],
        broken: false,
        lastGoodMsgId: msg.id,
      }
      docs.push(current)
      ops.set(msg.id, { kind: 'create', docName: current.name, docType: current.type })
    } else if (recipient === 'canmore.update_textdoc') {
      // update 不带文档 id，作用于最近活跃的 textdoc
      if (!current || current.broken) continue
      const updates = Array.isArray(payload['updates']) ? (payload['updates'] as unknown[]) : null
      if (!updates || updates.length === 0) continue
      let content: string | null = current.content
      for (const u of updates) {
        content = content == null ? null : applyUpdate(content, u)
      }
      if (content == null) {
        current.broken = true
        continue
      }
      current.content = content
      current.lastGoodMsgId = msg.id
      ops.set(msg.id, { kind: 'update', docName: current.name, docType: current.type })
    } else if (recipient === 'canmore.comment_textdoc') {
      const comments = (Array.isArray(payload['comments']) ? (payload['comments'] as unknown[]) : [])
        .filter((c): c is Record<string, unknown> => c != null && typeof c === 'object')
        .map((c) => ({
          pattern: typeof c['pattern'] === 'string' ? c['pattern'] : '',
          comment: typeof c['comment'] === 'string' ? c['comment'] : '',
        }))
        .filter((c) => c.comment !== '')
      if (comments.length === 0) continue
      ops.set(msg.id, {
        kind: 'comment',
        docName: current?.name ?? '',
        docType: current?.type ?? 'document',
        comments,
      })
    }
  }

  // 每个文档最后一次成功的内容变更处嵌入终稿
  for (const doc of docs) {
    const op = ops.get(doc.lastGoodMsgId)
    if (op) op.finalContent = doc.content
  }
  return ops
}

/**
 * 重放单条 update。canmore 的 pattern 是 Python 风格 dotall 正则；
 * 与 JS 语义存疑的一律返回 null（反向引用替换、编译失败、匹配不到）。
 */
function applyUpdate(content: string, u: unknown): string | null {
  if (u == null || typeof u !== 'object') return null
  const upd = u as Record<string, unknown>
  const rawPattern = upd['pattern']
  const replacement = upd['replacement']
  if (typeof rawPattern !== 'string' || typeof replacement !== 'string') return null
  // Python 的 \1 组引用无法可靠翻译成 JS 的 $1，不硬猜
  if (/\\\d/.test(replacement)) return null

  let pattern = rawPattern
  let flags = 's'
  const inline = /^\(\?([a-zA-Z]+)\)/.exec(pattern)
  if (inline) {
    pattern = pattern.slice(inline[0].length)
    for (const ch of inline[1]!) {
      if (ch === 'i' || ch === 'm') flags += ch
      else if (ch !== 's') return null // 其余 Python 旗标（x/a/L…）不装懂
    }
  }
  if (upd['multiple'] === true) flags += 'g'

  let re: RegExp
  try {
    re = new RegExp(pattern, flags)
  } catch {
    return null
  }
  if (!re.test(content)) return null
  re.lastIndex = 0
  // $ 在 JS replacement 里有特殊含义，转义后按字面量替换
  return content.replace(re, replacement.replace(/\$/g, '$$$$'))
}

function parseJson(raw: string): Record<string, unknown> | null {
  if (!raw.startsWith('{')) return null
  try {
    const v: unknown = JSON.parse(raw)
    return v != null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}
