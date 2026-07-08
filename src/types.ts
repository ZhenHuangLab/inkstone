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
  [k: string]: unknown
}

export interface ConversationListPage {
  items: ConversationListItem[]
  total: number
  offset: number
  limit: number
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

export interface MessageMetadata {
  is_visually_hidden_from_conversation?: boolean
  model_slug?: string
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
  children: string[]
}

export interface ConversationDetail {
  title?: string | null
  create_time?: number | null
  update_time?: number | null
  mapping: Record<string, MappingNode>
  current_node?: string | null
  conversation_id?: string
  default_model_slug?: string | null
  [k: string]: unknown
}
