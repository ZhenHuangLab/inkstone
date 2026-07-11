// 增量水位线：conv_id → update_time。
// 优先 GM 存储（跨页面持久，Tampermonkey @grant），CDP 注入等无 GM 环境回退 localStorage。

import { sanitizeSubdir } from './convert/markdown'

declare const GM_getValue: ((key: string, defaultValue?: string) => string | undefined) | undefined
declare const GM_setValue: ((key: string, value: string) => void) | undefined

export type Watermark = Record<string, string>

function storeGet(key: string): string | null {
  try {
    if (typeof GM_getValue === 'function') return GM_getValue(key) ?? null
  } catch {
    /* GM 不可用 */
  }
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function storeSet(key: string, value: string): void {
  try {
    if (typeof GM_setValue === 'function') {
      GM_setValue(key, value)
      return
    }
  } catch {
    /* GM 不可用 */
  }
  try {
    localStorage.setItem(key, value)
  } catch {
    /* 存不了就下次全量，无碍正确性 */
  }
}

const keyFor = (kind: string) => `inkstone:wm:${kind}`

export function loadWatermark(kind: string): Watermark {
  try {
    const parsed: unknown = JSON.parse(storeGet(keyFor(kind)) ?? '{}')
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Watermark
    }
  } catch {
    /* 损坏就当空 */
  }
  return {}
}

export function saveWatermark(kind: string, wm: Watermark): void {
  storeSet(keyFor(kind), JSON.stringify(wm))
}

export function clearWatermarks(kinds: string[]): void {
  for (const kind of kinds) saveWatermark(kind, {})
}

export interface Settings {
  /** 文件类附件的下载上限（MB）；图片不受此限制 */
  maxFileMB: number
  /** 附件链接风格：Obsidian wikilink 或标准 Markdown */
  linkStyle: 'wikilink' | 'markdown'
  /** 消息内标题：整体降一级 或 全部剥离为加粗行 */
  headingMode: 'demote' | 'strip'
  /** 输出目标：下载 zip 或 File System Access 直写文件夹 */
  target: 'zip' | 'folder'
  /** 笔记子文件夹（可 `a/b` 嵌套）；空串 = 直接写根目录 */
  notesDir: string
  /** 附件子文件夹，相对笔记所在目录；空串 = 与笔记同层 */
  attachmentsDir: string
  /** 导出按钮位置：悬浮在输入框旁（玻璃圆钮）或集成到顶部 Share 左侧（原生幽灵钮） */
  fabPos: 'composer' | 'header'
}

const SETTINGS_KEY = 'inkstone:settings'
const DEFAULT_SETTINGS: Settings = {
  maxFileMB: 2,
  linkStyle: 'wikilink',
  headingMode: 'demote',
  target: 'zip',
  notesDir: 'conversations',
  attachmentsDir: 'attachments',
  fabPos: 'header',
}

export function loadSettings(): Settings {
  try {
    const parsed: unknown = JSON.parse(storeGet(SETTINGS_KEY) ?? '{}')
    if (parsed && typeof parsed === 'object') {
      const s = parsed as Partial<Settings>
      return {
        maxFileMB:
          typeof s.maxFileMB === 'number' && Number.isFinite(s.maxFileMB) && s.maxFileMB > 0
            ? s.maxFileMB
            : DEFAULT_SETTINGS.maxFileMB,
        linkStyle: s.linkStyle === 'markdown' ? 'markdown' : 'wikilink',
        headingMode: s.headingMode === 'strip' ? 'strip' : 'demote',
        target: s.target === 'folder' ? 'folder' : 'zip',
        // 空串是合法值（显式不套子文件夹），只在字段缺失/类型不对时回落默认
        notesDir: typeof s.notesDir === 'string' ? sanitizeSubdir(s.notesDir) : DEFAULT_SETTINGS.notesDir,
        attachmentsDir:
          typeof s.attachmentsDir === 'string'
            ? sanitizeSubdir(s.attachmentsDir)
            : DEFAULT_SETTINGS.attachmentsDir,
        fabPos: s.fabPos === 'composer' ? 'composer' : 'header',
      }
    }
  } catch {
    /* 损坏就用默认 */
  }
  return { ...DEFAULT_SETTINGS }
}

export function saveSettings(patch: Partial<Settings>): void {
  storeSet(SETTINGS_KEY, JSON.stringify({ ...loadSettings(), ...patch }))
}

/** 增量筛选：只留 update_time 与水位线不一致的（新增或有变化的）对话。 */
export function selectChanged<T extends { id: string; update_time?: string | number | null }>(
  items: readonly T[],
  wm: Watermark,
): T[] {
  return items.filter((i) => wm[i.id] !== String(i.update_time ?? ''))
}
