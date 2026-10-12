// 在已登录的 ChatGPT/Claude 页面打开 F12 → Console，粘贴整个文件运行。
// 分别在正常页面、Inkstone 面板打开、页面菜单/搜索/设置浮层打开时运行。
// 只读取几何位置和层叠样式；不发请求，不读取 cookie/storage/正文/输入值。
;(() => {
  const site = location.hostname === 'claude.ai' ? 'claude'
    : ['chatgpt.com', 'chat.openai.com'].includes(location.hostname) ? 'chatgpt' : 'other'
  const round = (value) => Math.round(value * 10) / 10
  const rect = (element) => {
    const box = element.getBoundingClientRect()
    return Object.fromEntries(['left', 'top', 'right', 'bottom', 'width', 'height'].map((key) => [key, round(box[key])]))
  }
  const visible = (element) => {
    const box = element.getBoundingClientRect()
    const style = getComputedStyle(element)
    return box.width > 0 && box.height > 0 && style.display !== 'none' && style.visibility === 'visible' && Number(style.opacity) > 0
  }
  const describe = (element) => {
    if (!element) return null
    const style = getComputedStyle(element)
    const role = element.getAttribute('role')
    return {
      tag: element.tagName.toLowerCase(),
      role: ['dialog', 'menu', 'listbox', 'button', 'textbox', 'navigation'].includes(role) ? role : null,
      inkstone: element.matches('[data-inkstone]') ? 'host' : element.matches('.fab') && element.getRootNode() === root ? 'fab'
        : element.matches('.panel') && element.getRootNode() === root ? 'panel' : null,
      rect: rect(element),
      style: {
        position: style.position, zIndex: style.zIndex, isolation: style.isolation,
        opacity: style.opacity, display: style.display, visibility: style.visibility,
        pointerEvents: style.pointerEvents, contain: style.contain,
        hasTransform: style.transform !== 'none', hasFilter: style.filter !== 'none',
        hasBackdropFilter: Boolean(style.backdropFilter && style.backdropFilter !== 'none'),
      },
    }
  }
  const host = document.querySelector('[data-inkstone]')
  const root = host?.shadowRoot
  const fab = root?.querySelector('.fab')
  const panel = root?.querySelector('.panel')
  const hitTests = (element) => {
    if (!element || !visible(element)) return []
    const box = element.getBoundingClientRect()
    const points = [
      [(box.left + box.right) / 2, (box.top + box.bottom) / 2],
      [box.left + 2, box.top + 2], [box.right - 2, box.bottom - 2],
    ]
    return points.map(([x, y]) => {
      const inViewport = x >= 0 && y >= 0 && x < innerWidth && y < innerHeight
      const stack = inViewport ? document.elementsFromPoint(x, y).slice(0, 8) : []
      const top = stack[0]
      return {
        x: round(x), y: round(y), inViewport,
        inkstoneIsTop: top === host,
        top: describe(top),
        shadowTop: top === host && root?.elementFromPoint ? describe(root.elementFromPoint(x, y)) : null,
        stack: stack.map(describe),
      }
    })
  }
  const selectors = site === 'claude' ? [
    '[data-testid="wiggle-controls-actions-group"]', '#dframe-header-actions-slot',
    '[data-testid="chat-input"][contenteditable="true"]', 'fieldset',
  ] : [
    '#conversation-header-actions', '#page-header', 'header', '[data-testid="share-chat-button"]',
    'form[data-chatgpt-composer]', 'form[data-type="unified-composer"]',
    '#prompt-textarea', '[data-composer-markdown][contenteditable="true"][role="textbox"]',
    '[contenteditable="true"][data-lexical-editor="true"][role="textbox"]',
  ]
  const overlays = new Set(document.querySelectorAll('[role="dialog"], [role="menu"], [role="listbox"], dialog[open]'))
  for (const selector of [':modal', ':popover-open']) {
    try { for (const element of document.querySelectorAll(selector)) overlays.add(element) } catch { /* 旧浏览器不支持 */ }
  }
  const report = {
    probe: 'inkstone-ui-overlay-v1', site,
    pageKind: /\/(chat|c)\//.test(location.pathname) ? 'conversation' : /^\/(new)?$/.test(location.pathname) ? 'new' : 'other',
    viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
    installed: Boolean(root), position: ['header', 'composer'].includes(host?.dataset.pos) ? host.dataset.pos : null,
    host: describe(host), fab: describe(fab), panel: describe(panel),
    fabHitTests: hitTests(fab), panelHitTests: hitTests(panel),
    anchors: selectors.map((selector) => {
      const matches = [...document.querySelectorAll(selector)]
      return { selector, count: matches.length, visible: matches.filter(visible).slice(0, 6).map(describe) }
    }),
    visibleOverlays: [...overlays].filter(visible).slice(0, 12).map(describe),
    notes: ['No network requests.', 'No cookie/storage/textContent/input values/URLs/IDs/names were recorded.'],
  }
  console.log('INKSTONE_UI_OVERLAY_PROBE_BEGIN')
  console.log(JSON.stringify(report, null, 2))
  console.log('INKSTONE_UI_OVERLAY_PROBE_END')
  return report
})()
