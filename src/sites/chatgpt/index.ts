import {
  createConversationPager,
  fetchBinary,
  fetchConversation,
  getAccessToken,
  listAllConversations,
  listProjects,
  projectNameOf,
  resolveFileDownload,
  throttleStats,
} from '../../api'
import type { AssetRef } from '../../core/ir'
import type { CancelToken } from '../../core/fetcher'
import type { ConversationDetail, ConversationListItem, ProjectInfo } from '../../types'
import type {
  AssetPayload,
  Rgb,
  SiteAdapter,
  SiteConversationItem,
  SiteHeaderAnchor,
  SiteIRContextResolver,
} from '../types'
import { conversationToIR } from './convert'

const toItem = (i: ConversationListItem): SiteConversationItem => ({
  id: i.id,
  title: i.title ?? '',
  update_time: i.update_time ?? null,
  project: projectNameOf(i.gizmo_id),
})

interface ChatGPTIRContext {
  projectName?: string
}

type ProjectLoader = (session: string, cancel?: CancelToken) => Promise<ProjectInfo[]>

/** project 侧栏每次导出至多补拉一次；自定义 GPT 的 gizmo_id 查不到也不会重复请求。 */
export function createChatGPTIRContextResolver(
  session: string,
  cancel?: CancelToken,
  loadProjects: ProjectLoader = listProjects,
): SiteIRContextResolver {
  let projectsPass: Promise<unknown> | null = null
  return async (_id, raw): Promise<ChatGPTIRContext> => {
    const gizmoId = (raw as ConversationDetail).gizmo_id
    if (!gizmoId) return {}
    const known = projectNameOf(gizmoId)
    if (known) return { projectName: known }
    projectsPass ??= loadProjects(session, cancel)
    try {
      await projectsPass
    } catch (error) {
      if (cancel?.cancelled) throw error
      return {}
    }
    return { projectName: projectNameOf(gizmoId) }
  }
}

function isVisible(el: Element | null): el is HTMLElement {
  if (!(el instanceof HTMLElement) || !el.isConnected) return false
  const rect = el.getBoundingClientRect()
  if (rect.width < 1 || rect.height < 1) return false
  const style = getComputedStyle(el)
  return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0
}

function firstVisible(selectors: readonly string[], root: ParentNode = document): HTMLElement | null {
  for (const selector of selectors) {
    for (const el of root.querySelectorAll(selector)) {
      if (isVisible(el)) return el
    }
  }
  return null
}

function bottommostVisible(selectors: readonly string[]): HTMLElement | null {
  for (const selector of selectors) {
    const matches = [...document.querySelectorAll(selector)].filter(isVisible)
    if (matches.length > 0) {
      return matches.sort(
        (a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom,
      )[0]!
    }
  }
  return null
}

function topPageHeader(): HTMLElement | null {
  return [...document.querySelectorAll('#page-header, header')]
    .filter(isVisible)
    .filter((header) => {
      const rect = header.getBoundingClientRect()
      return rect.top <= 12 && rect.width >= Math.min(320, window.innerWidth * 0.65)
    })
    .sort((a, b) => {
      const ar = a.getBoundingClientRect()
      const br = b.getBoundingClientRect()
      return ar.top - br.top || br.width - ar.width
    })[0] ?? null
}

/** ChatGPT 没暴露可靠主题变量时沿用 v3 前的 Inkstone 蓝，避免误取页面里的无关 accent。 */
export const CHATGPT_FALLBACK_ACCENT: Rgb = [94, 106, 210]

export function cssColorIsDark(raw: string): boolean | null {
  const match = /^rgba?\(\s*([\d.]+)(?:\s*,\s*|\s+)([\d.]+)(?:\s*,\s*|\s+)([\d.]+)(?:\s*(?:,|\/)\s*([\d.]+%?))?\s*\)$/i.exec(
    raw.trim(),
  )
  if (!match) return null
  const alphaRaw = match[4]
  const alpha = alphaRaw?.endsWith('%') ? Number(alphaRaw.slice(0, -1)) / 100 : Number(alphaRaw ?? 1)
  if (!Number.isFinite(alpha) || alpha < 0.5) return null
  const channels = [Number(match[1]), Number(match[2]), Number(match[3])]
  if (channels.some((value) => !Number.isFinite(value))) return null
  const linear = channels.map((value) => {
    const channel = Math.max(0, Math.min(255, value)) / 255
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  })
  const luminance = 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!
  return luminance < 0.45
}

function chatGPTIsDark(): boolean {
  const root = document.documentElement
  const candidates = [root, document.body].filter((el): el is HTMLElement => Boolean(el))

  for (const el of candidates) {
    if ([...el.classList].some((name) => /(^|[-_])dark($|[-_])/i.test(name))) return true
    for (const attribute of ['data-theme', 'data-mode', 'data-color-scheme']) {
      const value = el.getAttribute(attribute)?.trim().toLowerCase()
      if (value === 'dark') return true
      if (value === 'light') return false
    }
  }

  for (const el of candidates) {
    const scheme = getComputedStyle(el).colorScheme.trim().toLowerCase()
    if (scheme.startsWith('dark')) return true
    if (scheme.startsWith('light')) return false
  }

  // 新版 ChatGPT 可能不再把 dark class 挂到 html；此时以页面实际可见表面为准。
  const surfaces = [topPageHeader(), document.body, root, document.querySelector('main')]
  for (const surface of surfaces) {
    if (!(surface instanceof HTMLElement)) continue
    const dark = cssColorIsDark(getComputedStyle(surface).backgroundColor)
    if (dark !== null) return dark
  }

  // 透明表面最后用正文颜色反推背景；系统偏好只作为无页面线索时的终极兜底。
  for (const el of candidates) {
    const foregroundIsDark = cssColorIsDark(getComputedStyle(el).color)
    if (foregroundIsDark !== null) return !foregroundIsDark
  }
  return matchMedia('(prefers-color-scheme: dark)').matches
}

export function resolveChatGPTAccent(
  theme: string | null,
  readVariable: (name: string) => string,
  parse: (raw: string) => Rgb | null,
): { bg: Rgb; fg: Rgb | null; ring: Rgb | null } {
  const name = theme || 'default'
  const bg = parse(readVariable(`--${name}-theme-submit-btn-bg`))
  if (!bg) {
    return {
      bg: [...CHATGPT_FALLBACK_ACCENT],
      fg: [255, 255, 255],
      ring: [...CHATGPT_FALLBACK_ACCENT],
    }
  }
  return {
    bg,
    fg: parse(readVariable(`--${name}-theme-submit-btn-text`)),
    ring: parse(readVariable(`--${name}-theme-entity-accent`)),
  }
}

/** Share/动作槽缺失时，取顶栏右侧最后一组连续控件的左边界。 */
function rightHeaderActionAnchor(header: HTMLElement): HTMLElement | null {
  const headerRect = header.getBoundingClientRect()
  const rightZone = Math.max(headerRect.left + headerRect.width * 0.7, window.innerWidth * 0.75)
  const controls = [...header.querySelectorAll('button, a[role="button"], [data-testid="profile-button"]')]
    .filter(isVisible)
    .filter((el) => {
      const rect = el.getBoundingClientRect()
      return rect.top >= headerRect.top - 8 && rect.top < headerRect.bottom + 8
    })
    .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)
  if (controls.length === 0 || controls[controls.length - 1]!.getBoundingClientRect().right < rightZone) return null

  let first = controls.length - 1
  while (first > 0) {
    const prev = controls[first - 1]!.getBoundingClientRect()
    const next = controls[first]!.getBoundingClientRect()
    // 间隙必须容得下 36px 按钮和 8px 间距，否则仍需沿整组左移，避免盖住前一控件。
    if (next.left - prev.right >= 36 + 8 || Math.abs(next.top - prev.top) > 10) break
    first--
  }
  return controls[first]!
}

function besideHeaderAnchor(element: HTMLElement, header: HTMLElement | null): SiteHeaderAnchor {
  return element.getBoundingClientRect().left - 36 - 8 < 8
    ? { element: header ?? element, placement: 'below' }
    : { element, placement: 'beside' }
}

export function chatGPTHeaderAnchor(): SiteHeaderAnchor | null {
  const actionGroup = firstVisible(['#conversation-header-actions'])
  const header = topPageHeader()
  if (actionGroup) return besideHeaderAnchor(actionGroup, header)
  if (!header) return null
  const share = firstVisible(
    [
      '[data-testid="share-chat-button"]',
      '[data-testid*="share" i]',
      'button[aria-label*="share" i]',
      'button[aria-label*="分享"]',
      'button[aria-label*="共享"]',
    ],
    header,
  )
  // 新会话“工作”模式没有任何右侧动作；返回完整顶栏，由定位层放到右内边距。
  const control = rightHeaderActionAnchor(header) ?? share
  return control ? besideHeaderAnchor(control, header) : { element: header, placement: 'inset' }
}

export function chatGPTComposerAnchor(): HTMLElement | null {
  const editor = bottommostVisible([
    '#prompt-textarea',
    '[data-testid="prompt-textarea"]',
    'form[data-chatgpt-composer] [data-composer-markdown][contenteditable="true"][role="textbox"]',
    'form[data-chatgpt-composer] .ProseMirror[contenteditable="true"]',
    '[data-composer-markdown][contenteditable="true"][role="textbox"]',
    '[contenteditable="true"][data-lexical-editor="true"][role="textbox"]',
  ])
  if (!editor) {
    return firstVisible(['form[data-chatgpt-composer]', 'form[data-type="unified-composer"]'])
  }
  const container = editor.closest(
    'form[data-chatgpt-composer], form[data-type="unified-composer"], form, [data-testid="composer"], #thread-bottom-container',
  )
  if (isVisible(container)) return container

  // “工作”模式没有 form 或稳定容器属性：取包住编辑器的第一个紧凑可见祖先。
  // 只靠几何约束，不绑定易变的 Tailwind class。
  const editorRect = editor.getBoundingClientRect()
  let ancestor = editor.parentElement
  for (let depth = 0; ancestor && depth < 10; depth++, ancestor = ancestor.parentElement) {
    if (!isVisible(ancestor)) continue
    const rect = ancestor.getBoundingClientRect()
    if (
      rect.width >= editorRect.width &&
      rect.height >= editorRect.height + 16 &&
      rect.height <= Math.min(240, window.innerHeight * 0.4) &&
      rect.top <= editorRect.top &&
      rect.bottom >= editorRect.bottom
    ) {
      return ancestor
    }
  }
  return editor
}

export const chatgptAdapter: SiteAdapter = {
  id: 'chatgpt',
  label: 'ChatGPT',
  supportsBatch: true,

  matches: () => /(^|\.)chatgpt\.com$|(^|\.)chat\.openai\.com$/.test(location.hostname),

  currentConversationId() {
    const m = /\/c\/([0-9a-f][0-9a-f-]{10,})/i.exec(location.pathname)
    return m ? m[1]! : null
  },

  prepare: (cancel) => getAccessToken(cancel),

  fetchRaw: (session, id, cancel) => fetchConversation(session, id, cancel),

  createIRContextResolver: createChatGPTIRContextResolver,

  toIR: (raw, fallbackId, context) =>
    conversationToIR(
      raw as ConversationDetail,
      fallbackId,
      (context as ChatGPTIRContext | undefined)?.projectName,
    ),

  async fetchAsset(
    session: string,
    ref: AssetRef,
    cancel?: CancelToken,
    maxBytes?: number,
  ): Promise<AssetPayload> {
    // ChatGPT 的附件要先用 file id 换一个签名下载地址（fn 参数带原始文件名）
    const target = await resolveFileDownload(session, ref.fileId, cancel)
    const { bytes, contentType } = await fetchBinary(target.url, cancel, maxBytes)
    return { bytes, filename: target.filename, contentType }
  },

  throttleStats,

  batch: {
    // 保持 344 + 432 对话实测得到的既有节奏与失败重试策略。
    policy: {
      concurrency: 2,
      retryFailed: true,
      retryDelayMs: 20_000,
      failureAbortMin: 25,
      failureAbortRatio: 0.5,
    },
    async listAll(session, onProgress, cancel) {
      return (await listAllConversations(session, onProgress, cancel)).map(toItem)
    },
    listSources: (session, cancel) => listProjects(session, cancel),
    createPager(session, cancel, source) {
      const pager = createConversationPager(session, cancel, source)
      return {
        async next() {
          const { items, done } = await pager.next()
          return { items: items.map(toItem), done }
        },
      }
    },
  },

  ui: {
    headerAnchor: chatGPTHeaderAnchor,

    composerAnchor: chatGPTComposerAnchor,

    isDark: chatGPTIsDark,

    themeAttributes: ['class', 'style', 'data-chat-theme', 'data-theme', 'data-mode', 'data-color-scheme'],

    // ChatGPT 的 accent 方案（2026-07 实测）：html[data-chat-theme="purple"] +
    // 每主题一族变量 --{theme}-theme-submit-btn-bg/-text 与 --{theme}-theme-entity-accent。
    // 直接读当前主题的发送键配色作主色；变量消失（改版）时回退历史蓝色，
    // 不交给通用扫描误取页面里与 ChatGPT 品牌无关的橙色变量。
    accent(parse) {
      const rootEl = document.documentElement
      const cs = getComputedStyle(rootEl)
      return resolveChatGPTAccent(
        rootEl.getAttribute('data-chat-theme'),
        (name) => cs.getPropertyValue(name),
        parse,
      )
    },
  },
}
