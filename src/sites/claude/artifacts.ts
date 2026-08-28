// Artifact 折叠：把 create / update / rewrite 序列还原成终稿。
//
// 与 ChatGPT 的 Canvas 重放同构，但简单得多——Canvas 的 update 是 Python 风格
// 正则 patch（语义与 JS 存疑，得逐条判断能不能翻译），Artifact 的 update 是
// 字面量 old_str → new_str，可靠得多。失真控制沿用 canvas.ts 的规矩：
// 任何一步匹配不上就放弃该文档的后续重放，由调用方回退原始 JSON 折叠嵌入。

import type { ClaudeContentBlock, ClaudeMessage } from './types'

export type ArtifactOpKind = 'create' | 'update' | 'rewrite'

export interface ArtifactOp {
  kind: ArtifactOpKind
  title: string
  /** claude 的 artifact type，如 application/vnd.ant.code、text/markdown */
  mime: string
  language?: string
  /** 仅当本条是该 artifact 最后一次成功的内容变更：重放出的终稿 */
  finalContent?: string
}

interface DocState {
  title: string
  mime: string
  language?: string
  content: string
  /** 某次 update 匹配失败后不再信任后续状态，终稿停在最后一次成功处 */
  broken: boolean
  lastGoodKey: string
}

/** 块定位键：一条消息可能含多个 tool_use 块，光靠 msg.uuid 不够。 */
export const blockKey = (msgUuid: string, blockIndex: number): string => `${msgUuid}#${blockIndex}`

/**
 * 沿主线重放全部 artifacts 工具调用。
 * 返回 blockKey → ArtifactOp；不在 map 里的 artifacts 块表示重放失败，调用方走原始 JSON 兜底。
 */
export function replayArtifacts(messages: readonly ClaudeMessage[]): Map<string, ArtifactOp> {
  const ops = new Map<string, ArtifactOp>()
  const docs = new Map<string, DocState>()

  for (const msg of messages) {
    const blocks = msg.content ?? []
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i]!
      if (block.type !== 'tool_use' || block.name !== 'artifacts') continue
      const input = block.input ?? {}
      const id = str(input['id']) || '__artifact__'
      const key = blockKey(msg.uuid, i)
      const command = str(input['command'])

      let doc = docs.get(id)
      if (!doc) {
        doc = { title: '', mime: '', content: '', broken: false, lastGoodKey: key }
        docs.set(id, doc)
      }
      // 元数据挂在 create 块上，后续 update 不重复携带
      if (str(input['title'])) doc.title = str(input['title'])
      if (str(input['type'])) doc.mime = str(input['type'])
      if (str(input['language'])) doc.language = str(input['language'])

      if (command === 'update') {
        if (doc.broken) continue
        const oldStr = input['old_str']
        const newStr = input['new_str']
        if (typeof oldStr !== 'string' || typeof newStr !== 'string' || !doc.content.includes(oldStr)) {
          doc.broken = true
          continue
        }
        // 必须传函数替换器：字符串形式会把 new_str 里的 $&、$` 、$$ 当成替换模式，
        // 静默损坏内容——这些序列在真实的 JS / shell / CSS 代码里很常见。
        doc.content = doc.content.replace(oldStr, () => newStr)
        doc.lastGoodKey = key
        ops.set(key, { kind: 'update', title: doc.title, mime: doc.mime, language: doc.language })
      } else if (command === 'create' || command === 'rewrite') {
        const content = input['content']
        if (typeof content !== 'string') {
          doc.broken = true
          continue
        }
        doc.content = content
        doc.broken = false // 全量写入重新奠定基线，此前的失配不再影响后续
        doc.lastGoodKey = key
        ops.set(key, {
          kind: command,
          title: doc.title,
          mime: doc.mime,
          language: doc.language,
        })
      }
      // 未知 command：不入 ops，调用方走原始 JSON 兜底
    }
  }

  // 每个 artifact 最后一次成功的内容变更处嵌入终稿
  for (const doc of docs.values()) {
    if (doc.content === '') continue
    const op = ops.get(doc.lastGoodKey)
    if (op) op.finalContent = doc.content
  }
  return ops
}

/**
 * artifact 的 mime + language → IR 的 docType。
 * `code/*` 会被渲染成围栏代码块，其余走正文排版管道（标题降级、公式转换）。
 */
export function artifactDocType(mime: string, language?: string): string {
  switch (mime) {
    case 'application/vnd.ant.react':
      return 'code/jsx'
    case 'text/html':
      return 'code/html'
    case 'image/svg+xml':
      return 'code/svg'
    case 'application/vnd.ant.mermaid':
      return 'code/mermaid'
    case 'application/vnd.ant.code':
      return `code/${language ?? ''}`
    case 'text/markdown':
      return 'document'
    default:
      // 未知类型当文档处理：宁可让正文原样出现，也不套错围栏
      return 'document'
  }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}
