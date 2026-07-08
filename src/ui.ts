export type ExportKind = 'markdown' | 'json' | 'single'

export interface ExportOptions {
  /** 只导出上次以来有变化的对话（水位线见 state.ts） */
  incremental: boolean
  /** 下载图片/文件附件（关闭后导出快得多，请求量大幅减少） */
  assets: boolean
  /** 文件类附件下载上限（MB）；图片不受限 */
  maxFileMB: number
}

export interface PickerItem {
  id: string
  title: string
  updated: string
}

export interface PanelHandle {
  setStatus(text: string): void
  setProgress(done: number, total: number): void
  finish(): void
  /** 渲染对话多选列表（onPickList 拿到数据后调用） */
  showPicker(items: PickerItem[]): void
}

export interface PanelCallbacks {
  onStart(kind: ExportKind, panel: PanelHandle, opts: ExportOptions): void
  /** 用户点「选择对话…」：回调负责拉列表并调用 panel.showPicker */
  onPickList(panel: PanelHandle): void
  onExportSelection(ids: string[], panel: PanelHandle, opts: ExportOptions): void
  onCancel(): void
  onResetWatermark(): void
  settings: {
    maxFileMB: number
    onSettingsChange(maxFileMB: number): void
  }
}

const STYLE = `
  :host { all: initial; }
  * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  .fab {
    position: fixed; right: 20px; bottom: 88px; z-index: 2147483646;
    width: 44px; height: 44px; border-radius: 50%; border: none; cursor: pointer;
    background: #10a37f; color: #fff; font-size: 20px; line-height: 44px; text-align: center;
    box-shadow: 0 2px 10px rgba(0,0,0,.25);
  }
  .fab:hover { filter: brightness(1.1); }
  .panel {
    position: fixed; right: 20px; bottom: 142px; z-index: 2147483647;
    width: 320px; padding: 14px; border-radius: 12px;
    background: #fff; color: #111; box-shadow: 0 6px 28px rgba(0,0,0,.3);
    font-size: 13px; display: none; max-height: 70vh; overflow-y: auto;
  }
  .panel.open { display: block; }
  .title { font-weight: 700; font-size: 14px; margin-bottom: 10px; }
  .btns { display: flex; gap: 8px; margin-bottom: 8px; }
  button.act {
    flex: 1; padding: 7px 4px; border-radius: 8px; border: 1px solid #d0d0d0;
    background: #fafafa; cursor: pointer; font-size: 12px;
  }
  button.act:hover:not(:disabled) { background: #f0f0f0; }
  button.act:disabled { opacity: .5; cursor: default; }
  button.act.primary { background: #10a37f; border-color: #10a37f; color: #fff; }
  .opts { display: flex; flex-direction: column; gap: 4px; margin: 10px 0; color: #444; }
  .opts label { display: flex; align-items: center; gap: 6px; cursor: pointer; }
  .opts input[type="checkbox"] { margin: 0; }
  .opts input[type="number"] { width: 52px; padding: 1px 4px; border: 1px solid #ccc; border-radius: 4px; font-size: 12px; }
  .reset { border: none; background: none; color: #888; cursor: pointer; font-size: 11px; padding: 0; text-align: left; text-decoration: underline; }
  .picker { display: none; margin: 8px 0; border-top: 1px solid #eee; padding-top: 8px; }
  .picker.open { display: block; }
  .picker input[type="search"] {
    width: 100%; padding: 4px 6px; border: 1px solid #ccc; border-radius: 6px; font-size: 12px; margin-bottom: 6px;
  }
  .picker .tools { display: flex; gap: 6px; margin-bottom: 6px; }
  .picker .tools button {
    padding: 3px 8px; border-radius: 6px; border: 1px solid #d0d0d0; background: #fafafa;
    cursor: pointer; font-size: 11px;
  }
  .picker .list { max-height: 240px; overflow-y: auto; border: 1px solid #eee; border-radius: 6px; }
  .picker .row {
    display: flex; align-items: center; gap: 6px; padding: 3px 6px; cursor: pointer; font-size: 12px;
  }
  .picker .row:hover { background: #f5f5f5; }
  .picker .row.hidden { display: none; }
  .picker .row .t { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .picker .row .d { color: #999; font-size: 10px; flex-shrink: 0; }
  .picker .foot { display: flex; align-items: center; gap: 8px; margin-top: 6px; }
  .picker .foot .count { color: #666; font-size: 11px; flex: 1; }
  .status { min-height: 17px; color: #555; word-break: break-all; }
  progress { width: 100%; height: 8px; margin-top: 6px; display: none; }
  progress.visible { display: block; }
  .cancel {
    display: none; margin-top: 8px; width: 100%; padding: 6px; border-radius: 8px;
    border: 1px solid #e0b4b4; background: #fdf3f3; color: #b03030; cursor: pointer; font-size: 12px;
  }
  .cancel.visible { display: block; }
`

export function mountPanel(cb: PanelCallbacks): void {
  if (document.querySelector('[data-gexport]')) return
  const host = document.createElement('div')
  host.dataset['gexport'] = ''
  const root = host.attachShadow({ mode: 'open' })

  const style = document.createElement('style')
  style.textContent = STYLE
  root.append(style)

  const fab = document.createElement('button')
  fab.className = 'fab'
  fab.title = 'gexport：导出对话'
  fab.textContent = '⇩'

  const panel = document.createElement('div')
  panel.className = 'panel'
  panel.innerHTML = `
    <div class="title">gexport — 导出对话</div>
    <div class="btns">
      <button class="act primary" data-kind="markdown">Markdown zip</button>
      <button class="act" data-kind="json">原始 JSON zip</button>
    </div>
    <div class="btns">
      <button class="act" data-kind="single">只导出当前对话</button>
      <button class="act" data-pick>选择对话…</button>
    </div>
    <div class="picker">
      <input type="search" placeholder="搜索标题过滤…">
      <div class="tools">
        <button data-sel="all">全选可见</button>
        <button data-sel="invert">反选可见</button>
        <button data-sel="none">清空</button>
      </div>
      <div class="list"></div>
      <div class="foot">
        <span class="count">已选 0 条</span>
        <button class="act primary" data-export-selection disabled>导出所选</button>
      </div>
    </div>
    <div class="opts">
      <label><input type="checkbox" data-opt="incremental" checked> 增量：跳过未变化的对话</label>
      <label><input type="checkbox" data-opt="assets" checked> 下载附件（图片始终下载）</label>
      <label>文件附件上限 <input type="number" data-opt="maxFileMB" min="1" max="500" step="1" value="2"> MB</label>
      <button class="reset">重置增量记录（下次全量导出）</button>
    </div>
    <div class="status">就绪</div>
    <progress max="1" value="0"></progress>
    <button class="cancel">取消</button>
  `
  root.append(fab, panel)

  const statusEl = panel.querySelector<HTMLDivElement>('.status')!
  const progressEl = panel.querySelector<HTMLProgressElement>('progress')!
  const cancelEl = panel.querySelector<HTMLButtonElement>('.cancel')!
  const resetEl = panel.querySelector<HTMLButtonElement>('.reset')!
  const pickerEl = panel.querySelector<HTMLDivElement>('.picker')!
  const pickerList = pickerEl.querySelector<HTMLDivElement>('.list')!
  const pickerSearch = pickerEl.querySelector<HTMLInputElement>('input[type="search"]')!
  const pickerCount = pickerEl.querySelector<HTMLSpanElement>('.count')!
  const exportSelEl = pickerEl.querySelector<HTMLButtonElement>('[data-export-selection]')!
  const pickBtn = panel.querySelector<HTMLButtonElement>('[data-pick]')!
  const actionButtons = [
    ...panel.querySelectorAll<HTMLButtonElement>('button[data-kind], [data-pick], [data-export-selection]'),
  ]
  const optOf = (name: string) => panel.querySelector<HTMLInputElement>(`input[data-opt="${name}"]`)!.checked

  const maxFileEl = panel.querySelector<HTMLInputElement>('input[data-opt="maxFileMB"]')!
  maxFileEl.value = String(cb.settings.maxFileMB)
  const readMaxFileMB = () => {
    const v = Number(maxFileEl.value)
    return Number.isFinite(v) && v >= 1 ? Math.min(v, 500) : 2
  }
  maxFileEl.addEventListener('change', () => cb.settings.onSettingsChange(readMaxFileMB()))

  const readOpts = (): ExportOptions => ({
    incremental: optOf('incremental'),
    assets: optOf('assets'),
    maxFileMB: readMaxFileMB(),
  })

  const setRunning = (running: boolean) => {
    for (const b of actionButtons) b.disabled = running
    cancelEl.classList.toggle('visible', running)
    if (running) return
    cancelEl.disabled = false
    progressEl.classList.remove('visible')
    progressEl.value = 0
    updateSelCount()
  }

  const handle: PanelHandle = {
    setStatus: (text) => {
      statusEl.textContent = text
    },
    setProgress: (done, total) => {
      progressEl.classList.add('visible')
      progressEl.max = Math.max(1, total)
      progressEl.value = done
    },
    finish: () => setRunning(false),
    showPicker: (items) => {
      pickerList.innerHTML = ''
      for (const item of items) {
        const row = document.createElement('label')
        row.className = 'row'
        row.title = item.title
        const box = document.createElement('input')
        box.type = 'checkbox'
        box.dataset['id'] = item.id
        const t = document.createElement('span')
        t.className = 't'
        t.textContent = item.title || '(无标题)'
        const d = document.createElement('span')
        d.className = 'd'
        d.textContent = item.updated
        row.append(box, t, d)
        pickerList.append(row)
      }
      pickerSearch.value = ''
      pickerEl.classList.add('open')
      updateSelCount()
    },
  }

  const rows = () => [...pickerList.querySelectorAll<HTMLLabelElement>('.row')]
  const boxOf = (row: HTMLLabelElement) => row.querySelector<HTMLInputElement>('input')!
  const visibleRows = () => rows().filter((r) => !r.classList.contains('hidden'))
  const selectedIds = () =>
    rows()
      .map(boxOf)
      .filter((b) => b.checked)
      .map((b) => b.dataset['id']!)

  function updateSelCount(): void {
    const n = selectedIds().length
    pickerCount.textContent = `已选 ${n} 条`
    exportSelEl.disabled = n === 0
  }

  pickerSearch.addEventListener('input', () => {
    const q = pickerSearch.value.trim().toLowerCase()
    for (const row of rows()) {
      row.classList.toggle('hidden', q !== '' && !row.title.toLowerCase().includes(q))
    }
  })
  pickerList.addEventListener('change', updateSelCount)
  pickerEl.querySelector('[data-sel="all"]')!.addEventListener('click', () => {
    for (const r of visibleRows()) boxOf(r).checked = true
    updateSelCount()
  })
  pickerEl.querySelector('[data-sel="invert"]')!.addEventListener('click', () => {
    for (const r of visibleRows()) boxOf(r).checked = !boxOf(r).checked
    updateSelCount()
  })
  pickerEl.querySelector('[data-sel="none"]')!.addEventListener('click', () => {
    for (const r of rows()) boxOf(r).checked = false
    updateSelCount()
  })

  fab.addEventListener('click', () => panel.classList.toggle('open'))
  cancelEl.addEventListener('click', () => {
    cancelEl.disabled = true
    cb.onCancel()
  })
  resetEl.addEventListener('click', () => {
    cb.onResetWatermark()
    statusEl.textContent = '增量记录已清除，下次导出为全量'
  })
  pickBtn.addEventListener('click', () => {
    setRunning(true)
    cb.onPickList(handle)
  })
  exportSelEl.addEventListener('click', () => {
    const ids = selectedIds()
    if (ids.length === 0) return
    setRunning(true)
    cb.onExportSelection(ids, handle, readOpts())
  })
  for (const btn of panel.querySelectorAll<HTMLButtonElement>('button[data-kind]')) {
    btn.addEventListener('click', () => {
      setRunning(true)
      cb.onStart(btn.dataset['kind'] as ExportKind, handle, readOpts())
    })
  }

  document.body.append(host)
}
