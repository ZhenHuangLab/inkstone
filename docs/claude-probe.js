// claude.ai 结构 / 限流探针
//
// 用法：在 claude.ai 打开任意一条对话，F12 打开控制台，整段粘贴回车。
//
// 它做两件事：
//   1. 打印接口返回的**字段骨架**（键名 + 类型），不打印任何对话内容
//   2. 以保守节奏做一次小规模限流试探，观察服务端反应
//
// 请求预算：结构探测 2 个，限流试探最多 6 个，全程 ≤ 8 个请求，间隔不低于 1s，
// 一旦吃到 429 立刻停止。这是刻意的——Claude 侧的限流阈值尚无实测数据，
// 探针本身绝不能成为触发限制的原因。
//
// 结果里带 [待测] 标记的字段，对应 docs/claude-adapter-feasibility.md 的清单。

;(async () => {
  const log = (...a) => console.log('%c[inkstone]', 'color:#1e6b72;font-weight:bold', ...a)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  // ---------- 会话上下文 ----------
  const orgFromCookie = document.cookie.match(/lastActiveOrg=([^;]+)/)?.[1]
  let org = orgFromCookie && decodeURIComponent(orgFromCookie)
  try {
    const r = await fetch('/api/organizations', { credentials: 'include' })
    const d = await r.json()
    const list = Array.isArray(d) ? d : (d?.organizations ?? [])
    log('组织数', list.length, '| cookie 与接口是否一致：', list[0]?.uuid === org)
    if (list[0]?.uuid) org = list[0].uuid
  } catch (e) {
    log('取组织接口失败，改用 cookie：', String(e))
  }
  if (!org) return log('拿不到组织 id，请确认已登录')

  const convId = location.pathname.split('/').pop()
  if (!convId || convId.length < 20 || !convId.includes('-')) {
    return log('请先打开一条具体对话再运行（地址形如 /chat/<uuid>）')
  }

  // ---------- 字段骨架 ----------
  // 只保留键名与类型，值一律不打印——探针不该把对话内容抄到控制台里
  const skeleton = (v, d = 0) => {
    if (v === null) return 'null'
    if (Array.isArray(v)) return v.length ? [skeleton(v[0], d + 1)] : []
    if (typeof v !== 'object') return typeof v
    if (d > 4) return '…'
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, skeleton(x, d + 1)]))
  }
  const getJson = async (url) => {
    const t = performance.now()
    const res = await fetch(url, { credentials: 'include', headers: { Accept: 'application/json' } })
    const ms = Math.round(performance.now() - t)
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status, ms, res })
    return { data: await res.json(), ms }
  }

  log('—— 1. 列表接口 ——')
  try {
    const { data: list, ms } = await getJson(
      `/api/organizations/${org}/chat_conversations?limit=5&offset=0`,
    )
    const arr = Array.isArray(list) ? list : []
    log(`耗时 ${ms}ms | 请求 limit=5，实际返回 ${arr.length} 条`)
    log('[待测 1] 分页是否生效：返回条数 == 5 说明 limit 被认；远大于 5 说明服务端忽略了分页')
    log('[待测 2] 列表项骨架', skeleton(arr[0]))
  } catch (e) {
    log('列表接口失败', e.status ?? String(e))
  }

  await sleep(1200)

  log('—— 2. 对话详情 ——')
  let conv
  try {
    const r = await getJson(
      `/api/organizations/${org}/chat_conversations/${convId}` +
        `?tree=True&rendering_mode=messages&render_all_tools=true`,
    )
    conv = r.data
    log(`耗时 ${r.ms}ms | 消息数 ${conv.chat_messages?.length ?? 0}`)
  } catch (e) {
    return log('详情接口失败，后续探测中止', e.status ?? String(e))
  }

  const msgs = conv.chat_messages ?? []
  const blocks = msgs.flatMap((m) => m.content ?? [])
  log('会话级键', Object.keys(conv))
  log('[待测 7] Projects 归属字段：', Object.keys(conv).filter((k) => /project/i.test(k)))
  log('消息级键', [...new Set(msgs.flatMap(Object.keys))])
  log('内容块类型', [...new Set(blocks.map((b) => b.type))])
  log('tool_use 名称', [
    ...new Set(blocks.filter((b) => b.type === 'tool_use').map((b) => b.name)),
  ])

  for (const t of ['text', 'thinking', 'tool_use', 'tool_result']) {
    const b = blocks.find((x) => x.type === t)
    if (b) log(`${t} 块骨架`, skeleton(b))
  }
  log('[待测 3] thinking 正文在哪个键：看上面 thinking 块骨架里哪个字段是 string')
  log('[待测 4] citations 挂载位置：', skeleton(blocks.find((b) => b.citations?.length)?.citations?.[0]))

  const file = msgs.flatMap((m) => m.files ?? [])[0]
  if (file) log('files[0] 骨架', skeleton(file))
  const att = msgs.flatMap((m) => m.attachments ?? [])[0]
  if (att) log('attachments[0] 骨架', skeleton(att))

  // [待测 6] 公式定界符：只看形态，不打印正文
  const mathSample = blocks
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
  log('[待测 6] 公式定界符：', {
    '$...$': /(?<!\\)\$[^$\n]+\$/.test(mathSample),
    '\\(...\\)': /\\\(/.test(mathSample),
    '$$...$$': /\$\$/.test(mathSample),
  })

  // [待测 5] 附件地址能否直接取到字节
  const previewUrl = file?.preview_url || file?.preview_asset?.url || file?.document_asset?.url
  if (previewUrl) {
    await sleep(1200)
    try {
      const res = await fetch(new URL(previewUrl, location.origin), { credentials: 'include' })
      log('[待测 5] 附件请求', {
        status: res.status,
        type: res.headers.get('content-type'),
        length: res.headers.get('content-length'),
        redirected: res.redirected,
        sameOrigin: new URL(res.url).origin === location.origin,
      })
      res.body?.cancel()
    } catch (e) {
      log('[待测 5] 附件请求失败', String(e))
    }
  } else {
    log('[待测 5] 这条对话没有附件，换一条带图片/文档的再测')
  }

  // ---------- 限流小规模试探 ----------
  // 逐步收紧间隔，看服务端在什么节奏下开始推回。一旦 429 立即停止并报告，
  // 绝不试图「顶着限流继续」——那正是要避免的行为。
  log('—— 3. 限流试探（最多 4 个请求，间隔 2000→800ms，遇 429 立即停止）——')
  const observations = []
  for (const gap of [2000, 1500, 1000, 800]) {
    await sleep(gap)
    const t = performance.now()
    try {
      const res = await fetch(`/api/organizations/${org}/chat_conversations?limit=1&offset=0`, {
        credentials: 'include',
        headers: { Accept: 'application/json' },
      })
      const ms = Math.round(performance.now() - t)
      const retryAfter = res.headers.get('retry-after')
      observations.push({ gap, status: res.status, ms, retryAfter })
      res.body?.cancel()
      if (res.status === 429) {
        log('吃到 429，停止试探。Retry-After =', retryAfter ?? '(无)')
        break
      }
    } catch (e) {
      observations.push({ gap, status: 'error', error: String(e) })
      break
    }
  }
  console.table(observations)
  const throttled = observations.some((o) => o.status === 429)
  log(
    throttled
      ? '结论：这个节奏已经会被限流，Inkstone 的起步间距应保持在 1500ms 以上'
      : '结论：4 次小规模请求未触发限流。这只说明「不算激进」，不代表全量抓取安全——' +
          '要放宽并发/间距，必须再做更大规模的分级试跑',
  )
  log('把上面的输出贴进 issue 或 docs/claude-adapter-feasibility.md 的待测清单里')
})()
