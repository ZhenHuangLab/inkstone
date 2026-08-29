// ChatGPT backend-api 是非官方接口，字段随时可能变：类型一律从宽，未知字段用索引签名兜住。

export interface SessionResponse {
  accessToken?: string
  [k: string]: unknown
}

export interface ConversationListItem {
  id: string
  title: string | null
  // 列表接口给 ISO 字符串，详情接口给 epoch 秒，两种都收
  create_time?: string | number | null
  update_time?: string | number | null
  /** 归属的 gizmo：project 为 `g-p-…`，自定义 GPT 为 `g-…`；普通对话为空 */
  gizmo_id?: string | null
  [k: string]: unknown
}

export interface ConversationListPage {
  items: ConversationListItem[]
  total: number
  offset: number
  limit: number
  [k: string]: unknown
}

/** Projects 在后端叫 gizmo；这里只留导出需要的 id + 名字。 */
export interface ProjectInfo {
  id: string
  name: string
}

/** `/backend-api/gizmos/snorlax/sidebar`：project 列表，cursor 为数字，null = 到底。 */
export interface GizmoSidebarPage {
  cursor?: number | null
  items?: Array<{
    // 双层 gizmo 嵌套是接口原样，不是笔误
    gizmo?: { gizmo?: { id?: string; display?: { name?: string | null } | null } | null } | null
    [k: string]: unknown
  }>
  [k: string]: unknown
}

/** `/backend-api/gizmos/<id>/conversations`：cursor 是字符串游标（不是 offset），null = 到底。 */
export interface GizmoConversationsPage {
  items?: ConversationListItem[]
  cursor?: string | null
  [k: string]: unknown
}

export interface Author {
  role: 'user' | 'assistant' | 'system' | 'tool'
  name?: string | null
  metadata?: Record<string, unknown>
}

export interface ImageAssetPart {
  content_type: string
  asset_pointer?: string
  width?: number | null
  height?: number | null
  [k: string]: unknown
}

export type MultimodalPart = string | ImageAssetPart

export interface Thought {
  summary?: string
  content?: string
  [k: string]: unknown
}

export interface MessageContent {
  content_type: string
  parts?: MultimodalPart[]
  text?: string
  language?: string | null
  thoughts?: Thought[]
  [k: string]: unknown
}

export interface ContentReferenceItem {
  title?: string | null
  url?: string | null
  attribution?: string | null
  snippet?: string | null
  // 官方导出 zip：定位标记 token 的结构化字段（backend-api 用 matched_text，导出包里没有）
  refs?: Array<{ ref_index?: number; ref_type?: string; turn_index?: number; [k: string]: unknown }>
  [k: string]: unknown
}

export interface ContentReference {
  matched_text?: string
  type?: string
  alt?: string | null
  name?: string | null // type=file 时的文件名
  items?: ContentReferenceItem[]
  fallback_items?: ContentReferenceItem[]
  // 官方导出 zip：type=file 的引用用它定位 filecite 标记
  input_pointer?: { message_index?: number; file_index?: number; [k: string]: unknown } | null
  [k: string]: unknown
}

export interface AttachmentMeta {
  id: string
  name?: string | null
  mime_type?: string | null
  size?: number | null
  [k: string]: unknown
}

export interface MessageMetadata {
  is_visually_hidden_from_conversation?: boolean
  model_slug?: string
  content_references?: ContentReference[]
  attachments?: AttachmentMeta[]
  // Branch · 对话：分支来源在消息级 metadata 上
  branching_from_conversation_id?: string
  branching_from_conversation_title?: string | null
  [k: string]: unknown
}

export interface Message {
  id: string
  author: Author
  create_time?: number | null
  update_time?: number | null
  content: MessageContent
  status?: string
  end_turn?: boolean | null
  recipient?: string
  metadata?: MessageMetadata
  [k: string]: unknown
}

export interface MappingNode {
  id: string
  message?: Message | null
  parent?: string | null
  // 官方导出 zip 的 mapping 节点没有 children，只有 parent 链
  children?: string[]
}

export interface ConversationDetail {
  title?: string | null
  create_time?: number | null
  update_time?: number | null
  mapping: Record<string, MappingNode>
  current_node?: string | null
  conversation_id?: string
  default_model_slug?: string | null
  /** 归属的 gizmo（project / 自定义 GPT）；详情接口自带，无需查列表 */
  gizmo_id?: string | null
  [k: string]: unknown
}
