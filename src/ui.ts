export type ExportFormat = 'markdown' | 'json'
export type ExportScope = 'current' | 'all' | 'selection'

export interface ExportOptions {
  /** 只导出上次以来有变化的对话（水位线见 state.ts），仅对「全部」范围生效 */
  incremental: boolean
  /** 下载图片/文件附件（关闭后导出快得多，请求量大幅减少） */
  assets: boolean
  /** 思维链（thoughts）是否写入导出 */
  thoughts: boolean
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
  /** ids 仅在 scope === 'selection' 时有意义 */
  onExport(
    scope: ExportScope,
    format: ExportFormat,
    ids: string[],
    panel: PanelHandle,
    opts: ExportOptions,
  ): void
  /** 范围切到「选择」时触发：回调负责拉列表并调用 panel.showPicker */
  onPickList(panel: PanelHandle): void
  onCancel(): void
  onResetWatermark(): void
  settings: {
    maxFileMB: number
    onSettingsChange(maxFileMB: number): void
  }
}

// 设计系统（ui-ux-pro-max 合成）：极简开发者工具面板，Linear 风
// —— 语义 token 双主题、发丝线边框、tabular 数字、150-200ms cubic-bezier(0.16,1,0.3,1) 微交互
const STYLE = `
  :host { all: initial; }
  :host {
    --bg: #ffffff; --fg: #171717; --muted: #6f6f6f;
    --border: rgba(0, 0, 0, .10); --hover: rgba(0, 0, 0, .045);
    --track: rgba(0, 0, 0, .05); --raised: #ffffff;
    --accent: #5e6ad2; --accent-hover: #6b77dd; --accent-fg: #ffffff;
    --danger: #b3372a; --cta-glow: none;
    --shadow: 0 12px 32px rgba(0, 0, 0, .14), 0 2px 8px rgba(0, 0, 0, .06);
    --ease: cubic-bezier(.16, 1, .3, 1);
    color-scheme: light;
  }
  :host([data-theme="dark"]) {
    --bg: #26262a; --fg: #ededef; --muted: #9a9aa3;
    --border: rgba(255, 255, 255, .09); --hover: rgba(255, 255, 255, .06);
    --track: rgba(255, 255, 255, .07); --raised: #3a3a40;
    --accent: #5e6ad2; --accent-hover: #6b77dd; --accent-fg: #ffffff;
    --danger: #e8836f; --cta-glow: 0 2px 14px rgba(94, 106, 210, .35);
    --shadow: 0 12px 32px rgba(0, 0, 0, .5), 0 2px 8px rgba(0, 0, 0, .3);
    color-scheme: dark;
  }
  * {
    box-sizing: border-box;
    font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  button { cursor: pointer; font-family: inherit; color: inherit; }
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  input[type="checkbox"] { accent-color: var(--accent); margin: 0; width: 14px; height: 14px; cursor: pointer; }

  .fab {
    position: fixed; right: 20px; bottom: 88px; z-index: 2147483646;
    width: 44px; height: 44px; border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    background: var(--bg); color: var(--fg); border: 1px solid var(--border);
    box-shadow: 0 4px 16px rgba(0, 0, 0, .18);
    transition: transform .15s var(--ease), box-shadow .15s var(--ease);
  }
  .fab:hover { transform: scale(1.06); }
  .fab:active { transform: scale(.94); }
  .fab svg { display: block; }

  .panel {
    position: fixed; right: 20px; bottom: 144px; z-index: 2147483647;
    width: 304px; padding: 16px; border-radius: 16px;
    background: var(--bg); color: var(--fg); border: 1px solid var(--border);
    box-shadow: var(--shadow); font-size: 13px; line-height: 1.5;
    display: none; max-height: 72vh; overflow-y: auto;
  }
  .panel.open { display: block; animation: rise .18s var(--ease); }
  @keyframes rise { from { opacity: 0; transform: translateY(8px); } }
  .head { font-size: 14px; font-weight: 600; letter-spacing: -.01em; }

  .sec {
    font-size: 10px; font-weight: 500; color: var(--muted);
    text-transform: uppercase; letter-spacing: .07em; margin: 14px 0 6px;
  }

  .seg { display: flex; gap: 2px; padding: 3px; border-radius: 10px; background: var(--track); }
  .seg button {
    flex: 1; padding: 6px 0; border: none; border-radius: 7px;
    background: transparent; color: var(--muted); font-size: 12px; font-weight: 500;
    transition: color .15s var(--ease), background .15s var(--ease);
  }
  .seg button:hover:not(:disabled):not(.on) { color: var(--fg); }
  .seg button.on { background: var(--raised); color: var(--fg); box-shadow: 0 1px 4px rgba(0, 0, 0, .18); }
  .seg button:disabled { cursor: default; opacity: .5; }

  .picker { display: none; margin-top: 8px; }
  .picker.open { display: block; }
  .picker input[type="search"] {
    width: 100%; padding: 6px 9px; border: 1px solid var(--border); border-radius: 8px;
    font-size: 12px; margin-bottom: 6px; background: transparent; color: var(--fg); outline: none;
    transition: border-color .15s var(--ease);
  }
  .picker input[type="search"]::placeholder { color: var(--muted); }
  .picker input[type="search"]:focus { border-color: var(--accent); }
  .picker .tools { display: flex; gap: 4px; margin-bottom: 6px; }
  .picker .tools button {
    padding: 4px 9px; border-radius: 7px; border: 1px solid var(--border);
    background: transparent; font-size: 11px;
    transition: background .15s var(--ease);
  }
  .picker .tools button:hover:not(:disabled) { background: var(--hover); }
  .picker .tools button:disabled { cursor: default; opacity: .5; }
  .picker .list { max-height: 200px; overflow-y: auto; border: 1px solid var(--border); border-radius: 8px; }
  .picker .row { display: flex; align-items: center; gap: 7px; padding: 5px 9px; cursor: pointer; font-size: 12px; }
  .picker .row:hover { background: var(--hover); }
  .picker .row.hidden { display: none; }
  .picker .row .t { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .picker .row .d { color: var(--muted); font-size: 10px; flex-shrink: 0; font-variant-numeric: tabular-nums; }
  .picker .empty { display: none; padding: 14px 0; text-align: center; color: var(--muted); font-size: 12px; }
  .picker .empty.visible { display: block; }
  .picker .count { color: var(--muted); font-size: 11px; margin-top: 5px; font-variant-numeric: tabular-nums; }

  .adv-toggle {
    display: flex; align-items: center; gap: 4px; margin-top: 14px; padding: 0;
    border: none; background: none; color: var(--muted);
    font-size: 10px; font-weight: 500; text-transform: uppercase; letter-spacing: .07em;
    transition: color .15s var(--ease);
  }
  .adv-toggle:hover { color: var(--fg); }
  .adv-toggle svg { transition: transform .18s var(--ease); }
  .adv-toggle.open svg { transform: rotate(90deg); }
  .adv { display: none; margin-top: 6px; padding: 4px 12px 10px; border: 1px solid var(--border); border-radius: 10px; }
  .adv.open { display: block; }
  .adv .row {
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
    padding: 6px 0; cursor: pointer;
    transition: opacity .15s var(--ease);
  }
  .adv .row.dis { opacity: .4; pointer-events: none; }
  .adv input[type="number"] {
    width: 56px; padding: 2px 6px; border: 1px solid var(--border); border-radius: 6px;
    font-size: 12px; background: transparent; color: var(--fg);
    text-align: right; font-variant-numeric: tabular-nums; outline: none;
    transition: border-color .15s var(--ease);
  }
  .adv input[type="number"]:focus { border-color: var(--accent); }
  .reset {
    margin-top: 4px; padding: 0; border: none; background: none; color: var(--muted);
    font-size: 11px; text-decoration: underline; text-underline-offset: 2px;
    transition: color .15s var(--ease);
  }
  .reset:hover { color: var(--fg); }

  .go {
    margin-top: 14px; width: 100%; padding: 9px; border-radius: 10px; border: none;
    background: var(--accent); color: var(--accent-fg); box-shadow: var(--cta-glow);
    font-size: 13px; font-weight: 600;
    transition: background .15s var(--ease), transform .1s var(--ease);
  }
  .go:hover:not(:disabled) { background: var(--accent-hover); }
  .go:active:not(:disabled) { transform: scale(.98); }
  .go:disabled { opacity: .45; cursor: default; box-shadow: none; }

  .status {
    min-height: 18px; margin-top: 10px; color: var(--muted); font-size: 12px;
    word-break: break-all; font-variant-numeric: tabular-nums;
  }
  progress { width: 100%; height: 4px; margin-top: 6px; display: none; accent-color: var(--accent); }
  progress.visible { display: block; }
  .cancel {
    display: none; margin-top: 8px; width: 100%; padding: 6px; border-radius: 10px;
    border: 1px solid var(--border); background: transparent; color: var(--danger); font-size: 12px;
    transition: background .15s var(--ease);
  }
  .cancel:hover:not(:disabled) { background: var(--hover); }
  .cancel.visible { display: block; }

  @media (prefers-reduced-motion: reduce) {
    * { animation: none !important; transition: none !important; }
  }
`

// 图标统一 Lucide 线型、stroke 2（icon-style-consistent）
const ICON_DOWNLOAD = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>`
const ICON_CHEVRON = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg>`
const ICON_RELOAD = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36L21 8"/><path d="M21 3v5h-5"/></svg>`

export function mountPanel(cb: PanelCallbacks): void {
  if (document.querySelector('[data-inkstone]')) return
  const host = document.createElement('div')
  host.dataset['inkstone'] = ''
  const root = host.attachShadow({ mode: 'open' })

  // 跟随 ChatGPT 主题（html.dark class）
  const syncTheme = () => {
    host.dataset['theme'] = document.documentElement.classList.contains('dark') ? 'dark' : 'light'
  }
  syncTheme()
  new MutationObserver(syncTheme).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class'],
  })

  const style = document.createElement('style')
  style.textContent = STYLE
  root.append(style)

  const fab = document.createElement('button')
  fab.className = 'fab'
  fab.title = 'Inkstone — 导出对话'
  fab.setAttribute('aria-label', 'Inkstone — 导出对话')
  fab.innerHTML = ICON_DOWNLOAD

  const panel = document.createElement('div')
  panel.className = 'panel'
  panel.setAttribute('role', 'dialog')
  panel.setAttribute('aria-label', '导出对话')
  panel.innerHTML = `
    <div class="head">导出对话</div>

    <div class="sec">范围</div>
    <div class="seg" data-seg="scope">
      <button data-v="current" class="on" aria-pressed="true">当前对话</button>
      <button data-v="all" aria-pressed="false">全部</button>
      <button data-v="selection" aria-pressed="false">选择…</button>
    </div>
    <div class="picker">
      <input type="search" placeholder="搜索标题过滤…" aria-label="搜索标题过滤">
      <div class="tools">
        <button data-sel="all">全选</button>
        <button data-sel="invert">反选</button>
        <button data-sel="none">清空</button>
        <button data-sel="reload" title="重新拉取列表" aria-label="重新拉取列表">${ICON_RELOAD}</button>
      </div>
      <div class="list"></div>
      <div class="empty">没有匹配的对话</div>
      <div class="count">已选 0 条</div>
    </div>

    <div class="sec">格式</div>
    <div class="seg" data-seg="format">
      <button data-v="markdown" class="on" aria-pressed="true">Markdown</button>
      <button data-v="json" aria-pressed="false">JSON</button>
    </div>

    <button class="adv-toggle" aria-expanded="false">${ICON_CHEVRON} 高级设置</button>
    <div class="adv">
      <label class="row" data-row="incremental"><span>增量：跳过未变化的对话</span><input type="checkbox" data-opt="incremental" checked></label>
      <label class="row" data-row="assets"><span>下载附件（图片始终下载）</span><input type="checkbox" data-opt="assets" checked></label>
      <label class="row" data-row="thoughts"><span>写入思考过程</span><input type="checkbox" data-opt="thoughts" checked></label>
      <label class="row" data-row="maxFileMB"><span>文件附件上限（MB）</span><input type="number" data-opt="maxFileMB" min="1" max="500" step="1" value="2"></label>
      <button class="reset">重置增量记录（下次全量导出）</button>
    </div>

    <button class="go">导出当前对话</button>
    <div class="status" role="status" aria-live="polite">就绪</div>
    <progress max="1" value="0"></progress>
    <button class="cancel">取消</button>
  `
  root.append(fab, panel)

  const $ = <T extends HTMLElement>(sel: string) => panel.querySelector<T>(sel)!
  const statusEl = $<HTMLDivElement>('.status')
  const progressEl = $<HTMLProgressElement>('progress')
  const cancelEl = $<HTMLButtonElement>('.cancel')
  const goEl = $<HTMLButtonElement>('.go')
  const advToggle = $<HTMLButtonElement>('.adv-toggle')
  const advEl = $<HTMLDivElement>('.adv')
  const pickerEl = $<HTMLDivElement>('.picker')
  const pickerList = pickerEl.querySelector<HTMLDivElement>('.list')!
  const pickerSearch = pickerEl.querySelector<HTMLInputElement>('input[type="search"]')!
  const pickerEmpty = pickerEl.querySelector<HTMLDivElement>('.empty')!
  const pickerCount = pickerEl.querySelector<HTMLSpanElement>('.count')!
  const segButtons = [...panel.querySelectorAll<HTMLButtonElement>('.seg button')]
  const toolButtons = [...pickerEl.querySelectorAll<HTMLButtonElement>('.tools button')]

  let scope: ExportScope = 'current'
  let format: ExportFormat = 'markdown'
  let listLoaded = false
  let running = false

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
    thoughts: optOf('thoughts'),
    maxFileMB: readMaxFileMB(),
  })

  const rows = () => [...pickerList.querySelectorAll<HTMLLabelElement>('.row')]
  const boxOf = (row: HTMLLabelElement) => row.querySelector<HTMLInputElement>('input')!
  const visibleRows = () => rows().filter((r) => !r.classList.contains('hidden'))
  const selectedIds = () =>
    rows()
      .map(boxOf)
      .filter((b) => b.checked)
      .map((b) => b.dataset['id']!)

  // 范围/格式变化后统一刷新：选项可用性、空状态、主按钮文案与可点性
  function refresh(): void {
    pickerEl.classList.toggle('open', scope === 'selection')
    pickerEmpty.classList.toggle('visible', listLoaded && visibleRows().length === 0)
    advEl.querySelector('[data-row="incremental"]')!.classList.toggle('dis', scope !== 'all')
    for (const name of ['assets', 'thoughts', 'maxFileMB']) {
      advEl.querySelector(`[data-row="${name}"]`)!.classList.toggle('dis', format === 'json')
    }
    const n = selectedIds().length
    pickerCount.textContent = `已选 ${n} 条`
    goEl.textContent =
      scope === 'current' ? '导出当前对话' : scope === 'all' ? '导出全部对话' : `导出所选（${n} 条）`
    goEl.disabled = running || (scope === 'selection' && n === 0)
  }

  function setRunning(r: boolean): void {
    running = r
    for (const b of [...segButtons, ...toolButtons]) b.disabled = r
    cancelEl.classList.toggle('visible', r)
    if (!r) {
      cancelEl.disabled = false
      progressEl.classList.remove('visible')
      progressEl.value = 0
    }
    refresh()
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
      listLoaded = true
      refresh()
    },
  }

  function loadList(): void {
    setRunning(true)
    cb.onPickList(handle)
  }

  for (const btn of segButtons) {
    btn.addEventListener('click', () => {
      const group = btn.parentElement!.dataset['seg']!
      for (const b of btn.parentElement!.querySelectorAll('button')) {
        b.classList.toggle('on', b === btn)
        b.setAttribute('aria-pressed', String(b === btn))
      }
      if (group === 'scope') {
        scope = btn.dataset['v'] as ExportScope
        if (scope === 'selection' && !listLoaded) loadList()
      } else {
        format = btn.dataset['v'] as ExportFormat
      }
      refresh()
    })
  }

  pickerSearch.addEventListener('input', () => {
    const q = pickerSearch.value.trim().toLowerCase()
    for (const row of rows()) {
      row.classList.toggle('hidden', q !== '' && !row.title.toLowerCase().includes(q))
    }
    refresh()
  })
  pickerList.addEventListener('change', refresh)
  pickerEl.querySelector('[data-sel="all"]')!.addEventListener('click', () => {
    for (const r of visibleRows()) boxOf(r).checked = true
    refresh()
  })
  pickerEl.querySelector('[data-sel="invert"]')!.addEventListener('click', () => {
    for (const r of visibleRows()) boxOf(r).checked = !boxOf(r).checked
    refresh()
  })
  pickerEl.querySelector('[data-sel="none"]')!.addEventListener('click', () => {
    for (const r of rows()) boxOf(r).checked = false
    refresh()
  })
  pickerEl.querySelector('[data-sel="reload"]')!.addEventListener('click', loadList)

  advToggle.addEventListener('click', () => {
    const open = advToggle.classList.toggle('open')
    advEl.classList.toggle('open', open)
    advToggle.setAttribute('aria-expanded', String(open))
  })

  fab.addEventListener('click', () => panel.classList.toggle('open'))
  cancelEl.addEventListener('click', () => {
    cancelEl.disabled = true
    cb.onCancel()
  })
  $<HTMLButtonElement>('.reset').addEventListener('click', () => {
    cb.onResetWatermark()
    statusEl.textContent = '增量记录已清除，下次导出为全量'
  })
  goEl.addEventListener('click', () => {
    const ids = scope === 'selection' ? selectedIds() : []
    if (scope === 'selection' && ids.length === 0) return
    setRunning(true)
    cb.onExport(scope, format, ids, handle, readOpts())
  })

  refresh()
  document.body.append(host)
}
