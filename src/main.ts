import {
  CancelledError,
  fetchConversation,
  getAccessToken,
  jitter,
  listAllConversations,
  mapConcurrent,
  sleep,
  type CancelToken,
} from './api'
import { conversationToMarkdown, filenameFor } from './convert/markdown'
import { downloadBlob, makeZip, strToU8 } from './output/zip'
import { mountPanel, type ExportKind, type PanelHandle } from './ui'

let activeCancel: CancelToken | null = null

mountPanel(startExport, () => {
  if (activeCancel) activeCancel.cancelled = true
})

interface Failure {
  id: string
  title: string
  error: string
}

async function startExport(kind: ExportKind, panel: PanelHandle): Promise<void> {
  const cancel: CancelToken = { cancelled: false }
  activeCancel = cancel
  try {
    panel.setStatus('获取登录态…')
    const token = await getAccessToken(cancel)

    panel.setStatus('拉取对话列表…')
    const list = await listAllConversations(
      token,
      (n, total) => panel.setStatus(`拉取对话列表… ${n}/${Number.isFinite(total) ? total : '?'}`),
      cancel,
    )
    if (list.length === 0) {
      panel.setStatus('没有可导出的对话')
      return
    }

    const files: Record<string, Uint8Array> = {}
    const failures: Failure[] = []
    let done = 0
    await mapConcurrent(
      list,
      2,
      async item => {
        try {
          const conv = await fetchConversation(token, item.id, cancel)
          if (kind === 'json') {
            files[`raw/${item.id}.json`] = strToU8(JSON.stringify(conv, null, 2))
          } else {
            const { markdown, title } = conversationToMarkdown(conv, item.id)
            files[`conversations/${filenameFor(title, item.id)}`] = strToU8(markdown)
          }
        } catch (e) {
          if (e instanceof CancelledError) throw e
          failures.push({ id: item.id, title: item.title ?? '', error: String(e) })
        }
        done++
        panel.setProgress(done, list.length)
        panel.setStatus(`抓取对话 ${done}/${list.length}${failures.length ? `（失败 ${failures.length}）` : ''}`)
        await sleep(jitter(150))
      },
      cancel,
    )

    if (failures.length > 0) {
      files['_failures.json'] = strToU8(JSON.stringify(failures, null, 2))
    }

    panel.setStatus('打包 zip…')
    const data = await makeZip(files)
    const stamp = new Date()
      .toISOString()
      .slice(0, 16)
      .replace(/[T:]/g, '-')
    downloadBlob(`chatgpt-export-${kind}-${stamp}.zip`, data)
    panel.setStatus(
      `完成：${list.length - failures.length} 个对话` +
        (failures.length ? `，${failures.length} 个失败（见 zip 内 _failures.json）` : ''),
    )
  } catch (e) {
    panel.setStatus(e instanceof CancelledError ? '已取消' : `出错：${String(e)}`)
  } finally {
    activeCancel = null
    panel.finish()
  }
}
