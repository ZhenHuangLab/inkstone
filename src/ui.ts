import { sanitizeSubdir } from './core/render'
import type { SiteUi } from './sites'

export type ExportFormat = 'markdown' | 'json'
export type ExportScope = 'current' | 'all' | 'selection'

export interface ExportOptions {
  /** 只导出上次以来有变化的对话（水位线见 state.ts），仅对「全部」范围生效 */
  incremental: boolean
  /** 下载图片/文件附件（关闭后导出快得多，请求量大幅减少） */
  assets: boolean
  /** 思维链（thoughts）是否写入导出 */
  thoughts: boolean
  /** 工具运行痕迹（发给工具的代码/搜索请求与运行输出）是否写入导出，默认不写入 */
  toolTraces: boolean
  /** 文件类附件下载上限（MB）；图片不受限 */
  maxFileMB: number
  /** 附件链接风格 */
  linkStyle: 'wikilink' | 'markdown'
  /** 消息内标题处理 */
  headingMode: 'demote' | 'strip'
  /** 输出目标：下载 zip / File System Access 直写文件夹 */
  target: 'zip' | 'folder'
  /** 笔记子文件夹；空串 = 根目录 */
  notesDir: string
  /** 附件子文件夹，相对笔记所在目录；空串 = 与笔记同层 */
  attachmentsDir: string
}

/** 面板需要持久化的设置值（与 state.ts 的 Settings 结构兼容）。 */
export interface PanelSettings {
  maxFileMB: number
  linkStyle: 'wikilink' | 'markdown'
  headingMode: 'demote' | 'strip'
  target: 'zip' | 'folder'
  notesDir: string
  attachmentsDir: string
  /** 按钮位置：输入框旁（玻璃圆钮）或顶部 Share 左侧（原生幽灵钮） */
  fabPos: 'composer' | 'header'
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
  /** 追加一页对话到多选列表；done=true 表示列表已到底 */
  appendPicker(items: PickerItem[], done: boolean): void
  /** 清空多选列表（重新拉取前调用） */
  clearPicker(): void
  /** 某一页拉取失败：解除加载中状态，允许再次触发 */
  pickerLoadFailed(): void
}

export interface PanelCallbacks {
  /** 当前站点：决定标题文案与批量入口是否出现 */
  site: { id: string; label: string; supportsBatch: boolean }
  /** 站点专属的锚点与配色探测 */
  siteUi: SiteUi
  /** ids 仅在 scope === 'selection' 时有意义 */
  onExport(
    scope: ExportScope,
    format: ExportFormat,
    ids: string[],
    panel: PanelHandle,
    opts: ExportOptions,
  ): void
  /** 首次切到「选择」或点重新拉取：回调负责重置分页并拉第一页 */
  onPickList(panel: PanelHandle): void
  /** 列表滚到底部：回调负责拉下一页并调用 panel.appendPicker */
  onPickMore(panel: PanelHandle): void
  onCancel(): void
  onResetWatermark(): void
  /** target=folder 时点「重新选择文件夹」：忘掉记住的目录句柄 */
  onForgetFolder(): void
  settings: {
    values: PanelSettings
    /** 浏览器支持 File System Access（Chromium 系）才允许选「文件夹」 */
    supportsFolder: boolean
    onSettingsChange(patch: Partial<PanelSettings>): void
  }
}

// 设计系统（ui-ux-pro-max 合成）：Apple 液态玻璃（Liquid Glass）
// 主色跟随当前页面：运行时探测 ChatGPT 的 accent 自定义属性（用户可在 ChatGPT 里改主题色），
// 探测不到时用黑/白中性兜底（即 ChatGPT 默认配色的发送键观感）；下方 token 只是兜底值。
// 轻量约束：backdrop-filter 只上 fab/panel 两层（面板 display:none 时零渲染开销），
// 面板内部一律普通半透明填充不嵌套玻璃；动效只走 transform/opacity（绝不动 blur/filter）；
// 高光扫过用纯 transform 位移；不用色差/SVG morphing/hue-rotate 这类高开销滤镜。
const STYLE = `
  :host { all: initial; }
  :host {
    --fg: #0d0d0d; --muted: #5d5d63;
    --glass: rgba(255, 255, 255, .62); --solid: #f7f7f8;
    --edge: rgba(255, 255, 255, .65);
    --border: rgba(13, 13, 13, .08);
    --hover: rgba(13, 13, 13, .05); --track: rgba(13, 13, 13, .06);
    --thumb: rgba(255, 255, 255, .9);
    --accent: #0d0d0d; --accent-hover: #3a3a3a; --accent-fg: #ffffff;
    --ring: #0d0d0d; --danger: #b3372a;
    --sheen: rgba(255, 255, 255, .5);
    --cta-glow: 0 5px 18px rgba(0, 0, 0, .22);
    --shadow: 0 16px 48px rgba(0, 0, 0, .16), 0 2px 10px rgba(0, 0, 0, .06);
    --ease: cubic-bezier(.16, 1, .3, 1);
    color-scheme: light;
  }
  :host([data-theme="dark"]) {
    --fg: #f2f2f3; --muted: #a0a0a9;
    --glass: rgba(30, 30, 34, .62); --solid: #2c2c31;
    --edge: rgba(255, 255, 255, .12);
    --border: rgba(255, 255, 255, .10);
    --hover: rgba(255, 255, 255, .07); --track: rgba(255, 255, 255, .08);
    --thumb: rgba(255, 255, 255, .17);
    --accent: #ececec; --accent-hover: #ffffff; --accent-fg: #0d0d0d;
    --ring: #ececec; --danger: #e8836f;
    --sheen: rgba(255, 255, 255, .22);
    --cta-glow: 0 5px 18px rgba(0, 0, 0, .45);
    --shadow: 0 16px 48px rgba(0, 0, 0, .55), 0 2px 10px rgba(0, 0, 0, .3);
    color-scheme: dark;
  }
  * {
    box-sizing: border-box;
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", Inter, "Segoe UI", Roboto, sans-serif;
  }
  button { cursor: pointer; font-family: inherit; color: inherit; }
  :focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
  input[type="checkbox"] { accent-color: var(--accent); margin: 0; width: 14px; height: 14px; cursor: pointer; }

  .fab {
    position: fixed; right: var(--fab-right, 20px); bottom: var(--fab-bottom, 88px); z-index: 2147483646;
    width: 44px; height: 44px; border-radius: 50%; overflow: hidden;
    visibility: hidden; /* 定位完成（.in）前不现身，避免从默认角落跳到输入框旁 */
    color: var(--fg); border: 1px solid var(--border);
    background: var(--glass);
    -webkit-backdrop-filter: blur(16px) saturate(180%);
    backdrop-filter: blur(16px) saturate(180%);
    box-shadow: inset 0 1px 0 var(--edge), 0 6px 20px rgba(0, 0, 0, .18);
    /* right/bottom 过渡只在布局变化的一瞬生效（侧栏开合、输入框长高），平时零开销 */
    transition: transform .15s var(--ease), background-color .2s var(--ease), color .2s var(--ease),
      right .25s var(--ease), bottom .25s var(--ease);
  }
  .fab.in { visibility: visible; animation: pop .3s var(--ease); }
  @keyframes pop { from { opacity: 0; transform: scale(.5); } }
  .fab:hover { transform: scale(1.06); }
  .fab:active { transform: scale(.94); }
  .fab svg { display: block; }
  .fab .ic {
    position: absolute; inset: 0;
    display: flex; align-items: center; justify-content: center;
    transition: opacity .18s var(--ease), transform .22s var(--ease);
  }
  .fab .ic-arrow { opacity: 0; transform: translateY(-9px); }
  .fab.open { background: var(--accent); color: var(--accent-fg); border-color: transparent;
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, .28), var(--cta-glow); }
  .fab.open .ic-dl { opacity: 0; transform: translateY(9px); }
  .fab.open .ic-arrow { opacity: 1; transform: none; }
  .fab::after {
    content: ""; position: absolute; inset: 0; pointer-events: none;
    background: linear-gradient(115deg, transparent 35%, var(--sheen) 50%, transparent 65%);
    transform: translateX(-130%);
  }
  .fab:hover::after { transform: translateX(130%); transition: transform .6s ease; }

  /* header 模式：仿 ChatGPT 顶栏 Share/「…」——36px、圆角 8px、
     底色照抄页面 translucent-surface（透明 + blur(24px) 液态玻璃，无阴影），
     悬浮才出圆角矩形底色；无高光扫过 */
  :host([data-pos="header"]) .fab {
    width: 36px; height: 36px; border-radius: 8px;
    background: transparent; border-color: transparent; box-shadow: none;
    -webkit-backdrop-filter: blur(24px); backdrop-filter: blur(24px);
  }
  :host([data-pos="header"]) .fab.in { animation: fadein .2s var(--ease); }
  :host([data-pos="header"]) .fab:hover { background: var(--hover); transform: none; }
  :host([data-pos="header"]) .fab:active { background: var(--track); transform: none; }
  :host([data-pos="header"]) .fab::after { content: none; }
  :host([data-pos="header"]) .fab.open {
    background: var(--hover); color: var(--fg); border-color: transparent; box-shadow: none;
  }
  @keyframes fadein { from { opacity: 0; } }

  .panel {
    position: fixed; right: var(--fab-right, 20px); bottom: calc(var(--fab-bottom, 88px) + 56px); z-index: 2147483647;
    width: 304px; padding: 16px; border-radius: 20px;
    color: var(--fg); border: 1px solid var(--border);
    background: var(--glass);
    -webkit-backdrop-filter: blur(24px) saturate(180%);
    backdrop-filter: blur(24px) saturate(180%);
    box-shadow: inset 0 1px 0 var(--edge), var(--shadow);
    font-size: 13px; line-height: 1.5;
    display: none; overflow-y: auto;
    max-height: min(72vh, calc(100vh - var(--fab-bottom, 88px) - 72px));
    max-width: calc(100vw - 32px);
    transform-origin: 100% 100%;
    transition: right .25s var(--ease), bottom .25s var(--ease);
  }
  .panel.open { display: block; animation: rise .22s var(--ease); }
  @keyframes rise { from { opacity: 0; transform: translateY(10px) scale(.97); } }
  /* header 模式：面板从按钮下方展开 */
  :host([data-pos="header"]) .panel {
    bottom: auto; top: var(--panel-top, 56px);
    max-height: min(72vh, calc(100vh - var(--panel-top, 56px) - 24px));
    transform-origin: 100% 0;
  }
  :host([data-pos="header"]) .panel.open { animation-name: drop; }
  @keyframes drop { from { opacity: 0; transform: translateY(-10px) scale(.97); } }
  .head { font-size: 14px; font-weight: 600; letter-spacing: -.01em; }

  .sec {
    font-size: 10px; font-weight: 500; color: var(--muted);
    text-transform: uppercase; letter-spacing: .07em; margin: 14px 0 6px;
  }

  .seg { display: flex; gap: 2px; padding: 3px; border-radius: 11px; background: var(--track); }
  .seg button {
    flex: 1; padding: 6px 0; border: none; border-radius: 8px;
    background: transparent; color: var(--muted); font-size: 12px; font-weight: 500;
    transition: color .15s var(--ease), background .15s var(--ease);
  }
  .seg button:hover:not(:disabled):not(.on) { color: var(--fg); }
  .seg button.on {
    background: var(--thumb); color: var(--fg);
    box-shadow: inset 0 1px 0 var(--edge), 0 1px 5px rgba(0, 0, 0, .16);
  }
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
  .picker .sentinel { padding: 7px 0; text-align: center; color: var(--muted); font-size: 11px; }
  .picker .sentinel:empty { padding: 0; }
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
  .adv input[type="text"] {
    width: 118px; padding: 2px 6px; border: 1px solid var(--border); border-radius: 6px;
    font-size: 12px; background: transparent; color: var(--fg); outline: none;
    transition: border-color .15s var(--ease);
  }
  .adv input[type="text"]:focus { border-color: var(--accent); }
  .adv input[type="text"]::placeholder { color: var(--muted); }
  .adv select {
    padding: 2px 6px; border: 1px solid var(--border); border-radius: 6px;
    font-size: 12px; background: var(--solid); color: var(--fg); outline: none;
    transition: border-color .15s var(--ease);
  }
  .adv select:focus { border-color: var(--accent); }
  .reset {
    margin-top: 4px; padding: 0; border: none; background: none; color: var(--muted);
    font-size: 11px; text-decoration: underline; text-underline-offset: 2px;
    transition: color .15s var(--ease);
  }
  .reset:hover { color: var(--fg); }

  .go {
    margin-top: 14px; width: 100%; padding: 9px; border-radius: 12px; border: none;
    position: relative; overflow: hidden;
    background: var(--accent); color: var(--accent-fg);
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, .28), var(--cta-glow);
    font-size: 13px; font-weight: 600;
    transition: background .15s var(--ease), transform .1s var(--ease);
  }
  .go::after {
    content: ""; position: absolute; inset: 0; pointer-events: none;
    background: linear-gradient(115deg, transparent 35%, rgba(255, 255, 255, .3) 50%, transparent 65%);
    transform: translateX(-130%);
  }
  .go:hover:not(:disabled) { background: var(--accent-hover); }
  .go:hover:not(:disabled)::after { transform: translateX(130%); transition: transform .6s ease; }
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

  /* 玻璃降级：不支持 backdrop-filter 或用户偏好降低透明度时改用实色 */
  @supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
    .fab, .panel { background: var(--solid); }
  }
  @media (prefers-reduced-transparency: reduce) {
    .fab, .panel, :host([data-pos="header"]) .fab {
      background: var(--solid);
      -webkit-backdrop-filter: none; backdrop-filter: none;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    * { animation: none !important; transition: none !important; }
  }
`

// 图标统一 Lucide 线型、stroke 2（icon-style-consistent）
const ICON_DOWNLOAD = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>`
const ICON_ARROW_DOWN = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14"/><path d="m19 12-7 7-7-7"/></svg>`
const ICON_CHEVRON = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg>`
const ICON_RELOAD = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36L21 8"/><path d="M21 3v5h-5"/></svg>`

export function mountPanel(cb: PanelCallbacks): void {
  if (document.querySelector('[data-inkstone]')) return
  const host = document.createElement('div')
  host.dataset['inkstone'] = ''
  const root = host.attachShadow({ mode: 'open' })

  // —— 主色跟随当前页面 ——
  // ChatGPT 的 accent 方案（2026-07 实测）：html[data-chat-theme="purple"] + 每主题一族变量
  // --{theme}-theme-submit-btn-bg/-text（发送键配色）与 --{theme}-theme-entity-accent。
  // 直接读当前主题的发送键变量作主色；改版后变量消失时退回「扫根节点含 accent 的最饱和颜色」，
  // 再不行维持样式表黑/白中性兜底。开销：常规路径每次 3 个 getPropertyValue，全量扫描仅兜底时发生。
  let probe: HTMLSpanElement | null = null
  const parseColor = (raw: string): [number, number, number] | null => {
    const s = raw.trim()
    if (!s) return null
    // Tailwind 风格裸三元组「137 82 238」
    const t = /^(\d{1,3})[ ,]+(\d{1,3})[ ,]+(\d{1,3})$/.exec(s)
    if (t) return [Math.min(255, Number(t[1])), Math.min(255, Number(t[2])), Math.min(255, Number(t[3]))]
    if (!CSS.supports('color', s)) return null
    if (!probe) {
      probe = document.createElement('span')
      probe.style.display = 'none'
    }
    if (!probe.isConnected) document.body.append(probe)
    probe.style.color = s
    const c = getComputedStyle(probe).color
    const m = /^rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?\)/.exec(c)
    if (m) {
      if (m[4] !== undefined && Number(m[4]) < 0.9) return null
      return [Number(m[1]), Number(m[2]), Number(m[3])]
    }
    // ChatGPT 部分变量是 color(display-p3 …)；按 sRGB 读，色差可忽略
    const p = /^color\((?:srgb|display-p3)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\)/.exec(c)
    if (p) {
      if (p[4] !== undefined && Number(p[4]) < 0.9) return null
      return [
        Math.round(Number(p[1]) * 255),
        Math.round(Number(p[2]) * 255),
        Math.round(Number(p[3]) * 255),
      ]
    }
    return null
  }
  let accentApplied = ''
  const applyAccent = (
    bg: [number, number, number],
    fgIn: [number, number, number] | null,
    ringIn: [number, number, number] | null,
  ): void => {
    const [r, g, b] = bg
    const ring = ringIn ?? bg
    const key = `${r},${g},${b}|${fgIn?.join() ?? ''}|${ring.join()}`
    if (key === accentApplied) return
    accentApplied = key
    const lin = (c: number) => {
      const s = c / 255
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
    }
    const L = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
    // 页面没给文字色时自选：白字对比度够 4.5:1 就用白，否则近黑
    const fg = fgIn ?? (1.05 / (L + 0.05) >= 4.5 ? [255, 255, 255] : [13, 13, 13])
    // hover：暗色变亮、亮色变暗各挪约一成
    const toward = L < 0.5 ? 255 : 0
    const hov = bg.map((c) => Math.round(c + (toward - c) * 0.12))
    host.style.setProperty('--accent', `rgb(${r} ${g} ${b})`)
    host.style.setProperty('--accent-hover', `rgb(${hov[0]} ${hov[1]} ${hov[2]})`)
    host.style.setProperty('--accent-fg', `rgb(${fg[0]} ${fg[1]} ${fg[2]})`)
    host.style.setProperty('--ring', `rgb(${ring[0]} ${ring[1]} ${ring[2]})`)
    host.style.setProperty('--cta-glow', `0 5px 18px rgba(${r}, ${g}, ${b}, .3)`)
  }
  let accentScanTick = 0
  const detectAccent = (force = false): void => {
    const rootEl = document.documentElement
    // 站点专属探测优先（各家主色变量命名不同）；探测不到再走下面的通用扫描
    const hit = cb.siteUi.accent(parseColor)
    if (hit) {
      applyAccent(hit.bg, hit.fg, hit.ring)
      return
    }
    // 改版兜底：扫 html/body 上含 accent 的自定义属性，取最饱和的可解析颜色
    if (!force && accentScanTick++ % 15 !== 0) return
    let best: [number, number, number] | null = null
    let bestSat = 24 // 饱和度阈值，滤掉灰白黑
    for (const el of [rootEl, document.body]) {
      const map = (
        el as HTMLElement & { computedStyleMap?: () => Iterable<[string, unknown]> }
      ).computedStyleMap?.()
      if (!map) continue
      for (const [name, values] of map) {
        if (!name.startsWith('--') || !name.toLowerCase().includes('accent')) continue
        const rgb = parseColor(String(Array.isArray(values) ? (values[0] ?? '') : values))
        if (!rgb) continue
        const sat = Math.max(...rgb) - Math.min(...rgb)
        if (sat > bestSat) {
          bestSat = sat
          best = rgb
        }
      }
    }
    if (best) applyAccent(best, null, null)
  }

  // 跟随页面的明暗与主题色设置（判定方式由站点适配器给）
  const syncTheme = () => {
    host.dataset['theme'] = cb.siteUi.isDark() ? 'dark' : 'light'
    detectAccent(true) // 明暗/主题色切换时 accent 值跟着变
  }
  syncTheme()
  new MutationObserver(syncTheme).observe(document.documentElement, {
    attributes: true,
    attributeFilter: cb.siteUi.themeAttributes,
  })

  const style = document.createElement('style')
  style.textContent = STYLE
  root.append(style)

  const fab = document.createElement('button')
  fab.className = 'fab'
  fab.title = `Inkstone — 导出 ${cb.site.label} 对话`
  fab.setAttribute('aria-label', `Inkstone — 导出 ${cb.site.label} 对话`)
  fab.setAttribute('aria-haspopup', 'dialog')
  fab.setAttribute('aria-expanded', 'false')
  // 关闭态 = 下载图标；打开态 = 向下箭头（收起面板），两层交叉淡出
  fab.innerHTML = `<span class="ic ic-dl">${ICON_DOWNLOAD}</span><span class="ic ic-arrow">${ICON_ARROW_DOWN}</span>`

  const panel = document.createElement('div')
  panel.className = 'panel'
  panel.setAttribute('role', 'dialog')
  panel.setAttribute('aria-label', '导出对话')
  // 批量能力未开放的站点直接不出现「全部 / 选择…」——按钮存在但点不动，
  // 比它根本不出现更让人困惑
  const batchAttr = cb.site.supportsBatch ? '' : ' hidden'
  panel.innerHTML = `
    <div class="head">导出 ${cb.site.label} 对话</div>

    <div class="sec">范围</div>
    <div class="seg" data-seg="scope">
      <button data-v="current" class="on" aria-pressed="true">当前对话</button>
      <button data-v="all" aria-pressed="false"${batchAttr}>全部</button>
      <button data-v="selection" aria-pressed="false"${batchAttr}>选择…</button>
    </div>
    <div class="picker">
      <input type="search" placeholder="搜索标题过滤…" aria-label="搜索标题过滤">
      <div class="tools">
        <button data-sel="all">全选</button>
        <button data-sel="invert">反选</button>
        <button data-sel="none">清空</button>
        <button data-sel="reload" title="重新拉取列表" aria-label="重新拉取列表">${ICON_RELOAD}</button>
      </div>
      <div class="list"><div class="sentinel"></div></div>
      <div class="empty">没有匹配的对话</div>
      <div class="count">已选 0 条</div>
    </div>

    <div class="sec">格式</div>
    <div class="seg" data-seg="format">
      <button data-v="markdown" class="on" aria-pressed="true">Markdown</button>
      <button data-v="json" aria-pressed="false">JSON</button>
    </div>

    <div class="sec">输出到</div>
    <div class="seg" data-seg="target">
      <button data-v="zip" class="on" aria-pressed="true">下载 zip</button>
      <button data-v="folder" aria-pressed="false">直写文件夹</button>
    </div>

    <button class="adv-toggle" aria-expanded="false">${ICON_CHEVRON} 高级设置</button>
    <div class="adv">
      <label class="row" data-row="fabPos"><span>按钮位置</span><select data-opt="fabPos">
        <option value="composer">输入框旁</option>
        <option value="header">顶部 Share 左侧</option>
      </select></label>
      <label class="row" data-row="incremental"><span>增量：跳过未变化的对话</span><input type="checkbox" data-opt="incremental" checked></label>
      <label class="row" data-row="assets"><span>下载附件（图片始终下载）</span><input type="checkbox" data-opt="assets" checked></label>
      <label class="row" data-row="thoughts"><span>写入思考过程</span><input type="checkbox" data-opt="thoughts"></label>
      <label class="row" data-row="toolTraces"><span>写入工具过程（代码执行/搜索）</span><input type="checkbox" data-opt="toolTraces"></label>
      <label class="row" data-row="maxFileMB"><span>文件附件上限（MB）</span><input type="number" data-opt="maxFileMB" min="1" max="500" step="1" value="2"></label>
      <label class="row" data-row="linkStyle"><span>附件链接风格</span><select data-opt="linkStyle">
        <option value="wikilink">Wikilink</option>
        <option value="markdown">标准 Markdown</option>
      </select></label>
      <label class="row" data-row="headingMode"><span>消息内标题</span><select data-opt="headingMode">
        <option value="demote">整体降一级</option>
        <option value="strip">剥离为加粗行</option>
      </select></label>
      <label class="row" data-row="notesDir"><span>笔记子文件夹</span><input type="text" data-opt="notesDir" placeholder="留空 = 根目录"></label>
      <label class="row" data-row="attachmentsDir"><span>附件子文件夹（相对笔记）</span><input type="text" data-opt="attachmentsDir" placeholder="留空 = 与笔记同层"></label>
      <button class="reset">重置增量记录（下次全量导出）</button>
      <button class="reset" data-act="forget-folder" hidden>重新选择写入文件夹</button>
    </div>

    <button class="go">导出当前对话</button>
    <div class="status" role="status" aria-live="polite">就绪</div>
    <progress max="1" value="0"></progress>
    <button class="cancel">取消</button>
  `
  root.append(fab, panel)

  // FAB 锚定系统，双模式：
  //   composer（默认）：贴输入框右侧垂直居中，挤不下退到输入框正上方（玻璃圆钮）；
  //   header：贴顶栏 Share 按钮左侧（没有 Share 时贴 header 动作区），面板向下展开（幽灵钮）。
  // 没有默认位置：找不到锚点就不出现；锚点短暂消失（切换会话会卸载重挂）位置冻结原地，
  // 消失 4s+（设置页/改版）才整体隐藏——绝不回退到固定角落。
  // 开销：ResizeObserver 只在锚点尺寸变化时触发；轮询每次一个 querySelector +
  // getBoundingClientRect，样式仅在数值变化时写入。
  let mode: 'composer' | 'header' = cb.settings.values.fabPos
  host.dataset['pos'] = mode
  const fabSize = () => (mode === 'header' ? 36 : 44)
  const fabGap = () => (mode === 'header' ? 8 : 12)
  let curRight = -1
  let curBottom = -1
  let curPanelTop = -1
  const findAnchor = (): HTMLElement | null =>
    mode === 'header' ? cb.siteUi.headerAnchor() : cb.siteUi.composerAnchor()
  let anchor: HTMLElement | null = null
  const syncPos = (): void => {
    if (!anchor?.isConnected) return // 没有锚点：位置保持原样，藏与不藏由 rebindAnchor 决定
    const r = anchor.getBoundingClientRect()
    if (r.height <= 0) return
    const size = fabSize()
    let right: number
    let bottom: number
    if (mode === 'header') {
      if (r.top < 0) return
      right = Math.round(window.innerWidth - r.left + fabGap())
      bottom = Math.round(window.innerHeight - r.bottom + (r.height - size) / 2)
      const panelTop = Math.round(r.bottom + 10)
      if (panelTop !== curPanelTop) {
        curPanelTop = panelTop
        host.style.setProperty('--panel-top', `${panelTop}px`)
      }
    } else {
      if (r.bottom > window.innerHeight) return
      const beside = Math.round(window.innerWidth - r.right - fabGap() - size)
      if (beside >= 8) {
        right = beside
        bottom = Math.round(Math.max(8, window.innerHeight - r.bottom + (r.height - size) / 2))
      } else {
        right = 20
        bottom = Math.round(Math.min(window.innerHeight - 60, window.innerHeight - r.top + fabGap()))
      }
    }
    if (right !== curRight) {
      curRight = right
      host.style.setProperty('--fab-right', `${right}px`)
    }
    if (bottom !== curBottom) {
      curBottom = bottom
      host.style.setProperty('--fab-bottom', `${bottom}px`)
    }
  }
  const hideFab = (): void => {
    fab.classList.remove('in')
    if (panel.classList.contains('open')) {
      panel.classList.remove('open')
      fab.classList.remove('open')
      fab.setAttribute('aria-expanded', 'false')
    }
  }
  const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(syncPos)
  let anchorMissing = 0
  const rebindAnchor = (): void => {
    const c = findAnchor()
    if (c !== anchor) {
      ro?.disconnect()
      anchor = c
      if (c) ro?.observe(c)
    }
    if (anchor?.isConnected) {
      anchorMissing = 0
      syncPos()
    } else if (++anchorMissing >= 2) {
      hideFab() // 连续两轮（约 4s）没有锚点：整个入口隐藏
    }
  }
  // 找到输入框、且位置连续两拍（250ms）稳定后才现身（.in)——SPA 水合期间 composer
  // 可能先出现在错误位置（居中/侧栏未挂载），立刻现身会被用户看到「先落错位再闪跳」。
  // 30s 还没等到就停掉快轮询、转交维护轮询：何时找到何时现身，等不到就一直不出现。
  let bootDone = false
  let bootTries = 0
  let bootKey = ''
  let bootStable = 0
  const boot = (): void => {
    rebindAnchor()
    const key = `${curRight},${curBottom}`
    bootStable = anchor && key === bootKey ? bootStable + 1 : anchor ? 1 : 0
    bootKey = key
    if (bootStable >= 2) {
      bootDone = true
      detectAccent(true) // 水合完成，页面主题色变量已就位
      fab.classList.add('in')
      return
    }
    if (++bootTries < 120) setTimeout(boot, 250)
    else bootDone = true
  }
  boot()
  window.addEventListener('resize', syncPos, { passive: true })
  // 维护期：500ms 纯位置同步（锚点平移不触发 ResizeObserver），2s 一次全量重找 + accent 重读；
  // 锚点回来（或迟到）时在这里重新现身
  let tick = 0
  setInterval(() => {
    if (++tick % 4 === 0) {
      rebindAnchor()
      if (bootDone && anchor?.isConnected && curRight >= 0 && !fab.classList.contains('in')) {
        detectAccent(true)
        fab.classList.add('in')
      }
      detectAccent()
    } else {
      syncPos()
    }
  }, 500)

  const $ = <T extends HTMLElement>(sel: string) => panel.querySelector<T>(sel)!
  const statusEl = $<HTMLDivElement>('.status')
  const progressEl = $<HTMLProgressElement>('progress')
  const cancelEl = $<HTMLButtonElement>('.cancel')
  const goEl = $<HTMLButtonElement>('.go')
  const advToggle = $<HTMLButtonElement>('.adv-toggle')
  const advEl = $<HTMLDivElement>('.adv')
  const pickerEl = $<HTMLDivElement>('.picker')
  const pickerList = pickerEl.querySelector<HTMLDivElement>('.list')!
  const sentinel = pickerList.querySelector<HTMLDivElement>('.sentinel')!
  const pickerSearch = pickerEl.querySelector<HTMLInputElement>('input[type="search"]')!
  const pickerEmpty = pickerEl.querySelector<HTMLDivElement>('.empty')!
  const pickerCount = pickerEl.querySelector<HTMLSpanElement>('.count')!
  const segButtons = [...panel.querySelectorAll<HTMLButtonElement>('.seg button')]
  const toolButtons = [...pickerEl.querySelectorAll<HTMLButtonElement>('.tools button')]
  const forgetFolderEl = panel.querySelector<HTMLButtonElement>('[data-act="forget-folder"]')!

  let scope: ExportScope = 'current'
  let format: ExportFormat = 'markdown'
  let target: 'zip' | 'folder' = cb.settings.supportsFolder ? cb.settings.values.target : 'zip'
  // 列表加载态与导出的 running 态刻意分开：分页加载期间面板全程可用
  let listLoaded = false // 已至少加载过一页
  let listDone = false // 已确认拉到底
  let listLoading = false // 有一页正在拉取中
  let running = false

  const optOf = (name: string) => panel.querySelector<HTMLInputElement>(`input[data-opt="${name}"]`)!.checked

  const maxFileEl = panel.querySelector<HTMLInputElement>('input[data-opt="maxFileMB"]')!
  maxFileEl.value = String(cb.settings.values.maxFileMB)
  const readMaxFileMB = () => {
    const v = Number(maxFileEl.value)
    return Number.isFinite(v) && v >= 1 ? Math.min(v, 500) : 2
  }
  maxFileEl.addEventListener('change', () => cb.settings.onSettingsChange({ maxFileMB: readMaxFileMB() }))

  // 按钮位置切换：立即换锚点重新定位（fab 已可见时平滑滑过去并切换样式）
  const fabPosEl = panel.querySelector<HTMLSelectElement>('select[data-opt="fabPos"]')!
  fabPosEl.value = mode
  fabPosEl.addEventListener('change', () => {
    mode = fabPosEl.value === 'header' ? 'header' : 'composer'
    host.dataset['pos'] = mode
    cb.settings.onSettingsChange({ fabPos: mode })
    rebindAnchor()
  })

  const linkStyleEl = panel.querySelector<HTMLSelectElement>('select[data-opt="linkStyle"]')!
  const headingModeEl = panel.querySelector<HTMLSelectElement>('select[data-opt="headingMode"]')!
  linkStyleEl.value = cb.settings.values.linkStyle
  headingModeEl.value = cb.settings.values.headingMode
  linkStyleEl.addEventListener('change', () =>
    cb.settings.onSettingsChange({ linkStyle: linkStyleEl.value === 'markdown' ? 'markdown' : 'wikilink' }),
  )
  headingModeEl.addEventListener('change', () =>
    cb.settings.onSettingsChange({ headingMode: headingModeEl.value === 'strip' ? 'strip' : 'demote' }),
  )

  // 子文件夹输入：净化后回写输入框，用户所见即实际生效值
  const notesDirEl = panel.querySelector<HTMLInputElement>('input[data-opt="notesDir"]')!
  const attachmentsDirEl = panel.querySelector<HTMLInputElement>('input[data-opt="attachmentsDir"]')!
  notesDirEl.value = cb.settings.values.notesDir
  attachmentsDirEl.value = cb.settings.values.attachmentsDir
  notesDirEl.addEventListener('change', () => {
    notesDirEl.value = sanitizeSubdir(notesDirEl.value)
    cb.settings.onSettingsChange({ notesDir: notesDirEl.value })
  })
  attachmentsDirEl.addEventListener('change', () => {
    attachmentsDirEl.value = sanitizeSubdir(attachmentsDirEl.value)
    cb.settings.onSettingsChange({ attachmentsDir: attachmentsDirEl.value })
  })

  // 不支持 File System Access（Firefox/Safari）就锁死 zip
  const folderBtn = panel.querySelector<HTMLButtonElement>('[data-seg="target"] button[data-v="folder"]')!
  if (!cb.settings.supportsFolder) {
    folderBtn.disabled = true
    folderBtn.title = '需要 Chrome / Edge（File System Access API）'
  }
  // 记住的输出目标是文件夹时，把分段控件拨过去
  if (target === 'folder') {
    for (const b of panel.querySelectorAll<HTMLButtonElement>('[data-seg="target"] button')) {
      const on = b.dataset['v'] === 'folder'
      b.classList.toggle('on', on)
      b.setAttribute('aria-pressed', String(on))
    }
  }

  const readOpts = (): ExportOptions => ({
    incremental: optOf('incremental'),
    assets: optOf('assets'),
    thoughts: optOf('thoughts'),
    toolTraces: optOf('toolTraces'),
    maxFileMB: readMaxFileMB(),
    linkStyle: linkStyleEl.value === 'markdown' ? 'markdown' : 'wikilink',
    headingMode: headingModeEl.value === 'strip' ? 'strip' : 'demote',
    target,
    notesDir: sanitizeSubdir(notesDirEl.value),
    attachmentsDir: sanitizeSubdir(attachmentsDirEl.value),
  })

  const rows = () => [...pickerList.querySelectorAll<HTMLLabelElement>('.row')]
  const boxOf = (row: HTMLLabelElement) => row.querySelector<HTMLInputElement>('input')!
  const visibleRows = () => rows().filter((r) => !r.classList.contains('hidden'))
  const selectedIds = () =>
    rows()
      .map(boxOf)
      .filter((b) => b.checked)
      .map((b) => b.dataset['id']!)

  // 搜索过滤：input 事件与「追加新一页」共用，保证新行立刻套用当前过滤词
  function applySearchFilter(): void {
    const q = pickerSearch.value.trim().toLowerCase()
    for (const row of rows()) {
      row.classList.toggle('hidden', q !== '' && !row.title.toLowerCase().includes(q))
    }
  }

  // 范围/格式变化后统一刷新：选项可用性、空状态、主按钮文案与可点性
  function refresh(): void {
    pickerEl.classList.toggle('open', scope === 'selection')
    // 没到底之前不说「没有匹配」——可能只是还没加载到
    pickerEmpty.classList.toggle('visible', listLoaded && listDone && visibleRows().length === 0)
    advEl.querySelector('[data-row="incremental"]')!.classList.toggle('dis', scope !== 'all')
    // JSON 导出走固定的 raw/ 目录，Markdown 专属选项一并禁用
    for (const name of ['assets', 'thoughts', 'toolTraces', 'maxFileMB', 'linkStyle', 'headingMode', 'notesDir', 'attachmentsDir']) {
      advEl.querySelector(`[data-row="${name}"]`)!.classList.toggle('dis', format === 'json')
    }
    forgetFolderEl.hidden = target !== 'folder'
    const n = selectedIds().length
    const loaded = rows().length
    pickerCount.textContent = listDone
      ? `已选 ${n} / 共 ${loaded} 条`
      : `已选 ${n} 条 · 已加载 ${loaded} 条（下拉加载更多）`
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
      // 导出期间懒加载被挂起，结束后恢复
      if (listLoaded && !listDone && !listLoading) {
        sentinel.textContent = '下拉加载更多'
        maybeAutoFill()
      }
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
    appendPicker: (items, done) => {
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
        // 始终插在哨兵之前，哨兵保持在列表末尾
        sentinel.before(row)
      }
      listLoaded = true
      listLoading = false
      listDone = done
      applySearchFilter()
      sentinel.textContent = done ? '' : '下拉加载更多'
      refresh()
      // 这一页没填满滚动容器（列表还没出现滚动条）时哨兵不会再次进入视口，
      // 需要主动续拉，否则懒加载会停在第一页。
      if (!done) queueMicrotask(maybeAutoFill)
    },
    clearPicker: () => {
      for (const r of rows()) r.remove()
      listLoaded = false
      listDone = false
      listLoading = false
      sentinel.textContent = ''
      refresh()
    },
    pickerLoadFailed: () => {
      listLoading = false
      sentinel.textContent = '加载失败，点此重试'
    },
  }

  /** 触发下一页；加载中/已到底/导出进行中都不重复触发 */
  function requestMore(): void {
    if (listLoading || listDone || running) return
    // 一页都没成功过 = 首页拉取失败，重试要走完整的重置流程
    if (!listLoaded) {
      loadList()
      return
    }
    listLoading = true
    sentinel.textContent = '加载中…'
    cb.onPickMore(handle)
  }

  /** 内容不足一屏时哨兵始终可见，IntersectionObserver 不会再报回调，这里补一脚。
   *  面板收起时列表高度为 0，不能当作「没填满」，否则会在后台闷头拉完全部页。 */
  function maybeAutoFill(): void {
    const h = pickerList.clientHeight
    if (h > 0 && pickerList.scrollHeight <= h + 8) requestMore()
  }

  const pickerObserver = new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting)) requestMore()
    },
    { root: pickerList, rootMargin: '80px' },
  )
  pickerObserver.observe(sentinel)

  sentinel.addEventListener('click', requestMore)

  /** 重置并拉第一页（首次进入「选择」/ 点重新拉取按钮） */
  function loadList(): void {
    handle.clearPicker()
    pickerSearch.value = ''
    listLoading = true
    sentinel.textContent = '加载中…'
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
      } else if (group === 'target') {
        target = btn.dataset['v'] as 'zip' | 'folder'
        cb.settings.onSettingsChange({ target })
      } else {
        format = btn.dataset['v'] as ExportFormat
      }
      refresh()
    })
  }

  pickerSearch.addEventListener('input', () => {
    applySearchFilter()
    refresh()
    // 过滤后列表可能缩到不足一屏，哨兵重新露出来就该继续加载
    maybeAutoFill()
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

  fab.addEventListener('click', () => {
    const open = panel.classList.toggle('open')
    fab.classList.toggle('open', open)
    fab.setAttribute('aria-expanded', String(open))
  })
  cancelEl.addEventListener('click', () => {
    cancelEl.disabled = true
    cb.onCancel()
  })
  $<HTMLButtonElement>('.reset').addEventListener('click', () => {
    cb.onResetWatermark()
    statusEl.textContent = '增量记录已清除，下次导出为全量'
  })
  forgetFolderEl.addEventListener('click', () => {
    cb.onForgetFolder()
    statusEl.textContent = '已忘记写入文件夹，下次导出重新选择'
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
