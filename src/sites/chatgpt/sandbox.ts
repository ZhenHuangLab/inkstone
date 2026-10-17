// ChatGPT 代码解释器生成件：正文里的 `[文字](sandbox:/mnt/data/x.pdf)` 链接。
//
// 这些文件没有 file id。网页点击链接时，前端用「会话 id + 链接所在消息 id + 沙箱路径」
// 请求 interpreter/download 换签名下载地址。这里把链接解析成附件引用，原链接文字
// 留作显示文字；下载与改链交给编排层。

import { inlineCodeSpans, mapLinesOutsideFencedCode } from '../../convert/codeaware'
import { hashText } from '../../core/hash'
import { inlineAssetMarker, type AssetRef } from '../../core/ir'

// 链接文字：允许转义字符和一层嵌套方括号（`[报告 [PDF]](sandbox:…)`）
const LABEL = String.raw`(?:\\.|[^\[\]\\\n]|\[(?:\\.|[^\[\]\\\n])*\])*`
// 目标地址按 CommonMark：尖括号形式可含空格；裸地址不含空白，圆括号须成对（`report (1).pdf`）
const ANGLE_TARGET = String.raw`<(sandbox:(?:\\.|[^<>\\\n])+)>`
const BARE_TARGET = String.raw`(sandbox:(?:\\.|[^\s()\\]|\((?:\\.|[^\s()\\])*\))+)`
const TITLE = String.raw`(?:[ \t]+(?:"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|\((?:\\.|[^()\\\n])*\)))?`
const SANDBOX_LINK = new RegExp(
  String.raw`(!?)\[(${LABEL})\]\([ \t]*(?:${ANGLE_TARGET}|${BARE_TARGET})${TITLE}[ \t]*\)`,
  'g',
)

export interface SandboxLinks {
  /** 链接处换成 inlineAssetMarker(i) 的正文 */
  text: string
  assets: AssetRef[]
}

/**
 * 找出正文里的 sandbox 链接（代码块与行内代码里的不算），换成行内附件占位。
 * `![alt](sandbox:…)` 按图片嵌入，其余按文件链接。
 */
export function extractSandboxLinks(text: string, conversationId: string, messageId: string): SandboxLinks {
  if (!text.includes('sandbox:')) return { text, assets: [] }
  const assets: AssetRef[] = []
  const out = mapLinesOutsideFencedCode(text, (line) => {
    const codeSpans = inlineCodeSpans(line)
    return line.replace(
      SANDBOX_LINK,
      (link: string, bang: string, label: string, angle: string | undefined, bare: string | undefined, offset: number) => {
        if (codeSpans.some(([start, end]) => offset >= start && offset < end)) return link
        const path = sandboxPath(angle ?? bare ?? '')
        if (path === '') return link
        assets.push(sandboxAssetRef(conversationId, messageId, path, unescapeMarkdown(label).trim(), bang === '!'))
        return inlineAssetMarker(assets.length - 1)
      },
    )
  })
  return { text: out, assets }
}

function sandboxAssetRef(
  conversationId: string,
  messageId: string,
  path: string,
  label: string,
  embed: boolean,
): AssetRef {
  const name = path.split('/').filter(Boolean).pop() ?? ''
  const query = new URLSearchParams({ message_id: messageId, sandbox_path: path })
  return {
    // 同一路径可能在后续消息里被改写成新版本，下载接口也按消息定位，所以身份带上会话与消息
    fileId: `sandbox-${hashText(`${conversationId}\0${messageId}\0${path}`)}`,
    kind: embed ? 'image' : 'file',
    ...(name ? { name } : {}),
    ...(label ? { label } : {}),
    url: `/backend-api/conversation/${encodeURIComponent(conversationId)}/interpreter/download?${query}`,
  }
}

/** `sandbox:/mnt/data/My%20Report.pdf` → `/mnt/data/My Report.pdf`：链接目标是 URL，百分号编码要还原成真实路径。 */
function sandboxPath(target: string): string {
  const raw = unescapeMarkdown(target).slice('sandbox:'.length)
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

/** CommonMark 反斜杠转义只作用于 ASCII 标点。 */
function unescapeMarkdown(text: string): string {
  return text.replace(/\\([!-/:-@[-`{-~])/g, '$1')
}
