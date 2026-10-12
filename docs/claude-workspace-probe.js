// 在已登录的 claude.ai 具体对话页，打开 F12 → Console，粘贴整个文件运行。
// 最多 3 次同源 GET，间隔 1500ms；任何 HTTP 错误立即停止，不重试。
// 只输出结构/计数/状态，不输出 cookie、组织 UUID/名称、对话 UUID/正文或文件路径。
;(async () => {
  const report = { probe: 'inkstone-claude-workspace-v1', requests: [], workspace: {}, conversation: {}, sandbox: {} }
  const finish = () => {
    console.log('INKSTONE_CLAUDE_WORKSPACE_PROBE_BEGIN')
    console.log(JSON.stringify(report, null, 2))
    console.log('INKSTONE_CLAUDE_WORKSPACE_PROBE_END')
    return report
  }
  if (location.hostname !== 'claude.ai') {
    report.stopped = '请在 claude.ai 页面运行'
    return finish()
  }
  let active = null
  const encoded = /(?:^|;\s*)lastActiveOrg=([^;]+)/.exec(document.cookie)?.[1]
  report.workspace.cookiePresent = Boolean(encoded)
  try {
    active = encoded ? decodeURIComponent(encoded) : null
    report.workspace.cookieDecodable = true
  } catch {
    report.workspace.cookieDecodable = false
  }
  const get = async (phase, path) => {
    if (report.requests.length) await new Promise((resolve) => setTimeout(resolve, 1500))
    const observation = { phase }
    report.requests.push(observation)
    try {
      const response = await fetch(path, {
        credentials: 'same-origin', mode: 'same-origin', redirect: 'error',
        headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15000),
      })
      observation.status = response.status
      if (!response.ok) {
        await response.body?.cancel()
        throw new Error('http')
      }
      return await response.json()
    } catch {
      report.stopped = `请求 ${phase} 失败，已停止（未重试）`
      return null
    }
  }
  const data = await get('organizations', '/api/organizations')
  if (report.stopped) return finish()
  const list = Array.isArray(data) ? data : data?.organizations
  if (!Array.isArray(list)) {
    report.stopped = '组织列表结构与适配器预期不符'
    return finish()
  }
  const memberships = [...new Map(list.filter((org) => typeof org?.uuid === 'string' && org.uuid)
    .map((org) => [org.uuid, org])).values()]
  const matched = memberships.findIndex((org) => org.uuid === active)
  report.workspace.organizationCount = memberships.length
  report.workspace.activeMembershipIndex = matched >= 0 ? matched + 1 : null
  report.workspace.activeIsFirst = matched >= 0 ? matched === 0 : null
  report.workspace.selectionRequiresUser = matched < 0 && memberships.length > 1
  const selected = matched >= 0 ? memberships[matched] : memberships.length === 1 ? memberships[0] : null
  if (!selected) {
    report.stopped = '无法确定当前工作区，未请求任何组织的对话'
    return finish()
  }
  const id = /\/chat\/([0-9a-f-]{20,})/i.exec(location.pathname)?.[1]
  if (!id) {
    report.stopped = '组织检查完成；请在具体对话页重跑以检查正文与沙箱端点'
    return finish()
  }
  const base = `/api/organizations/${encodeURIComponent(selected.uuid)}`
  const conversation = await get('current-conversation', `${base}/chat_conversations/${id}?tree=True&rendering_mode=messages&render_all_tools=true`)
  if (report.stopped) return finish()
  report.conversation.messagesAreArray = Array.isArray(conversation?.chat_messages)
  if (!report.conversation.messagesAreArray) {
    report.stopped = '对话详情结构与适配器预期不符'
    return finish()
  }
  report.conversation.messageCount = conversation.chat_messages.length
  report.conversation.hasPresentFiles = conversation.chat_messages.some((message) =>
    Array.isArray(message?.content) && message.content.some((block) => block?.type === 'tool_use' && block?.name === 'present_files'))
  if (report.conversation.hasPresentFiles) {
    const sandbox = await get('sandbox-list', `${base}/conversations/${id}/wiggle/list-files?prefix=`)
    if (report.stopped) return finish()
    report.sandbox.filesMetadataIsArray = Array.isArray(sandbox?.files_metadata)
    if (report.sandbox.filesMetadataIsArray) {
      report.sandbox.fileCount = sandbox.files_metadata.length
      report.sandbox.validPathCount = sandbox.files_metadata.filter((file) => typeof file?.path === 'string' && file.path !== '').length
    }
  } else {
    report.sandbox.skipped = '当前对话没有 present_files，适配器不会请求沙箱清单'
  }
  report.workspace.cookieChangedDuringProbe = /(?:^|;\s*)lastActiveOrg=([^;]+)/.exec(document.cookie)?.[1] !== encoded
  return finish()
})()
