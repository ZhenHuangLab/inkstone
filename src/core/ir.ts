// 站点无关的中间表示（IR）。
//
// 各站点的 adapter 负责把自家的对话 JSON 解成 IR，core/render 只认 IR。
// 这条分界线的意义：ChatGPT 与 Claude 的原始结构差异极大（一条消息一种
// content_type vs 一条消息多个 typed block 按序交错），但**渲染出的 Markdown
// 形态是同一套**——轮次标题、折叠 callout、围栏、附件占位、frontmatter。
// 把后者收敛到一处，两个站点才可能共用排版、共用设置、共用离线 CLI。
//
// 设计约束：IR 里的 prose 是「已还原引用、但未做公式/标题变换」的文本。
// 引用还原是站点特定的（ChatGPT 的私有区标记 vs Claude 的结构化数组），
// 公式与标题变换是通用的，所以前者归 adapter，后者归 render。

export interface SourceLink {
  title: string
  url: string
}

export interface AssetRef {
  fileId: string
  kind: 'image' | 'file'
  name?: string
  sizeBytes?: number
  mime?: string
  /** 站点特定的下载线索：ChatGPT 走 files 接口换签名 URL，Claude 直接给同源地址 */
  url?: string
}

export type IRBlock =
  /** 正文：走公式 + 标题变换管道。sources 在块被渲染时并入文末汇总 */
  | { kind: 'prose'; text: string; sources?: SourceLink[] }
  /** 思维链：受 thoughts 开关控制，渲染为折叠 callout。关掉时其 sources 也不收集 */
  | { kind: 'thinking'; items: Array<{ summary?: string; text: string }>; sources?: SourceLink[] }
  /**
   * 工具痕迹：默认受 toolTraces 开关控制（gated: false 则无条件写入——
   * Canvas 重放失败的原始 JSON 兜底走这条，属于「不丢内容」而非「工具痕迹」）。
   * fenced: false 时 body 原样进 callout，不套围栏。
   */
  | {
      kind: 'tool'
      title: string
      body: string
      lang?: string
      tone?: 'example' | 'note'
      gated?: boolean
      fenced?: boolean
    }
  /** 富文档终稿（ChatGPT Canvas / Claude Artifact）：展开的 callout */
  | { kind: 'document'; label: string; docType: string; content: string }
  /** 单个附件占位（图片内联） */
  | { kind: 'asset'; ref: AssetRef }
  /** 附件清单（每行一个，带 `- ` 前缀） */
  | { kind: 'assetList'; refs: AssetRef[] }
  /** 原样输出的短说明，不走任何变换 */
  | { kind: 'note'; text: string }
  /** 未识别内容的兜底：原始 JSON 塞进折叠 callout，永不静默丢内容 */
  | { kind: 'raw'; label: string; json: unknown }

export interface IRTurn {
  role: 'user' | 'assistant'
  blocks: IRBlock[]
}

export interface IRConversation {
  source: 'chatgpt' | 'claude'
  id: string
  title: string
  /** frontmatter 里的原对话地址 */
  url: string
  /** ISO 字符串，取不到时空串（frontmatter 仍保留该行，与既有行为一致） */
  created: string
  updated: string
  model?: string
  /** 中途切换过模型时的完整列表（长度 > 1 才写进 frontmatter） */
  models?: string[]
  /** 额外 frontmatter 行，值须是已成形的 YAML 片段；插在 models 与 tags 之间 */
  extra?: Array<[key: string, value: string]>
  tags: string[]
  /** assistant 轮次的标题文字：ChatGPT / Claude */
  assistantHeading: string
  turns: IRTurn[]
}
