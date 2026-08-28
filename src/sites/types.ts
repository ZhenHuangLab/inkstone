// 站点适配器接口：编排层（main.ts）与界面层（ui.ts）只认这个契约，
// 不认任何一家的端点、字段或 DOM。新增一个站点 = 新增一个实现，不改编排。

import type { AssetRef, IRConversation } from '../core/ir'
import type { CancelToken, FetchStats } from '../core/fetcher'

export type SiteId = 'chatgpt' | 'claude'

export interface AssetPayload {
  bytes: Uint8Array
  /** 服务端给出的原始文件名，取不到时 null（调用方回退 AssetRef.name） */
  filename: string | null
  contentType: string | null
}

export type Rgb = [number, number, number]

/** 站点专属的界面锚定与配色探测——唯一需要认识对方 DOM 的地方。 */
export interface SiteUi {
  /** 顶栏锚点（贴在分享按钮左侧，面板向下展开）；找不到返回 null */
  headerAnchor(): HTMLElement | null
  /** 输入框锚点（贴在输入框旁，面板向上展开）；找不到返回 null */
  composerAnchor(): HTMLElement | null
  /** 页面是否处于暗色 */
  isDark(): boolean
  /** 需要监听的根元素属性，变化时重新同步主题 */
  themeAttributes: string[]
  /**
   * 站点专属主色。返回 null 时由界面层走通用兜底（扫描含 accent 的自定义属性）。
   * bg = 主色底，fg = 其上的文字色（null 表示让界面层按对比度自选），ring = 焦点环色。
   */
  accent(parse: (raw: string) => Rgb | null): { bg: Rgb; fg: Rgb | null; ring: Rgb | null } | null
}

/** 列表项的站点无关形状（字段名沿用既有水位线逻辑，直接喂 selectChanged）。 */
export interface SiteConversationItem {
  id: string
  title: string
  update_time: string | number | null
}

export interface SitePager {
  /** 拉下一页；done=true 表示已确认到底 */
  next(): Promise<{ items: SiteConversationItem[]; done: boolean }>
}

/** 批量导出能力。supportsBatch 为 true 时必须提供。 */
export interface SiteBatch {
  listAll(
    session: string,
    onProgress?: (fetched: number) => void,
    cancel?: CancelToken,
  ): Promise<SiteConversationItem[]>
  createPager(session: string, cancel?: CancelToken): SitePager
}

export interface SiteAdapter {
  id: SiteId
  /** 面板与轮次标题里显示的名字 */
  label: string
  /**
   * 是否开放批量 / 全量导出。
   * Claude 首版为 false：限流画像尚无实测数据，先只做当前对话。
   */
  supportsBatch: boolean
  /** 当前页面是否属于这个站点 */
  matches(): boolean
  /** 当前打开的对话 id；不在对话页时 null */
  currentConversationId(): string | null
  /** 建立会话上下文（ChatGPT 换 accessToken，Claude 取 orgId），返回值透传给后续调用 */
  prepare(cancel?: CancelToken): Promise<string>
  /** 原始 JSON（raw 导出与 IR 转换共用同一次抓取） */
  fetchRaw(session: string, id: string, cancel?: CancelToken): Promise<unknown>
  /** 原始 JSON → IR */
  toIR(raw: unknown, fallbackId: string): IRConversation
  /** 取附件字节 */
  fetchAsset(
    session: string,
    ref: AssetRef,
    cancel?: CancelToken,
    maxBytes?: number,
  ): Promise<AssetPayload>
  /** 限流观测快照：未知站点的节奏只能靠实测看清 */
  throttleStats(): FetchStats
  /** 批量导出的实现；supportsBatch 为 false 时可缺省 */
  batch?: SiteBatch
  ui: SiteUi
}
