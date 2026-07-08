export type ExportKind = 'markdown' | 'json'

export interface PanelHandle {
  setStatus(text: string): void
  setProgress(done: number, total: number): void
  finish(): void
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
    width: 300px; padding: 14px; border-radius: 12px;
    background: #fff; color: #111; box-shadow: 0 6px 28px rgba(0,0,0,.3);
    font-size: 13px; display: none;
  }
  .panel.open { display: block; }
  .title { font-weight: 700; font-size: 14px; margin-bottom: 10px; }
  .btns { display: flex; gap: 8px; margin-bottom: 10px; }
  .btns button {
    flex: 1; padding: 7px 4px; border-radius: 8px; border: 1px solid #d0d0d0;
    background: #fafafa; cursor: pointer; font-size: 12px;
  }
  .btns button:hover:not(:disabled) { background: #f0f0f0; }
  .btns button:disabled { opacity: .5; cursor: default; }
  .btns button.primary { background: #10a37f; border-color: #10a37f; color: #fff; }
  .status { min-height: 17px; color: #555; word-break: break-all; }
  progress { width: 100%; height: 8px; margin-top: 6px; display: none; }
  progress.visible { display: block; }
  .cancel {
    display: none; margin-top: 8px; width: 100%; padding: 6px; border-radius: 8px;
    border: 1px solid #e0b4b4; background: #fdf3f3; color: #b03030; cursor: pointer; font-size: 12px;
  }
  .cancel.visible { display: block; }
`

export function mountPanel(
  onStart: (kind: ExportKind, panel: PanelHandle) => void,
  onCancel: () => void,
): void {
  if (document.querySelector('[data-gexport]')) return
  const host = document.createElement('div')
  host.dataset['gexport'] = ''
  const root = host.attachShadow({ mode: 'open' })

  const style = document.createElement('style')
  style.textContent = STYLE
  root.append(style)

  const fab = document.createElement('button')
  fab.className = 'fab'
  fab.title = 'gexport：导出全部对话'
  fab.textContent = '⇩'

  const panel = document.createElement('div')
  panel.className = 'panel'
  panel.innerHTML = `
    <div class="title">gexport — 导出全部对话</div>
    <div class="btns">
      <button class="primary" data-kind="markdown">Markdown zip</button>
      <button data-kind="json">原始 JSON zip</button>
    </div>
    <div class="status">就绪</div>
    <progress max="1" value="0"></progress>
    <button class="cancel">取消</button>
  `
  root.append(fab, panel)

  const statusEl = panel.querySelector<HTMLDivElement>('.status')!
  const progressEl = panel.querySelector<HTMLProgressElement>('progress')!
  const cancelEl = panel.querySelector<HTMLButtonElement>('.cancel')!
  const kindButtons = [...panel.querySelectorAll<HTMLButtonElement>('.btns button')]

  fab.addEventListener('click', () => panel.classList.toggle('open'))
  cancelEl.addEventListener('click', () => {
    cancelEl.disabled = true
    onCancel()
  })

  const handle: PanelHandle = {
    setStatus: text => {
      statusEl.textContent = text
    },
    setProgress: (done, total) => {
      progressEl.classList.add('visible')
      progressEl.max = Math.max(1, total)
      progressEl.value = done
    },
    finish: () => {
      for (const b of kindButtons) b.disabled = false
      cancelEl.classList.remove('visible')
      cancelEl.disabled = false
      progressEl.classList.remove('visible')
      progressEl.value = 0
    },
  }

  for (const btn of kindButtons) {
    btn.addEventListener('click', () => {
      for (const b of kindButtons) b.disabled = true
      cancelEl.classList.add('visible')
      onStart(btn.dataset['kind'] as ExportKind, handle)
    })
  }

  document.body.append(host)
}
