// 使用实际构建产物验证 DOM 锚点和浏览器层叠；所有页面请求均返回本地合成页面。
import assert from 'node:assert/strict'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const source = await readFile(new URL('../dist/inkstone.user.js', import.meta.url), 'utf8')
const probe = await readFile(new URL('../docs/ui-overlay-probe.js', import.meta.url), 'utf8')
const outputDir = process.env.INKSTONE_BROWSER_OUTPUT_DIR ?? fileURLToPath(new URL('../dist/', import.meta.url))
await mkdir(outputDir, { recursive: true })
const browser = await chromium.launch({
  headless: true,
  ...(process.env.INKSTONE_BROWSER_EXECUTABLE ? { executablePath: process.env.INKSTONE_BROWSER_EXECUTABLE } : {}),
})

const css = `body {margin:0;background:white} header {position:fixed;left:0;top:0;width:100%;height:56px;z-index:100;background:#eee}
  .actions {position:absolute;right:16px;top:10px;width:100px;height:36px} .action {position:absolute;right:16px;top:10px;width:36px;height:36px}
  .composer {position:fixed;left:260px;bottom:24px;width:760px;height:88px;padding:12px;box-sizing:border-box}
  [contenteditable] {height:50px} .hidden {display:none} #decoy-header {top:150px;width:100%;height:56px}`
const fixtures = [
  { name: 'chat-conversation', header: '<header id="page-header"><div id="conversation-header-actions" class="actions"><button>Share</button></div></header>',
    composer: '<form data-chatgpt-composer class="composer"><div data-composer-markdown contenteditable="true" role="textbox"></div></form>', headerLeft: 1164 },
  { name: 'work-conversation', header: '<header><button data-testid="share-chat-button" class="action">Share</button></header>',
    composer: '<div class="composer"><div contenteditable="true" data-lexical-editor="true" role="textbox"></div></div>', headerLeft: 1228 },
  { name: 'chat-new', header: '<header id="page-header"><button data-testid="profile-button" class="action">Profile</button></header>',
    composer: '<form data-type="unified-composer" class="composer"><div id="prompt-textarea" contenteditable="true" role="textbox"></div></form>', headerLeft: 1228 },
  { name: 'work-new', header: '<header></header>',
    composer: '<div class="composer"><div data-composer-markdown contenteditable="true" role="textbox"></div></div>', headerLeft: null },
]

async function mount(site, html, mode = 'header', viewport = { width: 1280, height: 900 }, pauseTimers = false) {
  const context = await browser.newContext({ viewport, reducedMotion: 'reduce' })
  const page = await context.newPage()
  if (pauseTimers) await page.clock.install()
  const errors = []
  const requests = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('request', (request) => requests.push(request.url()))
  await page.route('**/*', (route) => route.fulfill({ contentType: 'text/html', body: `<html><head><style>${css}</style></head><body>${html}</body></html>` }))
  await page.goto(site === 'claude' ? 'https://claude.ai/new' : 'https://chatgpt.com/')
  await page.evaluate((fabPos) => localStorage.setItem('inkstone:settings', JSON.stringify({ fabPos })), mode)
  await page.addScriptTag({ content: source })
  await page.locator('[data-inkstone] .fab.in').waitFor()
  if (pauseTimers) await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000))
  return { context, page, errors, requests }
}

async function point(page, selector) {
  const box = await page.locator(`[data-inkstone] ${selector}`).boundingBox()
  assert.ok(box)
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

async function hit(page, position, expected) {
  const target = await page.evaluate(({ x, y }) => {
    const element = document.elementFromPoint(x, y)
    return element?.matches('[data-inkstone]') ? 'inkstone' : element?.id ?? null
  }, position)
  assert.equal(target, expected)
}

try {
  for (const layout of ['dense', 'actions']) {
    const html = layout === 'dense'
      ? '<header id="page-header"><button style="position:absolute;left:8px;top:10px;width:36px;height:36px">Menu</button><button style="position:absolute;left:52px;top:10px;width:120px;height:36px">Model</button><button data-testid="share-chat-button" style="position:absolute;right:90px;top:10px;width:60px;height:36px">Share</button><button data-testid="profile-button" style="position:absolute;right:16px;top:10px;width:44px;height:36px">Profile</button></header>'
      : '<header id="page-header"><div id="conversation-header-actions" class="actions" style="width:min(330px,calc(100% - 24px));display:flex"><button>Files</button><button>Share</button><button>Profile</button></div></header>'
    // 暂停维护轮询；真实 resize 事件必须独立完成重选，不能等 2s 轮询掩盖延迟。
    const run = await mount('chatgpt', html, 'header', { width: 360, height: 740 }, true)
    let previousBelow = true
    for (const width of [1440, 360, 320, 844, 1280]) {
      await run.page.locator('[data-inkstone] .fab').click()
      assert.equal(await run.page.locator('[data-inkstone] .panel').isVisible(), true)
      await run.page.setViewportSize({ width, height: 740 })
      await run.page.evaluate(() => window.dispatchEvent(new Event('resize')))
      const fab = await run.page.locator('[data-inkstone] .fab').boundingBox()
      const below = width <= 360
      assert.equal(fab.y, below ? 64 : 10, `${layout}: resize 后立即采用新定位方式，不能等待维护轮询`)
      assert.ok(fab.x >= 8 && fab.x + fab.width <= width - 8)
      for (const button of await run.page.locator('header button').all()) {
        const native = await button.boundingBox()
        assert.ok(fab.x + fab.width <= native.x || native.x + native.width <= fab.x || fab.y + fab.height <= native.y || native.y + native.height <= fab.y)
      }
      await hit(run.page, await point(run.page, '.fab'), 'inkstone')
      const staysOpen = below === previousBelow
      assert.equal(await run.page.locator('[data-inkstone] .panel').isVisible(), staysOpen, '只在锚点或定位方式改变时收起面板')
      if (!staysOpen) await run.page.locator('[data-inkstone] .fab').click()
      const panel = await run.page.locator('[data-inkstone] .panel').boundingBox()
      assert.ok(panel.x >= 16 && panel.x + panel.width <= width - 16)
      assert.ok(panel.y >= fab.y + fab.height && panel.y + panel.height <= 740)
      if (width === 320 || width === 1440) await run.page.screenshot({ path: join(outputDir, `chatgpt-resize-${layout}-${width}.png`) })
      await run.page.locator('[data-inkstone] .fab').click()
      previousBelow = below
    }
    assert.deepEqual(run.errors, [])
    await run.context.close()
    console.log(`PASS: ${layout} 顶栏实时缩放重选，按钮/面板不越界，同一定位方式保持展开`)
  }

  for (const width of [320, 360, 390, 844, 1440]) {
    const run = await mount('chatgpt', '<header id="page-header"><button style="position:absolute;left:8px;top:10px;width:36px;height:36px">Menu</button><button style="position:absolute;left:52px;top:10px;width:120px;height:36px">Model</button><button data-testid="share-chat-button" style="position:absolute;right:90px;top:10px;width:60px;height:36px">Share</button><button data-testid="profile-button" style="position:absolute;right:16px;top:10px;width:44px;height:36px">Profile</button></header>', 'header', { width, height: 740 })
    const fab = await run.page.locator('[data-inkstone] .fab').boundingBox()
    assert.ok(fab && fab.x >= 8 && fab.x + fab.width <= width - 8, '密集顶栏的导出入口不能越出左右边界')
    for (const button of await run.page.locator('header button').all()) {
      const native = await button.boundingBox()
      assert.ok(fab.x + fab.width <= native.x || native.x + native.width <= fab.x || fab.y + fab.height <= native.y || native.y + native.height <= fab.y, '回退定位不能盖住原生控件')
    }
    await hit(run.page, await point(run.page, '.fab'), 'inkstone')
    await run.page.locator('[data-inkstone] .fab').click()
    const panel = await run.page.locator('[data-inkstone] .panel').boundingBox()
    assert.ok(panel && panel.x >= 16 && panel.x + panel.width <= width - 16)
    assert.ok(panel.y >= fab.y + fab.height && panel.y + panel.height <= 740)
    assert.deepEqual(run.errors, [])
    if (width === 360) await run.page.screenshot({ path: join(outputDir, 'chatgpt-dense-header.png') })
    await run.context.close()
    console.log(`PASS: ${width}px 密集顶栏入口可见、不覆盖控件且可打开面板`)
  }

  const stable = await mount('chatgpt', '<header id="page-header"></header>')
  const stableLeft = await stable.page.evaluate(() => {
    const competing = document.createElement('header')
    competing.style.width = 'calc(100% + 1px)'
    document.body.prepend(competing)
    window.dispatchEvent(new Event('resize'))
    return document.querySelector('[data-inkstone]').shadowRoot.querySelector('.fab').getBoundingClientRect().left
  })
  assert.equal(stableLeft, 1280 - 36 - 8, '同步位置必须使用绑定锚点的定位方式，不能重新扫描其他 header 后静默变为 beside')
  assert.deepEqual(stable.errors, [])
  await stable.context.close()
  console.log('PASS: 并存顶栏不改变已绑定锚点的完整顶栏定位方式')

  for (const viewport of [
    { width: 360, height: 740 },
    { width: 390, height: 844 },
    { width: 844, height: 390 },
    { width: 1440, height: 900 },
  ]) {
    for (const layout of ['actions', 'fallback', 'unlabelled-share', 'unlabelled-actions', 'unlabelled-spaced']) {
      const fullHeader = layout === 'fallback'
      const unlabelled = layout.startsWith('unlabelled')
      const spaced = layout === 'unlabelled-spaced'
      const html = fullHeader ? '<header id="page-header"></header>' : unlabelled
        ? `<header id="page-header"><button style="position:absolute;left:16px;top:10px;width:80px;height:36px">Model</button><div data-audit-actions class="actions" style="right:0;width:200px;display:flex;gap:${spaced ? 24 : 8}px"><button style="width:${spaced ? 56 : 80}px;flex:none">Files</button><button ${layout === 'unlabelled-share' ? 'data-testid="share-chat-button"' : ''} style="width:${spaced ? 48 : 60}px;flex:none">Share</button><button data-testid="profile-button" style="width:${spaced ? 48 : 44}px;flex:none">Profile</button></div></header>`
        : '<header id="page-header"><div id="conversation-header-actions" data-audit-actions class="actions" style="right:0;width:200px;display:flex"><button>Files</button><button>Share</button><button>Profile</button></div></header>'
      const run = await mount('chatgpt', html, 'header', viewport)
      const fab = await run.page.locator('[data-inkstone] .fab').boundingBox()
      assert.ok(fab && fab.x >= 0 && fab.x + fab.width <= viewport.width)
      if (fullHeader) {
        assert.equal(fab.x + fab.width, viewport.width - 8, '完整顶栏兜底必须明确使用右内边距')
      } else {
        const actions = await run.page.locator('[data-audit-actions]').boundingBox()
        assert.ok(fab.x + fab.width <= actions.x - 8, '宽动作组不能误判为完整顶栏或与导出按钮重叠')
      }
      await hit(run.page, await point(run.page, '.fab'), 'inkstone')
      await run.page.locator('[data-inkstone] .fab').click()
      assert.equal(await run.page.locator('[data-inkstone] .panel').isVisible(), true)
      const panel = await run.page.locator('[data-inkstone] .panel').boundingBox()
      assert.ok(panel && panel.x >= 16 && panel.x + panel.width <= viewport.width - 16, '顶栏导出面板不能越出视口')
      assert.ok(panel.y >= 0 && panel.y + panel.height <= viewport.height, '导出面板必须保留完整可见的操作区域')
      if (viewport.width === 360) await run.page.screenshot({ path: join(outputDir, `chatgpt-narrow-${layout}.png`) })
      assert.deepEqual(run.errors, [])
      assert.ok(run.requests.every((url) => !url.includes('/api/')))
      await run.context.close()
      console.log(`PASS: ${viewport.width}x${viewport.height} ${layout}，按钮无重叠且可打开面板`)
    }
  }

  for (const fixture of fixtures) {
    const run = await mount('chatgpt',
      '<div id="conversation-header-actions" class="hidden"></div><header id="decoy-header"></header>' + fixture.header + fixture.composer)
    const fab = await run.page.locator('[data-inkstone] .fab').boundingBox()
    assert.ok(fab)
    assert.ok(Math.abs(fab.x - (fixture.headerLeft == null ? 1280 - 36 - 8 : fixture.headerLeft - 44)) < 2, `${fixture.name}: 必须选中可见顶栏锚点`)
    assert.ok(fab.y >= 0 && fab.y < 56)
    await hit(run.page, await point(run.page, '.fab'), 'inkstone')
    await run.page.addStyleTag({ content: 'body > [data-inkstone] { position:static !important; z-index:1 !important; isolation:auto !important; }' })
    await hit(run.page, await point(run.page, '.fab'), 'inkstone')
    await run.page.evaluate(() => {
      const dialog = document.createElement('dialog')
      dialog.id = 'native-modal'
      dialog.style.cssText = 'position:fixed;inset:0;margin:0;width:100vw;height:100vh;max-width:none;max-height:none'
      document.body.append(dialog)
      dialog.showModal()
    })
    await hit(run.page, await point(run.page, '.fab'), 'native-modal')
    await run.page.evaluate(() => document.querySelector('#native-modal').remove())
    await run.page.locator('[data-inkstone] .fab').click()
    await run.page.locator('[data-inkstone] .adv-toggle').click()
    await run.page.locator('[data-inkstone] select[data-opt="fabPos"]').selectOption('composer')
    await run.page.locator('[data-inkstone] .fab.in').waitFor()
    const moved = await run.page.locator('[data-inkstone] .fab').boundingBox()
    assert.ok(moved.y > 730 && moved.x >= 1030, `${fixture.name}: 必须选中可见输入框容器`)
    assert.equal(await run.page.locator('[data-inkstone] .panel').isVisible(), false)
    await hit(run.page, await point(run.page, '.fab'), 'inkstone')
    await run.page.locator('[data-inkstone] .fab').click()
    await run.page.evaluate(() => history.pushState({}, '', '/c/11111111-1111-4111-8111-111111111111'))
    await run.page.locator('[data-inkstone] .panel').waitFor({ state: 'hidden' })
    const report = await run.page.evaluate(probe)
    assert.equal(report.site, 'chatgpt')
    assert.equal(report.host.style.zIndex, '2147483647')
    assert.equal(report.host.style.isolation, 'isolate')
    assert.equal(report.host.style.position, 'fixed')
    assert.equal(report.fabHitTests[0].inkstoneIsTop, true)
    assert.deepEqual(run.errors, [])
    assert.ok(run.requests.every((url) => !url.includes('/api/')), 'UI/探针不能请求 API')
    await run.context.close()
    console.log(`PASS: ${fixture.name} DOM 锚点、两种按钮位置、切换收起、URL 切页收起、顶栏层叠`)
  }

  for (const mode of ['header', 'composer']) {
    const run = await mount('claude',
      '<div id="dframe-header-actions-slot" class="actions" style="position:fixed;z-index:10"><button>Share</button></div>' +
      '<fieldset class="composer"><div data-testid="chat-input" contenteditable="true"></div></fieldset>', mode)
    await hit(run.page, await point(run.page, '.fab'), 'inkstone')
    await run.page.locator('[data-inkstone] .fab').click()
    const before = await run.page.evaluate(probe)
    assert.equal(before.host.style.position, 'static')
    assert.equal(before.host.style.zIndex, 'auto')
    assert.equal(before.host.style.isolation, 'auto')
    assert.equal(before.fab.style.zIndex, '40')
    assert.equal(before.panel.style.zIndex, '41')
    assert.equal(before.fabHitTests[0].inkstoneIsTop, true)
    await run.page.screenshot({ path: join(outputDir, `claude-${mode}-normal.png`) })
    const panelPoint = await point(run.page, '.panel')
    await run.page.evaluate(() => {
      const overlay = document.createElement('div')
      overlay.id = 'page-overlay'
      overlay.setAttribute('role', 'menu')
      overlay.style.cssText = 'position:fixed;inset:0;z-index:50;background:white'
      document.body.append(overlay)
    })
    await hit(run.page, await point(run.page, '.fab'), 'page-overlay')
    await hit(run.page, panelPoint, 'page-overlay')
    const covered = await run.page.evaluate(probe)
    assert.equal(covered.fabHitTests[0].inkstoneIsTop, false)
    assert.equal(covered.panelHitTests[0].inkstoneIsTop, false)
    assert.equal(covered.visibleOverlays.length, 1)
    await run.page.screenshot({ path: join(outputDir, `claude-${mode}-overlay.png`) })
    await run.page.evaluate(() => document.querySelector('#page-overlay').remove())
    await hit(run.page, await point(run.page, '.fab'), 'inkstone')
    await run.page.locator('[data-inkstone] .fab').click()
    assert.deepEqual(run.errors, [])
    assert.ok(run.requests.every((url) => !url.includes('/api/')))
    await run.context.close()
    console.log(`PASS: Claude ${mode} 正常可点击，z-50 页面浮层覆盖按钮和面板，关闭后恢复；诊断探针正确识别遮挡`)
  }
} finally {
  await browser.close()
}
