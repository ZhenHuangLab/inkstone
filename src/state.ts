// 增量水位线：conv_id → update_time。
// 优先 GM 存储（跨页面持久，Tampermonkey @grant），CDP 注入等无 GM 环境回退 localStorage。

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

const keyFor = (kind: string) => `gexport:wm:${kind}`

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
}

const SETTINGS_KEY = 'gexport:settings'
const DEFAULT_SETTINGS: Settings = { maxFileMB: 2 }

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
      }
    }
  } catch {
    /* 损坏就用默认 */
  }
  return { ...DEFAULT_SETTINGS }
}

export function saveSettings(s: Settings): void {
  storeSet(SETTINGS_KEY, JSON.stringify(s))
}

/** 增量筛选：只留 update_time 与水位线不一致的（新增或有变化的）对话。 */
export function selectChanged<T extends { id: string; update_time?: string | number | null }>(
  items: readonly T[],
  wm: Watermark,
): T[] {
  return items.filter(i => wm[i.id] !== String(i.update_time ?? ''))
}
