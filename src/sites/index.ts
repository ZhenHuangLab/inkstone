// 站点分派：按当前域名选适配器。

import { chatgptAdapter } from './chatgpt'
import { claudeAdapter } from './claude'
import type { SiteAdapter } from './types'

export type {
  AssetPayload,
  Rgb,
  SiteAdapter,
  SiteBatch,
  SiteConversationItem,
  SiteId,
  SitePager,
  SiteUi,
} from './types'

export const adapters: readonly SiteAdapter[] = [chatgptAdapter, claudeAdapter]

/** 当前页面对应的适配器；都不匹配时返回 null（脚本不挂载任何界面）。 */
export function resolveAdapter(): SiteAdapter | null {
  return adapters.find((a) => a.matches()) ?? null
}
