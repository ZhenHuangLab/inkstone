// ChatGPT 侧的转换入口（兼容壳）。
//
// 实现已拆成两段：`sites/chatgpt/convert` 把 backend-api JSON 解成站点无关的 IR，
// `core/render` 把 IR 渲染成 Markdown。这里只保留原有的导出签名，
// 让离线 CLI 与既有测试无需改动地继续工作。

import { conversationToIR } from '../sites/chatgpt/convert'
import {
  renderConversation,
  type ConvertOptions,
  type ConvertResult,
  type LinkStyle,
} from '../core/render'
import type { ConversationDetail } from '../types'

export {
  assetLink,
  assetToken,
  filenameFor,
  sanitizeName,
  sanitizeSubdir,
  type ConvertOptions,
  type ConvertResult,
  type LinkStyle,
} from '../core/render'
export type { AssetRef } from '../core/ir'

export function conversationToMarkdown(
  conv: ConversationDetail,
  fallbackId = '',
  copts: ConvertOptions = {},
): ConvertResult {
  return renderConversation(conversationToIR(conv, fallbackId), copts)
}
