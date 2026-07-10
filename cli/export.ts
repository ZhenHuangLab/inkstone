#!/usr/bin/env bun
// 官方导出 zip 的离线转换 CLI：完全不碰 backend-api，零限流风险。
//
//   bun cli/export.ts <官方导出.zip 或解压目录> [-o 输出目录]
//     [--no-thoughts] [--no-assets] [--link-style wikilink|markdown] [--heading-mode demote|strip]
//
// 输出目录结构与油猴导出的 zip 一致：conversations/*.md + attachments/*。
//
// 官方 zip 与 backend-api 的已知差异（2026-07 实测）：
// - 只保留 user/assistant 可见消息，tool/system 全剥离 → Canvas、代码解释器载荷不存在
// - mapping 节点只有 parent 链，没有 children
// - sediment://file_X 附件对应包内 file_X.dat，原始文件名在 conversation_asset_file_names.json
// - 部分被引用的附件不在包里（服务端已过期/删除），留占位说明
// - branch 对话只有 branching_from_conversation_title，没有 id —— 用 parent_id 反查全库恢复

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { unzipSync } from 'fflate'
import {
  assetLink,
  assetToken,
  conversationToMarkdown,
  filenameFor,
  sanitizeName,
  type AssetRef,
  type ConvertOptions,
  type LinkStyle,
} from '../src/convert/markdown'
import type { ConversationDetail } from '../src/types'

// ---------- 参数 ----------

interface CliArgs {
  input: string
  out: string
  thoughts: boolean
  assets: boolean
  linkStyle: LinkStyle
  headingMode: NonNullable<ConvertOptions['headingMode']>
}

function parseArgs(argv: string[]): CliArgs {
  let input = ''
  let out = ''
  let thoughts = true
  let assets = true
  let linkStyle: LinkStyle = 'wikilink'
  let headingMode: CliArgs['headingMode'] = 'demote'

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '-o' || a === '--out') out = argv[++i] ?? ''
    else if (a === '--no-thoughts') thoughts = false
    else if (a === '--no-assets') assets = false
    else if (a === '--link-style') {
      const v = argv[++i]
      if (v !== 'wikilink' && v !== 'markdown') die(`--link-style 只能是 wikilink 或 markdown，收到：${v}`)
      linkStyle = v
    } else if (a === '--heading-mode') {
      const v = argv[++i]
      if (v !== 'demote' && v !== 'strip') die(`--heading-mode 只能是 demote 或 strip，收到：${v}`)
      headingMode = v
    } else if (a === '-h' || a === '--help') {
      usage()
      process.exit(0)
    } else if (!a.startsWith('-') && input === '') input = a
    else die(`未知参数：${a}`)
  }

  if (input === '') {
    usage()
    process.exit(1)
  }
  if (out === '') out = `${input.replace(/\.zip$/i, '').replace(/\/+$/, '')}-vault`
  return { input, out, thoughts, assets, linkStyle, headingMode }
}

function usage(): void {
  console.log(
    'Inkstone 离线导出：ChatGPT 官方导出 zip → Obsidian 友好 Markdown\n\n' +
      '用法：bun cli/export.ts <导出.zip 或解压目录> [-o 输出目录]\n' +
      '      [--no-thoughts] [--no-assets] [--link-style wikilink|markdown] [--heading-mode demote|strip]',
  )
}

function die(msg: string): never {
  console.error(`✗ ${msg}`)
  process.exit(1)
}

// ---------- 输入源：zip 与目录同接口 ----------

interface ExportSource {
  names: string[]
  /** 批量取文件内容；zip 源一次中央目录扫描解出整批 */
  readMany(names: readonly string[]): Map<string, Uint8Array>
}

function openSource(path: string): ExportSource {
  const st = statSync(path)
  if (st.isDirectory()) {
    const names = (readdirSync(path, { recursive: true }) as string[]).filter(
      (n) => !statSync(join(path, n)).isDirectory(),
    )
    return {
      names,
      readMany(wanted) {
        const out = new Map<string, Uint8Array>()
        for (const n of wanted) out.set(n, new Uint8Array(readFileSync(join(path, n))))
        return out
      },
    }
  }

  const buf = new Uint8Array(readFileSync(path))
  const names: string[] = []
  // filter 恒 false：只收集条目名，不解压
  unzipSync(buf, {
    filter: (f) => {
      names.push(f.name)
      return false
    },
  })
  return {
    names,
    readMany(wanted) {
      const set = new Set(wanted)
      const extracted = unzipSync(buf, { filter: (f) => set.has(f.name) })
      return new Map(Object.entries(extracted))
    },
  }
}

// ---------- 附件命名 ----------

const MAGIC: Array<[readonly number[], string]> = [
  [[0x89, 0x50, 0x4e, 0x47], '.png'],
  [[0xff, 0xd8, 0xff], '.jpg'],
  [[0x47, 0x49, 0x46, 0x38], '.gif'],
  [[0x25, 0x50, 0x44, 0x46], '.pdf'],
  [[0x50, 0x4b, 0x03, 0x04], '.zip'],
]

function sniffExt(bytes: Uint8Array): string {
  for (const [magic, ext] of MAGIC) {
    if (magic.every((b, i) => bytes[i] === b)) return ext
  }
  // RIFF....WEBP
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57 && bytes[9] === 0x45) return '.webp'
  return ''
}

/** 与油猴端同规则：净化 + 截断保扩展名 + 无扩展名时按内容补。 */
function attachmentFileName(a: AssetRef, hintName: string | null, bytes: Uint8Array): string {
  const raw = sanitizeName(a.name ?? hintName ?? '')
  const ext = /\.[A-Za-z0-9]{1,8}$/.exec(raw)?.[0] ?? ''
  const base = (ext ? raw.slice(0, -ext.length) : raw).slice(0, 60).trim()
  let name = (base || (a.kind === 'image' ? 'image' : 'file')) + ext
  if (!/\.[A-Za-z0-9]{1,8}$/.test(name)) name += sniffExt(bytes)
  return name
}

// ---------- 主流程 ----------

const args = parseArgs(process.argv.slice(2))
if (!existsSync(args.input)) die(`找不到输入：${args.input}`)

console.log(`读取 ${args.input} …`)
const source = openSource(args.input)

// conversations.json（旧版单文件）或 conversations-000.json 分片
const convEntries = source.names.filter((n) => /^conversations(-\d+)?\.json$/.test(basename(n))).sort()
if (convEntries.length === 0) die('没找到 conversations*.json——这不是 ChatGPT 官方导出包？')

const metaEntries = source.readMany(
  convEntries.concat(source.names.filter((n) => basename(n) === 'conversation_asset_file_names.json')),
)

const assetNameByDat: Record<string, string> = {}
for (const [n, bytes] of metaEntries) {
  if (basename(n) === 'conversation_asset_file_names.json') {
    Object.assign(assetNameByDat, JSON.parse(new TextDecoder().decode(bytes)))
  }
}

const decoder = new TextDecoder()
const convById = new Map<string, ConversationDetail>()
for (const entry of convEntries) {
  const list = JSON.parse(decoder.decode(metaEntries.get(entry)!)) as ConversationDetail[]
  for (const conv of list) {
    const id = String(conv.conversation_id ?? conv.id ?? '')
    if (id !== '') convById.set(id, conv)
  }
}
console.log(`共 ${convById.size} 个对话（${convEntries.length} 个分片）`)

// 官方导出的对话级时间戳有一批被迁移重写过（典型症状：create==update==导出前一天，
// 2023 年的老对话尤甚，47/432 实测中招）。以消息时间为准修正。
for (const conv of convById.values()) {
  const times = Object.values(conv.mapping ?? {})
    .map((n) => n.message?.create_time)
    .filter((t): t is number => typeof t === 'number' && Number.isFinite(t) && t > 0)
  if (times.length === 0) continue
  const minT = Math.min(...times)
  if (typeof conv.create_time === 'number' && conv.create_time > minT) {
    // create==update 是整对被重写的指纹，update 一并回退到末条消息；否则 update 可能是真实的后续活动，保留
    if (conv.update_time === conv.create_time) conv.update_time = Math.max(...times)
    conv.create_time = minT
  }
}

// branch 回链恢复：官方导出没有 branching_from_conversation_id。
// 注意分支对话会整份复制父对话的消息 id，按消息 id 反查会命中多个对话（父 + 各兄弟分支），
// 必须再用 branching_from_conversation_title 精确匹配消歧，唯一命中才认。
const convsByMsgId = new Map<string, string[]>()
const convsByTitle = new Map<string, string[]>()
for (const [id, conv] of convById) {
  for (const nodeId of Object.keys(conv.mapping ?? {})) {
    ;(convsByMsgId.get(nodeId) ?? convsByMsgId.set(nodeId, []).get(nodeId)!).push(id)
  }
  const t = conv.title ?? ''
  ;(convsByTitle.get(t) ?? convsByTitle.set(t, []).get(t)!).push(id)
}
let branchesRestored = 0
for (const [selfId, conv] of convById) {
  for (const node of Object.values(conv.mapping ?? {})) {
    const md = node.message?.metadata
    if (!md || md.branching_from_conversation_id || md.branching_from_conversation_title == null) continue
    const wantTitle = md.branching_from_conversation_title
    const pid = md['parent_id']
    const byMsg = (typeof pid === 'string' ? (convsByMsgId.get(pid) ?? []) : []).filter(
      (id) => id !== selfId && convById.get(id)?.title === wantTitle,
    )
    const matched = byMsg.length > 0 ? byMsg : (convsByTitle.get(wantTitle) ?? []).filter((id) => id !== selfId)
    if (matched.length === 1) {
      md.branching_from_conversation_id = matched[0]!
      branchesRestored++
    }
  }
}
if (branchesRestored > 0) console.log(`恢复 ${branchesRestored} 条 Branch 对话回链`)

// 逐对话转换（先攒 markdown，附件统一批量解出后回填占位符）
interface Pending {
  path: string
  markdown: string
  assets: AssetRef[]
  title: string
}
const pending: Pending[] = []
const assetRefs = new Map<string, AssetRef>() // fileId → 首个引用（带 name/kind）
const assetUsedBy = new Map<string, string[]>() // fileId → 对话标题（缺失报告用）

let done = 0
for (const [id, conv] of convById) {
  const { markdown, title, assets } = conversationToMarkdown(conv, id, {
    thoughts: args.thoughts,
    headingMode: args.headingMode,
  })
  pending.push({ path: join('conversations', filenameFor(title, id)), markdown, assets, title })
  for (const a of assets) {
    if (!assetRefs.has(a.fileId)) assetRefs.set(a.fileId, a)
    ;(assetUsedBy.get(a.fileId) ?? assetUsedBy.set(a.fileId, []).get(a.fileId)!).push(title)
  }
  if (++done % 100 === 0) console.log(`转换 ${done}/${convById.size} …`)
}
console.log(`转换完成：${pending.length} 个对话，引用附件 ${assetRefs.size} 个`)

// 附件解出：sediment 的 file_X → file_X.dat；旧式 file-X → 基名前缀匹配（含 dalle-generations/）
const entryByAsset = new Map<string, string>()
if (args.assets) {
  const baseNames = new Map<string, string>() // 基名 → 完整条目名
  for (const n of source.names) baseNames.set(basename(n), n)
  for (const fileId of assetRefs.keys()) {
    const exact = baseNames.get(`${fileId}.dat`) ?? baseNames.get(fileId)
    if (exact != null) {
      entryByAsset.set(fileId, exact)
      continue
    }
    const prefixed = source.names.find((n) => basename(n).startsWith(`${fileId}-`) || basename(n).startsWith(`${fileId}.`))
    if (prefixed != null) entryByAsset.set(fileId, prefixed)
  }
}

mkdirSync(join(args.out, 'conversations'), { recursive: true })
if (entryByAsset.size > 0) mkdirSync(join(args.out, 'attachments'), { recursive: true })

// fileId → 正文替换文本
const replacements = new Map<string, string>()
const missing: Array<{ fileId: string; name: string | null; usedBy: string[] }> = []

if (args.assets) {
  const ids = [...entryByAsset.keys()]
  const BATCH = 32 // zip 源整包驻留内存，分批解压控制峰值
  for (let i = 0; i < ids.length; i += BATCH) {
    const batch = ids.slice(i, i + BATCH)
    const contents = source.readMany(batch.map((id) => entryByAsset.get(id)!))
    for (const fileId of batch) {
      const entry = entryByAsset.get(fileId)!
      const bytes = contents.get(entry)
      if (bytes == null) continue
      const a = assetRefs.get(fileId)!
      const entryBase = basename(entry)
      const hint = assetNameByDat[entryBase] ?? (entryBase.endsWith('.dat') ? null : entryBase)
      const name = attachmentFileName(a, hint, bytes)
      const relPath = `attachments/${fileId.slice(-8)}-${name}`
      writeFileSync(join(args.out, relPath), bytes)
      replacements.set(
        fileId,
        assetLink(args.linkStyle, relPath, { embed: a.kind === 'image', label: a.name ?? name }),
      )
    }
    if (ids.length > BATCH) console.log(`附件 ${Math.min(i + BATCH, ids.length)}/${ids.length} …`)
  }
}

for (const [fileId, a] of assetRefs) {
  if (replacements.has(fileId)) continue
  if (!args.assets) {
    replacements.set(fileId, `*(附件：${a.name ?? fileId} — 本次导出关闭了附件下载)*`)
  } else {
    missing.push({ fileId, name: a.name ?? assetNameByDat[`${fileId}.dat`] ?? null, usedBy: assetUsedBy.get(fileId) ?? [] })
    replacements.set(
      fileId,
      `*(附件不在官方导出包里：${a.name ?? fileId}，服务端可能已过期或删除)*`,
    )
  }
}

// 回填占位符并落盘
for (const p of pending) {
  let md = p.markdown
  for (const a of p.assets) {
    md = md.split(assetToken(a.fileId)).join(replacements.get(a.fileId) ?? '')
  }
  writeFileSync(join(args.out, p.path), md)
}

if (missing.length > 0) {
  writeFileSync(join(args.out, '_missing_assets.json'), JSON.stringify(missing, null, 2))
}

console.log(
  `✓ 完成：${pending.length} 个对话 → ${resolve(args.out)}\n` +
    `  附件：${entryByAsset.size} 个解出` +
    (missing.length > 0 ? `，${missing.length} 个不在包里（见 _missing_assets.json）` : ''),
)
