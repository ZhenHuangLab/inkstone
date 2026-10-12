// ChatGPT 页面结构 / Inkstone 锚点探针（只读，不发网络请求）
//
// 用法：在 chatgpt.com 打开一条实际对话，F12 → Console，整段粘贴回车。
// 脚本会自动复制 JSON；把结果发回即可。它不读取对话正文、输入框内容、
// localStorage、cookie 或 token，也不记录页面标题和原始 aria-label。

;(() => {
  const PROBE = 'inkstone-chatgpt-layout-v2'
  const MAX_NODES = 24

  const redact = (value) =>
    String(value ?? '')
      .replace(/[0-9a-f]{8}-[0-9a-f-]{20,}/gi, '<uuid>')
      .replace(/g-[A-Za-z0-9_-]{12,}/g, 'g-<id>')
      .replace(/radix-[A-Za-z0-9_-]+/g, 'radix-<id>')
      .slice(0, 120)

  const cleanUrl = () => {
    const url = new URL(location.href)
    url.search = ''
    url.hash = ''
    url.pathname = url.pathname
      .replace(/\/c\/[^/]+/, '/c/<conversation>')
      .replace(/\/g\/[^/]+/, '/g/<gpt>')
    return url.toString()
  }

  const round = (n) => Math.round(n * 10) / 10
  const rectOf = (el) => {
    const r = el.getBoundingClientRect()
    return {
      x: round(r.x),
      y: round(r.y),
      width: round(r.width),
      height: round(r.height),
      right: round(r.right),
      bottom: round(r.bottom),
    }
  }

  const isVisible = (el) => {
    if (!(el instanceof HTMLElement)) return false
    const r = el.getBoundingClientRect()
    const style = getComputedStyle(el)
    return (
      r.width >= 1 &&
      r.height >= 1 &&
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      Number(style.opacity) !== 0
    )
  }

  const labelHints = (el) => {
    const label = `${el.getAttribute('aria-label') ?? ''} ${el.getAttribute('title') ?? ''}`
    return {
      share: /share|分享|共享/i.test(label),
      profile: /profile|account|个人|账户|帐号/i.test(label),
    }
  }

  const safeAttributes = (el) => {
    const names = [
      'id',
      'role',
      'type',
      'data-testid',
      'data-type',
      'data-chatgpt-composer',
      'data-composer-markdown',
      'data-lexical-editor',
      'contenteditable',
      'aria-haspopup',
    ]
    const out = {}
    for (const name of names) {
      const value = el.getAttribute(name)
      if (value != null) out[name] = redact(value)
    }
    return out
  }

  const simpleSelector = (el) => {
    const testId = el.getAttribute('data-testid')
    const type = el.getAttribute('data-type')
    if (el.id) return `${el.tagName.toLowerCase()}#${redact(el.id)}`
    if (testId) return `${el.tagName.toLowerCase()}[data-testid="${redact(testId)}"]`
    if (type) return `${el.tagName.toLowerCase()}[data-type="${redact(type)}"]`
    return el.tagName.toLowerCase()
  }

  const describe = (el) => ({
    selector: simpleSelector(el),
    attributes: safeAttributes(el),
    labelHints: labelHints(el),
    visible: isVisible(el),
    rect: rectOf(el),
    directChildren: [...el.children].slice(0, 16).map(simpleSelector),
  })

  const computed = (el) => {
    if (!(el instanceof Element)) return null
    const style = getComputedStyle(el)
    return {
      position: style.position,
      display: style.display,
      visibility: style.visibility,
      opacity: style.opacity,
      zIndex: style.zIndex,
      pointerEvents: style.pointerEvents,
      overflow: style.overflow,
      isolation: style.isolation,
      transform: style.transform,
      color: style.color,
      backgroundColor: style.backgroundColor,
    }
  }

  const ancestorChain = (el) => {
    const out = []
    let current = el
    while (current instanceof HTMLElement && current !== document.body && out.length < 8) {
      out.push(describe(current))
      current = current.parentElement
    }
    return out
  }

  const selectors = [
    '#prompt-textarea',
    '[data-testid="prompt-textarea"]',
    'form[data-chatgpt-composer]',
    'form[data-type="unified-composer"]',
    '[data-testid="composer"]',
    '[data-composer-markdown][contenteditable="true"]',
    '[contenteditable="true"][data-lexical-editor="true"]',
    '#thread-bottom-container',
    '#conversation-header-actions',
    '[data-testid="share-chat-button"]',
    '#page-header',
    'header',
  ]

  const knownSelectors = Object.fromEntries(
    selectors.map((selector) => {
      const matches = [...document.querySelectorAll(selector)].slice(0, MAX_NODES)
      return [selector, { count: matches.length, matches: matches.map(describe) }]
    }),
  )

  const editors = [
    ...document.querySelectorAll(
      'textarea, [contenteditable="true"], [role="textbox"], form[data-chatgpt-composer]',
    ),
  ]
    .filter(isVisible)
    .slice(0, 12)
    .map((el) => ({ target: describe(el), ancestors: ancestorChain(el) }))

  const headers = [...document.querySelectorAll('#page-header, header')]
    .filter(isVisible)
    .slice(0, 8)
    .map((header) => ({
      target: describe(header),
      children: [...header.children].slice(0, 16).map(describe),
      controls: [...header.querySelectorAll('button, a[role="button"], [role="button"]')]
        .filter(isVisible)
        .slice(0, MAX_NODES)
        .map(describe),
    }))

  const host = document.querySelector('[data-inkstone]')
  const fab = host?.shadowRoot?.querySelector('.fab') ?? null
  const panel = host?.shadowRoot?.querySelector('.panel') ?? null
  const fabRect = fab instanceof HTMLElement ? fab.getBoundingClientRect() : null
  const fabCenter = fabRect
    ? { x: round(fabRect.left + fabRect.width / 2), y: round(fabRect.top + fabRect.height / 2) }
    : null
  const pageHit = fabCenter ? document.elementFromPoint(fabCenter.x, fabCenter.y) : null
  const shadowHit = fabCenter ? host?.shadowRoot?.elementFromPoint(fabCenter.x, fabCenter.y) : null
  const icon = fab?.querySelector('.ic-dl') ?? null
  const svg = icon?.querySelector('svg') ?? null
  const inkstone = {
    hostPresent: host instanceof HTMLElement,
    host: host instanceof HTMLElement
      ? {
          pos: host.dataset.pos ?? null,
          site: host.dataset.site ?? null,
          theme: host.dataset.theme ?? null,
          style: {
            right: host.style.getPropertyValue('--fab-right'),
            bottom: host.style.getPropertyValue('--fab-bottom'),
            panelTop: host.style.getPropertyValue('--panel-top'),
            panelLeft: host.style.getPropertyValue('--panel-left'),
          },
          computed: computed(host),
        }
      : null,
    fab: fab instanceof HTMLElement
      ? {
          className: fab.className,
          visible: isVisible(fab),
          computedVisibility: getComputedStyle(fab).visibility,
          rect: rectOf(fab),
          computed: computed(fab),
          icon: icon instanceof HTMLElement
            ? { rect: rectOf(icon), computed: computed(icon) }
            : null,
          svg: svg instanceof SVGElement
            ? { rect: rectOf(svg), computed: computed(svg) }
            : null,
        }
      : null,
    panel: panel instanceof HTMLElement
      ? { className: panel.className, display: getComputedStyle(panel).display, rect: rectOf(panel) }
      : null,
    hitTest: fabCenter
      ? {
          center: fabCenter,
          page: pageHit instanceof Element ? describe(pageHit) : null,
          shadow: shadowHit instanceof Element ? describe(shadowHit) : null,
          pageHits: document.elementsFromPoint(fabCenter.x, fabCenter.y).slice(0, 8).map(describe),
        }
      : null,
  }

  const report = {
    probe: PROBE,
    capturedAt: new Date().toISOString(),
    page: {
      url: cleanUrl(),
      viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
      root: safeAttributes(document.documentElement),
      body: safeAttributes(document.body),
    },
    knownSelectors,
    editors,
    headers,
    inkstone,
    notes: [
      'No network requests were made.',
      'No conversation text, input value, page title, cookie, storage, or token was read.',
      'aria-label and title values were reduced to boolean share/profile hints.',
    ],
  }

  const json = JSON.stringify(report, null, 2)
  console.log(`[inkstone] ${PROBE}`)
  console.log('INKSTONE_CHATGPT_LAYOUT_PROBE_BEGIN')
  console.log(json)
  console.log('INKSTONE_CHATGPT_LAYOUT_PROBE_END')

  const copyResult = async () => {
    try {
      if (typeof copy === 'function') {
        copy(json)
        return '已通过 DevTools copy() 复制到剪贴板'
      }
      await navigator.clipboard.writeText(json)
      return '已通过 Clipboard API 复制到剪贴板'
    } catch (error) {
      return `自动复制失败，请手动复制 BEGIN/END 之间的 JSON：${String(error)}`
    }
  }

  void copyResult().then((message) => console.log(`[inkstone] ${message}`))
  return report
})()
