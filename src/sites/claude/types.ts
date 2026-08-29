// claude.ai 内部 API 是非官方接口，字段随时可能变：类型一律从宽，未知字段用索引签名兜住。
//
// 契约来源：现有开源导出器的实现与其维护文档（2026-07 记录），尚未在本项目里
// 端到端实测。凡是本文件里带 “[待测]” 的字段，都要在真实会话上确认后再收紧类型。

export interface ClaudeOrganization {
  uuid: string
  name?: string | null
  [k: string]: unknown
}

export interface ClaudeConversationListItem {
  uuid: string
  name?: string | null
  created_at?: string | null
  updated_at?: string | null
  model?: string | null
  [k: string]: unknown
}

export interface ClaudeCitation {
  url?: string | null
  title?: string | null
  /** 被引用的原文片段（最多约 150 字符） */
  cited_text?: string | null
  metadata?: { site_domain?: string; site_name?: string; [k: string]: unknown } | null
  /** 搜索结果 URL 可能已失效——过期的不写进笔记，避免制造死链 */
  is_expired?: boolean
  [k: string]: unknown
}

export interface ClaudeContentBlock {
  /** text | thinking | tool_use | tool_result，以及未来可能新增的类型 */
  type: string
  text?: string | null
  /** thinking 块的正文 [待测：字段名可能是 thinking 或 text] */
  thinking?: string | null
  /** thinking 块的分段摘要 [待测] */
  summaries?: Array<{ summary?: string | null; [k: string]: unknown }> | null
  /** tool_use 的工具名：artifacts / create_file / present_files / visualize:show_widget / web_search … */
  name?: string | null
  input?: Record<string, unknown> | null
  /** tool_result 的载荷，形态随工具而异 */
  content?: unknown
  is_error?: boolean
  citations?: ClaudeCitation[] | null
  [k: string]: unknown
}

export interface ClaudeFile {
  file_kind?: string | null
  file_name?: string | null
  file_uuid?: string | null
  uuid?: string | null
  /** 图片预览地址（同源 claude.ai，登录态绑定） */
  preview_url?: string | null
  preview_asset?: { url?: string | null; [k: string]: unknown } | null
  document_asset?: { url?: string | null; page_count?: number | null; [k: string]: unknown } | null
  size_bytes?: number | null
  [k: string]: unknown
}

/** 文本抽取型附件：没有下载地址，但正文本身就在 extracted_content 里 */
export interface ClaudeAttachment {
  file_name?: string | null
  name?: string | null
  file_type?: string | null
  file_size?: number | null
  extracted_content?: string | null
  [k: string]: unknown
}

export interface ClaudeMessage {
  uuid: string
  parent_message_uuid?: string | null
  /** current_leaf 缺失时的兜底排序 */
  index?: number | null
  sender: string
  created_at?: string | null
  updated_at?: string | null
  /** 该 rendering mode 下顶层 text 为空，正文一律读 content 块 */
  text?: string | null
  content?: ClaudeContentBlock[] | null
  files?: ClaudeFile[] | null
  attachments?: ClaudeAttachment[] | null
  /** 服务端标记；触发条件未知，出现时在正文里如实标注，不臆断内容缺失 */
  truncated?: boolean
  /** assistant 专有；'user_canceled' = 用户主动停止，属正常结束而非异常 */
  stop_reason?: string | null
  [k: string]: unknown
}

export interface ClaudeConversation {
  uuid?: string
  name?: string | null
  model?: string | null
  created_at?: string | null
  updated_at?: string | null
  /** 当前分支的末端，驱动主线定位 */
  current_leaf_message_uuid?: string | null
  chat_messages?: ClaudeMessage[]
  /** Projects 归属 [待测：字段名] */
  project_uuid?: string | null
  project?: { uuid?: string | null; name?: string | null } | null
  [k: string]: unknown
}

/** Claude 会话级 Wiggle 沙箱里的文件。 */
export interface ClaudeSandboxFile {
  path: string
  size?: number | null
  content_type?: string | null
  created_at?: string | null
  custom_metadata?: Record<string, unknown> | null
  /** 由 API 层根据 org / conversation / path 生成的同源下载地址。 */
  download_url: string
  [k: string]: unknown
}

export interface ClaudeIRContext {
  sandboxFiles: ClaudeSandboxFile[]
  /** 清单请求失败时降级导出正文，并在 present_files 位置留明确说明。 */
  sandboxUnavailable?: boolean
}
