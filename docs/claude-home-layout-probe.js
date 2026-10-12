// Claude 首页布局探针（只读、零网络请求）
//
// 用法：
//   1. 登录 claude.ai，停留在「首页 / 新对话页」；
//   2. F12 → Console；
//   3. 粘贴本文件全部内容并回车；
//   4. 控制台会输出一段 JSON，并尝试复制到剪贴板；把 JSON 发给开发者。
//
// 隐私边界：
//   - 不读取 textContent、输入框 value、contenteditable 内容、cookie、localStorage；
//   - 不调用任何接口；
//   - URL 中的 UUID、邮箱、长 token 会脱敏；
//   - aria-label/title/placeholder 可能帮助识别控件，但同样会经过脱敏。

;(() => {
  const PROBE = 'inkstone-claude-home-layout-v1'
  const MAX_NODES = 80

  const redact = (value) => {
    if (value == null) return null
    return String(value)
      .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '<email>')
      .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, '<uuid>')
      .replace(/\b(?:sk-|sess-|org-|user-)?[A-Za-z0-9_-]{32,}\b/g, '<token>')
      .replace(/\b\d{7,}\b/g, '<number>')
      .slice(0, 160)
  }

  const cleanUrl = () => {
    const u = new URL(location.href)
    u.search = ''
    u.hash = ''
    u.pathname = redact(u.pathname)
    return u.toString()
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
    if (el.closest('[data-inkstone]')) return false
    const r = el.getBoundingClientRect()
    if (r.width < 1 || r.height < 1) return false
    const s = getComputedStyle(el)
    return s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) !== 0
  }

  const simpleSelector = (el) => {
    const parts = [el.tagName.toLowerCase()]
    const testId = el.getAttribute('data-testid')
    const role = el.getAttribute('role')
    const slot = el.getAttribute('data-slot')
    if (el.id) parts.push(`#${redact(el.id)}`)
    if (testId) parts.push(`[data-testid="${redact(testId)}"]`)
    if (slot) parts.push(`[data-slot="${redact(slot)}"]`)
    if (role) parts.push(`[role="${redact(role)}"]`)
    const stableClasses = [...el.classList]
      .filter((name) => name.length <= 48 && !/^css-|^_[A-Za-z0-9]{6,}/.test(name))
      .slice(0, 4)
    if (!testId && stableClasses.length) parts.push(`.${stableClasses.join('.')}`)
    return parts.join('')
  }

  const domPath = (el) => {
    const out = []
    let cur = el
    while (cur instanceof HTMLElement && cur !== document.body && out.length < 7) {
      out.unshift(simpleSelector(cur))
      cur = cur.parentElement
    }
    out.unshift('body')
    return out.join(' > ')
  }

  const safeAttributes = (el) => {
    const names = [
      'id',
      'role',
      'type',
      'data-testid',
      'data-slot',
      'data-state',
      'data-side',
      'aria-label',
      'aria-haspopup',
      'aria-expanded',
      'title',
      'placeholder',
    ]
    const out = {}
    for (const name of names) {
      const value = el.getAttribute(name)
      if (value != null && value !== '') out[name] = redact(value)
    }
    return out
  }

  const describe = (el) => {
    const style = getComputedStyle(el)
    return {
      selector: simpleSelector(el),
      path: domPath(el),
      attributes: safeAttributes(el),
      rect: rectOf(el),
      style: {
        position: style.position,
        display: style.display,
        zIndex: style.zIndex,
        overflow: style.overflow,
      },
      directChildren: [...el.children].slice(0, 12).map(simpleSelector),
    }
  }

  const ancestors = (el) => {
    const out = []
    let cur = el
    while (cur instanceof HTMLElement && cur !== document.body && out.length < 8) {
      out.push(describe(cur))
      cur = cur.parentElement
    }
    return out
  }

  const queryVisible = (selector) =>
    [...document.querySelectorAll(selector)].filter(isVisible).slice(0, MAX_NODES)

  const selectorChecks = [
    '[data-testid="wiggle-controls-actions-group"]',
    '[data-testid="wiggle-controls-actions"]',
    '[data-testid="wiggle-controls-actions-share"]',
    '[data-testid="share-button"]',
    '[data-testid="chat-menu-trigger"]',
    '[data-testid="chat-title-split"]',
    '#prompt-textarea',
    '[data-testid="chat-input"][contenteditable="true"]',
    'div[contenteditable="true"][role="textbox"]',
    'div.ProseMirror[contenteditable="true"]',
  ]

  const knownSelectors = Object.fromEntries(
    selectorChecks.map((selector) => {
      const nodes = queryVisible(selector)
      return [selector, { count: nodes.length, matches: nodes.slice(0, 4).map(describe) }]
    }),
  )

  const interactiveSelector = [
    'button',
    'a[href]',
    '[role="button"]',
    '[role="menuitem"]',
    '[data-testid]',
    'input',
    'textarea',
    'select',
    '[contenteditable="true"]',
  ].join(',')

  const visibleInteractive = queryVisible(interactiveSelector)
  const topLimit = Math.max(180, innerHeight * 0.24)
  const rightLimit = innerWidth - Math.min(560, innerWidth * 0.5)
  const topRight = visibleInteractive
    .filter((el) => {
      const r = el.getBoundingClientRect()
      return r.top <= topLimit && r.right >= rightLimit
    })
    .sort((a, b) => {
      const ar = a.getBoundingClientRect()
      const br = b.getBoundingClientRect()
      return ar.top - br.top || br.right - ar.right
    })
    .slice(0, 40)

  const composer = visibleInteractive
    .filter((el) => {
      const r = el.getBoundingClientRect()
      const inputLike =
        el.matches('textarea,input,[contenteditable="true"],[role="textbox"]') ||
        el.querySelector('textarea,input,[contenteditable="true"],[role="textbox"]')
      return Boolean(inputLike) && r.width >= 160 && r.height >= 24
    })
    .sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width)
    .slice(0, 12)

  const landmarks = queryVisible('header,nav,main,aside,[role="banner"],[role="navigation"],[role="main"]')
    .map(describe)
    .slice(0, 30)

  const testIdInventory = {}
  for (const el of queryVisible('[data-testid]')) {
    const key = redact(el.getAttribute('data-testid'))
    if (!key) continue
    if (!testIdInventory[key]) testIdInventory[key] = []
    if (testIdInventory[key].length < 3) testIdInventory[key].push(rectOf(el))
  }

  const topRightAncestorChains = topRight.slice(0, 12).map((el) => ({
    target: describe(el),
    ancestors: ancestors(el),
  }))

  const report = {
    probe: PROBE,
    capturedAt: new Date().toISOString(),
    page: {
      url: cleanUrl(),
      titleLength: document.title.length,
      viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
      body: {
        attributes: safeAttributes(document.body),
        directChildren: [...document.body.children]
          .filter((el) => !el.matches('[data-inkstone]'))
          .slice(0, 30)
          .map(describe),
      },
    },
    knownSelectors,
    landmarks,
    topRightCandidates: topRight.map(describe),
    topRightAncestorChains,
    composerCandidates: composer.map((el) => ({ target: describe(el), ancestors: ancestors(el) })),
    visibleDataTestIds: testIdInventory,
    notes: [
      'No network requests were made.',
      'No textContent, input value, cookie, localStorage, or conversation content was read.',
      'The Inkstone injected shadow host was excluded from the scan.',
    ],
  }

  const json = JSON.stringify(report, null, 2)
  console.log(`%c[inkstone] ${PROBE}`, 'color:#1e6b72;font-weight:bold')
  console.log('INKSTONE_CLAUDE_HOME_PROBE_BEGIN')
  console.log(json)
  console.log('INKSTONE_CLAUDE_HOME_PROBE_END')

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

  void copyResult().then((message) => console.log(`%c[inkstone] ${message}`, 'color:#1e6b72'))
  return report
})()
