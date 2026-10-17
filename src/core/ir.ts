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
  /** 文件身份：下载与落盘按它去重；同一文件在正文里可以出现多次 */
  fileId: string
  kind: 'image' | 'file'
  name?: string
  /** 正文行内链接的原显示文字（纯文本）；同一文件的不同引用处可以各不相同 */
  label?: string
  sizeBytes?: number
  mime?: string
  /**
   * 站点特定的下载线索：ChatGPT 上传件走 files 接口（无 url），代码解释器生成件给
   * interpreter/download 地址；Claude 直接给同源地址
   */
  url?: string
}

export type IRBlock =
  /**
   * 正文：走公式 + 标题变换管道。sources 在块被渲染时并入文末汇总。
   * assets 是正文里的行内附件链接：text 中以 inlineAssetMarker(i) 占住 assets[i] 的位置。
   */
  | { kind: 'prose'; text: string; sources?: SourceLink[]; assets?: AssetRef[] }
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

// 行内附件占位用私有区码点界定，公式与标题变换都不会改动它们。生产方须保证原文
// 不含这两个码点（ChatGPT 的引用还原会剥离全部私有区字符）。源码里不写不可见字面量。
const MARKER_OPEN = String.fromCharCode(0xe010)
const MARKER_CLOSE = String.fromCharCode(0xe011)
const MARKER = new RegExp(`${MARKER_OPEN}(\\d+)${MARKER_CLOSE}`, 'g')

export const inlineAssetMarker = (index: number): string => `${MARKER_OPEN}${index}${MARKER_CLOSE}`

/** 把 prose 文本里的行内附件占位逐个换成 replace(index) 的结果。 */
export function replaceInlineAssetMarkers(text: string, replace: (index: number) => string): string {
  return text.replace(MARKER, (_marker, index: string) => replace(Number(index)))
}

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
  /** 附件清单未能获取：正文可保存，但请求附件的导出不能记为完整成功。 */
  assetDiscoveryFailed?: boolean
}
