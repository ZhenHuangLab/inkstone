import {
  CancelledError,
  ensureAlive,
  fetchBinary,
  fetchConversation,
  getAccessToken,
  listAllConversations,
  mapConcurrent,
  resolveFileDownload,
  SizeLimitError,
  sleep,
  type CancelToken,
} from './api'
import {
  assetToken,
  conversationToMarkdown,
  filenameFor,
  sanitizeName,
  type AssetRef,
} from './convert/markdown'
import { downloadBlob, makeZip, strToU8, type ZipEntries } from './output/zip'
import {
  clearWatermarks,
  loadSettings,
  loadWatermark,
  saveSettings,
  saveWatermark,
  selectChanged,
  type Watermark,
} from './state'
import { mountPanel, type ExportOptions, type PanelHandle, type PickerItem } from './ui'
import type { ConversationListItem } from './types'

// 图片始终下载，上限只防异常；文件类附件的上限由面板设置（opts.maxFileMB）
const MAX_IMAGE_BYTES = 30 * 1024 * 1024

let activeCancel: CancelToken | null = null
// 「选择对话…」拉取的列表缓存：导出所选时直接用，不重复拉列表
let pickedList: ConversationListItem[] | null = null

mountPanel({
  onStart(kind, panel, opts) {
    if (kind === 'single') void exportSingle(panel, opts)
    else void startExport(kind, panel, opts)
  },
  onPickList(panel) {
    void loadPickList(panel)
  },
  onExportSelection(ids, panel, opts) {
    void exportSelection(ids, panel, opts)
  },
  onCancel() {
    if (activeCancel) activeCancel.cancelled = true
  },
  onResetWatermark() {
    clearWatermarks(['markdown', 'json'])
  },
  settings: {
    maxFileMB: loadSettings().maxFileMB,
    onSettingsChange: (maxFileMB) => saveSettings({ maxFileMB }),
  },
})

async function loadPickList(panel: PanelHandle): Promise<void> {
  const cancel: CancelToken = { cancelled: false }
  activeCancel = cancel
  try {
    panel.setStatus('获取登录态…')
    const token = await getAccessToken(cancel)
    panel.setStatus('拉取对话列表…')
    pickedList = await listAllConversations(token, (n) => panel.setStatus(`拉取对话列表… 已 ${n} 条`), cancel)
    const items: PickerItem[] = pickedList.map((i) => ({
      id: i.id,
      title: i.title ?? '',
      updated: shortDate(i.update_time),
    }))
    panel.showPicker(items)
    panel.setStatus(`共 ${items.length} 条，勾选后点「导出所选」`)
  } catch (e) {
    panel.setStatus(e instanceof CancelledError ? '已取消' : `出错：${String(e)}`)
  } finally {
    activeCancel = null
    panel.finish()
  }
}

async function exportSelection(ids: string[], panel: PanelHandle, opts: ExportOptions): Promise<void> {
  const cancel: CancelToken = { cancelled: false }
  activeCancel = cancel
  try {
    const wanted = new Set(ids)
    const items = (pickedList ?? []).filter((i) => wanted.has(i.id))
    if (items.length === 0) {
      panel.setStatus('所选对话已不在列表缓存里，请重新点「选择对话…」')
      return
    }
    panel.setStatus('获取登录态…')
    const token = await getAccessToken(cancel)
    await exportItems('markdown', items, 0, token, cancel, panel, opts)
  } catch (e) {
    panel.setStatus(e instanceof CancelledError ? '已取消' : `出错：${String(e)}`)
  } finally {
    activeCancel = null
    panel.finish()
  }
}

function shortDate(t: string | number | null | undefined): string {
  if (t == null) return ''
  const d = typeof t === 'number' ? new Date(t * 1000) : new Date(t)
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10)
}

interface Failure {
  id: string
  title: string
  error: string
}

/** 抓取 + 转换 + 附件下载的共享处理器：全量导出和单对话导出都用它。 */
function createProcessor(
  kind: 'markdown' | 'json',
  token: string,
  cancel: CancelToken,
  panel: PanelHandle,
  opts: ExportOptions,
) {
  const files: ZipEntries = {}
  // fileId → 正文替换文本；同一附件跨对话只下载一次
  const assetCache = new Map<string, string>()
  const maxFileBytes = opts.maxFileMB * 1024 * 1024

  async function resolveAsset(a: AssetRef): Promise<string> {
    const cached = assetCache.get(a.fileId)
    if (cached != null) return cached
    let replacement: string
    // 元数据 size 不可靠（library 文件报 0），仅作快速跳过；真正的护栏在 fetchBinary
    const cap = a.kind === 'file' ? maxFileBytes : MAX_IMAGE_BYTES
    if ((a.sizeBytes ?? 0) > cap) {
      replacement = skippedNote(a, a.sizeBytes!, cap)
    } else {
      try {
        const target = await resolveFileDownload(token, a.fileId, cancel)
        const { bytes, contentType } = await fetchBinary(target.url, cancel, cap)
        const name = assetFileName(a, target.filename, contentType)
        const zipPath = `attachments/${a.fileId.slice(-8)}-${name}`
        files[zipPath] = [bytes, { level: 0 }]
        replacement = a.kind === 'image' ? `![[${zipPath}]]` : `[[${zipPath}|${a.name ?? name}]]`
      } catch (e) {
        if (e instanceof CancelledError) throw e
        replacement =
          e instanceof SizeLimitError
            ? skippedNote(a, e.actualBytes, cap)
            : `*(附件下载失败：${a.name ?? a.fileId} — ${String(e)})*`
      }
    }
    assetCache.set(a.fileId, replacement)
    return replacement
  }

  function skippedNote(a: AssetRef, actual: number, cap: number): string {
    return `*(附件未下载：${a.name ?? a.fileId}，${fmtSize(actual)} 超过 ${fmtSize(cap)} 上限)*`
  }

  async function processConversation(item: ConversationListItem): Promise<{ path: string }> {
    const conv = await fetchConversation(token, item.id, cancel)
    if (kind === 'json') {
      const path = `raw/${item.id}.json`
      files[path] = strToU8(JSON.stringify(conv, null, 2))
      return { path }
    }
    const { markdown, title, assets } = conversationToMarkdown(conv, item.id)
    let md = markdown
    let assetIdx = 0
    for (const a of assets) {
      assetIdx++
      if (!opts.assets) {
        md = md.split(assetToken(a.fileId)).join(`*(附件：${a.name ?? a.fileId} — 本次导出关闭了附件下载)*`)
        continue
      }
      // 附件多的对话一磨几分钟，进度要有反馈，否则像卡死
      if (assets.length > 3 && assetIdx % 5 === 0) {
        panel.setStatus(`「${(item.title ?? title).slice(0, 14)}」附件 ${assetIdx}/${assets.length}…`)
      }
      md = md.split(assetToken(a.fileId)).join(await resolveAsset(a))
    }
    const path = `conversations/${filenameFor(title, item.id)}`
    files[path] = strToU8(md)
    return { path }
  }

  return { files, processConversation }
}

/** 只导出当前打开的对话：无附件下裸 .md，有附件打小 zip。 */
async function exportSingle(panel: PanelHandle, opts: ExportOptions): Promise<void> {
  const cancel: CancelToken = { cancelled: false }
  activeCancel = cancel
  try {
    const m = /\/c\/([0-9a-f][0-9a-f-]{10,})/i.exec(location.pathname)
    if (!m) {
      panel.setStatus('请先打开要导出的对话（网址需含 /c/…）')
      return
    }
    panel.setStatus('获取登录态…')
    const token = await getAccessToken(cancel)
    const proc = createProcessor('markdown', token, cancel, panel, opts)
    panel.setStatus('抓取当前对话…')
    const { path } = await proc.processConversation({ id: m[1]!, title: null })
    const mdName = path.split('/').pop()!
    const hasAttachments = Object.keys(proc.files).some((p) => p !== path)
    if (hasAttachments) {
      panel.setStatus('打包 zip…')
      const data = await makeZip(proc.files)
      downloadBlob(mdName.replace(/\.md$/, '.zip'), data)
    } else {
      const entry = proc.files[path]!
      downloadBlob(mdName, entry instanceof Uint8Array ? entry : entry[0], 'text/markdown')
    }
    panel.setStatus(`完成：${mdName}`)
  } catch (e) {
    panel.setStatus(e instanceof CancelledError ? '已取消' : `出错：${String(e)}`)
  } finally {
    activeCancel = null
    panel.finish()
  }
}

async function startExport(
  kind: 'markdown' | 'json',
  panel: PanelHandle,
  opts: ExportOptions,
): Promise<void> {
  const cancel: CancelToken = { cancelled: false }
  activeCancel = cancel
  try {
    panel.setStatus('获取登录态…')
    const token = await getAccessToken(cancel)

    panel.setStatus('拉取对话列表…')
    const fullList = await listAllConversations(
      token,
      (n) => panel.setStatus(`拉取对话列表… 已 ${n} 条`),
      cancel,
    )
    if (fullList.length === 0) {
      panel.setStatus('没有可导出的对话')
      return
    }

    // 增量：跳过 update_time 与上次导出一致的对话——重负载的全量抓取一辈子只需一次
    const list = opts.incremental ? selectChanged(fullList, loadWatermark(kind)) : fullList
    const skipped = fullList.length - list.length
    if (list.length === 0) {
      panel.setStatus(`没有变化：${fullList.length} 条对话都与上次导出一致`)
      return
    }
    if (skipped > 0) panel.setStatus(`跳过未变化 ${skipped} 条，导出 ${list.length} 条…`)

    await exportItems(kind, list, skipped, token, cancel, panel, opts)
  } catch (e) {
    panel.setStatus(e instanceof CancelledError ? '已取消' : `出错：${String(e)}`)
  } finally {
    activeCancel = null
    panel.finish()
  }
}

/** 全量 / 增量 / 所选 共用的导出主体：两遍抓取 + 打包 + 水位线推进。 */
async function exportItems(
  kind: 'markdown' | 'json',
  list: ConversationListItem[],
  skipped: number,
  token: string,
  cancel: CancelToken,
  panel: PanelHandle,
  opts: ExportOptions,
): Promise<void> {
  // 水位线合并推进：导出成功的对话记下 update_time，其余保持原状
  const wmDraft: Watermark = { ...loadWatermark(kind) }
  const proc = createProcessor(kind, token, cancel, panel, opts)

  // 单条失败不中断，收集后统一重试；失败过多则保护性中止（防止触发/加重账号级反滥用），
  // 已抓取的内容照常打包
  async function runPass(
    items: readonly ConversationListItem[],
    concurrency: number,
    label: string,
  ): Promise<{
    failed: ConversationListItem[]
    untried: ConversationListItem[]
    aborted: boolean
  }> {
    const failed: ConversationListItem[] = []
    const untried: ConversationListItem[] = []
    let done = 0
    let aborted = false
    await mapConcurrent(
      items,
      concurrency,
      async (item) => {
        if (aborted) {
          untried.push(item)
          done++
          return
        }
        try {
          await proc.processConversation(item)
          wmDraft[item.id] = String(item.update_time ?? '')
        } catch (e) {
          if (e instanceof CancelledError) throw e
          failed.push(item)
          if (failed.length >= 25 && failed.length > done / 2) aborted = true
        }
        done++
        panel.setProgress(done, items.length)
        panel.setStatus(`${label} ${done}/${items.length}${failed.length ? `（失败 ${failed.length}）` : ''}`)
      },
      cancel,
    )
    return { failed, untried, aborted }
  }

  const pass1 = await runPass(list, 2, '抓取对话')
  let failedItems = pass1.failed
  let untriedItems = pass1.untried
  let safetyAborted = pass1.aborted

  if (failedItems.length > 0 && !safetyAborted) {
    // 大概率是限流长尾：歇口气再用单并发慢速补一遍
    for (let s = 20; s > 0; s--) {
      ensureAlive(cancel)
      panel.setStatus(`${failedItems.length} 条失败，${s}s 后低速重试…`)
      await sleep(1000)
    }
    const pass2 = await runPass(failedItems, 1, '重试失败条目')
    failedItems = pass2.failed
    untriedItems = untriedItems.concat(pass2.untried)
    safetyAborted = pass2.aborted
  }

  const failures: Failure[] = [
    ...failedItems.map((i) => ({
      id: i.id,
      title: i.title ?? '',
      error: '多次重试后仍失败（限流隔离或对话不可用）',
    })),
    ...untriedItems.map((i) => ({
      id: i.id,
      title: i.title ?? '',
      error: '保护性中止，本次未尝试（下次增量导出会自动补上）',
    })),
  ]
  if (failures.length > 0) {
    proc.files['_failures.json'] = strToU8(JSON.stringify(failures, null, 2))
  }

  panel.setStatus('打包 zip…')
  const data = await makeZip(proc.files)
  const stamp = new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-')
  downloadBlob(`chatgpt-export-${kind}-${stamp}.zip`, data)
  // 水位线只在产物真正落地后推进：取消/崩溃的运行不记，避免下次增量漏数据
  saveWatermark(kind, wmDraft)
  panel.setStatus(
    `${safetyAborted ? '保护性中止（失败过多，防止触发服务端限制）。' : '完成：'}` +
      `${list.length - failures.length} 个对话` +
      (skipped > 0 ? `（另跳过未变化 ${skipped} 条）` : '') +
      (failures.length ? `，${failures.length} 个失败（见 zip 内 _failures.json）` : ''),
  )
}

const EXT_BY_MIME: Record<string, string> = {
  'image/png': '.png',
  'image/webp': '.webp',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
}

function assetFileName(a: AssetRef, downloadName: string | null, contentType: string | null): string {
  const raw = sanitizeName(downloadName ?? a.name ?? '')
  // 截断只砍主名，扩展名要保住
  const ext = /\.[A-Za-z0-9]{1,8}$/.exec(raw)?.[0] ?? ''
  const base = (ext ? raw.slice(0, -ext.length) : raw).slice(0, 60).trim()
  let name = (base || (a.kind === 'image' ? 'image' : 'file')) + ext
  if (!/\.[A-Za-z0-9]{1,8}$/.test(name)) {
    const mimeExt = EXT_BY_MIME[(contentType ?? '').split(';')[0]!.trim()]
    if (mimeExt) name += mimeExt
  }
  return name
}

function fmtSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)}KB`
  return `${bytes}B`
}
