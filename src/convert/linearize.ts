import type { ConversationDetail, MappingNode, Message } from '../types'

/** 沿 current_node 回溯到根，得到网页上实际可见的主线消息序列（编辑/重新生成的旧分支不含在内）。 */
export function linearize(conv: ConversationDetail): Message[] {
  const mapping = conv.mapping ?? {}
  let cursor: string | null = conv.current_node ?? findLatestLeaf(mapping)
  const chain: Message[] = []
  const seen = new Set<string>()
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor)
    const node: MappingNode | undefined = mapping[cursor]
    if (!node) break
    if (node.message) chain.push(node.message)
    cursor = node.parent ?? null
  }
  chain.reverse()
  return chain.filter(isVisible)
}

// current_node 缺失时兜底：取 create_time 最新的叶子
function findLatestLeaf(mapping: Record<string, MappingNode>): string | null {
  let best: string | null = null
  let bestTime = -Infinity
  for (const [id, node] of Object.entries(mapping)) {
    if (node.children.length > 0) continue
    const t = node.message?.create_time ?? 0
    if (t >= bestTime) {
      bestTime = t
      best = id
    }
  }
  return best
}

export function isVisible(msg: Message): boolean {
  if (msg.metadata?.is_visually_hidden_from_conversation) return false
  if (msg.author?.role === 'system') return false
  const c = msg.content
  const ct = c?.content_type
  // 自定义指令 / 模型侧上下文注入
  if (ct === 'user_editable_context' || ct === 'model_editable_context') return false
  // “Thought for Xs” 一句话摘要，无内容价值
  if (ct === 'reasoning_recap') return false
  if (ct === 'text' || ct === 'multimodal_text') {
    const parts = c.parts ?? []
    if (parts.length === 0) return false
    if (parts.every(p => typeof p === 'string' && p.trim() === '')) return false
  }
  return true
}

export interface Turn {
  role: 'user' | 'assistant'
  messages: Message[]
}

/** 相邻同侧消息合并成轮次：assistant / tool 都归入 ChatGPT 轮。 */
export function groupTurns(messages: Message[]): Turn[] {
  const turns: Turn[] = []
  for (const msg of messages) {
    const role: Turn['role'] = msg.author?.role === 'user' ? 'user' : 'assistant'
    const last = turns[turns.length - 1]
    if (last && last.role === role) last.messages.push(msg)
    else turns.push({ role, messages: [msg] })
  }
  return turns
}
