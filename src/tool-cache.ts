import type { ConversationDetail, MappingNode, Message } from './types'

declare const GM_getValue: ((key: string, defaultValue?: string) => string | undefined) | undefined
declare const GM_setValue: ((key: string, value: string) => void) | undefined
declare const unsafeWindow: Window | undefined

const PREFIX = 'inkstone:tool-cache:v1:'
const MAX_MESSAGES = 100
const MAX_GROUPS = 200
const MAX_ITEM_CHARS = 8 * 1024 * 1024
const MAX_RESPONSE_CHARS = 32 * 1024 * 1024

type ToolCall = {
  connector: string | null
  name: string
  toolInput: unknown
  toolOutput: unknown
  toolResponseMetadata: unknown
  signature: string
}

type Cache = {
  messages: Record<string, { capturedAt: number; message: Message }>
  groups: Array<{ capturedAt: number; calls: ToolCall[] }>
  updatedAt?: number
}

function storeGet(key: string): string | null {
  try {
    if (typeof GM_getValue === 'function') return GM_getValue(key) ?? null
  } catch {}
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function storeSet(key: string, value: string): void {
  try {
    if (typeof GM_setValue === 'function') {
      GM_setValue(key, value)
      return
    }
  } catch {}
  try {
    localStorage.setItem(key, value)
  } catch {}
}

const conversationId = (): string | null =>
  /\/c\/([0-9a-f][0-9a-f-]{10,})/i.exec(location.pathname)?.[1] ?? null
const cacheKey = (id: string): string => `${PREFIX}${id}`

function loadCache(id: string | null): Cache {
  if (!id) return { messages: {}, groups: [] }
  try {
    const value = JSON.parse(storeGet(cacheKey(id)) ?? '{}') as Partial<Cache>
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (!value.messages || typeof value.messages !== 'object' || Array.isArray(value.messages)) value.messages = {}
      if (!Array.isArray(value.groups)) value.groups = []
      return value as Cache
    }
  } catch {}
  return { messages: {}, groups: [] }
}

function saveCache(id: string, cache: Cache): void {
  cache.updatedAt = Date.now()
  storeSet(cacheKey(id), JSON.stringify(cache))
}

function meaningful(value: unknown): boolean {
  if (value == null) return false
  if (typeof value === 'string') return value.trim() !== ''
  if (typeof value === 'number' || typeof value === 'boolean') return true
  if (Array.isArray(value)) return value.some(meaningful)
  if (typeof value === 'object') return Object.values(value).some(meaningful)
  return false
}

function hasPayload(msg: Message | null | undefined): boolean {
  const content = msg?.content
  if (!content || typeof content !== 'object') return false
  if (meaningful(content.text) || meaningful(content.parts)) return true
  return Object.entries(content).some(
    ([key, value]) =>
      !['content_type', 'language', 'response_format_name', 'text', 'parts'].includes(key) && meaningful(value),
  )
}

function saveMessage(id: string | null, msg: Message): void {
  if (!id || !msg.id || msg.author?.role !== 'tool' || !hasPayload(msg)) return
  let encoded: string
  try {
    encoded = JSON.stringify(msg)
  } catch {
    return
  }
  if (encoded.length > MAX_ITEM_CHARS) return

  const cache = loadCache(id)
  const previous = cache.messages[msg.id]?.message
  if (previous && JSON.stringify(previous.content ?? {}).length > JSON.stringify(msg.content ?? {}).length) return

  cache.messages[msg.id] = { capturedAt: Date.now(), message: JSON.parse(encoded) as Message }
  const entries = Object.entries(cache.messages).sort(
    (a, b) => (a[1].capturedAt ?? 0) - (b[1].capturedAt ?? 0),
  )
  for (const [key] of entries.slice(0, Math.max(0, entries.length - MAX_MESSAGES))) delete cache.messages[key]
  saveCache(id, cache)
}

function canonical(value: unknown): string {
  if (value === undefined) return '"__undefined__"'
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? '"__undefined__"'
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const object = value as Record<string, unknown>
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
    .join(',')}}`
}

const signature = (name: unknown, input: unknown): string => `${String(name ?? '')}|${canonical(input ?? {})}`

function normalizeToolCall(call: unknown): ToolCall | null {
  if (!call || typeof call !== 'object') return null
  const value = call as Record<string, unknown>
  const fn = value.function && typeof value.function === 'object' ? (value.function as Record<string, unknown>) : null
  const name = value.name ?? value.tool_name ?? fn?.name
  const toolOutput = value.toolOutput ?? value.tool_output ?? value.output ?? value.result
  if (typeof name !== 'string' || !meaningful(toolOutput)) return null
  const toolInput = value.toolInput ?? value.tool_input ?? value.arguments ?? fn?.arguments ?? {}
  let encoded: string
  try {
    encoded = JSON.stringify(toolOutput)
  } catch {
    return null
  }
  if (encoded.length > MAX_ITEM_CHARS) return null
  const connector = value.connector ?? value.namespace
  return {
    connector: typeof connector === 'string' ? connector : null,
    name,
    toolInput,
    toolOutput,
    toolResponseMetadata: value.toolResponseMetadata ?? value.tool_response_metadata ?? null,
    signature: signature(name, toolInput),
  }
}

function saveGroup(id: string | null, calls: unknown[]): void {
  if (!id) return
  const normalized = calls.map(normalizeToolCall).filter((call): call is ToolCall => call != null)
  if (normalized.length === 0) return

  const cache = loadCache(id)
  const candidate = { capturedAt: Date.now(), calls: normalized }
  const key = canonical(normalized.map((call) => [call.signature, call.toolOutput]))
  const existing = new Set(cache.groups.map((group) => canonical(group.calls.map((call) => [call.signature, call.toolOutput]))))
  if (!existing.has(key)) cache.groups.push(candidate)
  cache.groups = cache.groups.slice(-MAX_GROUPS)
  saveCache(id, cache)
}

function scan(value: unknown, inheritedId: string | null = null, depth = 0): void {
  if (value == null || depth > 12) return
  if (typeof value === 'string') {
    if (depth < 8 && /(toolCalls|toolOutput|tool_calls|tool_output|"role"\s*:\s*"tool")/.test(value)) {
      try {
        scan(JSON.parse(value), inheritedId, depth + 1)
      } catch {}
    }
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) scan(item, inheritedId, depth + 1)
    return
  }
  if (typeof value !== 'object') return

  const object = value as Record<string, unknown>
  const id =
    typeof object.conversation_id === 'string'
      ? object.conversation_id
      : typeof object.conversationId === 'string'
        ? object.conversationId
        : inheritedId

  const author = object.author as { role?: unknown } | undefined
  if (author?.role === 'tool' && typeof object.id === 'string') saveMessage(id, object as unknown as Message)

  if (Array.isArray(object.toolCalls)) saveGroup(id, object.toolCalls)
  if (Array.isArray(object.tool_calls)) saveGroup(id, object.tool_calls)

  for (const child of Object.values(object)) scan(child, id, depth + 1)
}

function consumeJson(raw: string, requestId: string | null): void {
  const text = raw.trim()
  if (!text || text === '[DONE]') return
  try {
    scan(JSON.parse(text), requestId)
    return
  } catch {}
  const framed = /^[0-9a-f]+:(.*)$/s.exec(text)
  if (!framed?.[1]) return
  try {
    scan(JSON.parse(framed[1]), requestId)
  } catch {}
}

function consumeText(raw: string, requestId: string | null): void {
  if (!raw || raw.length > MAX_RESPONSE_CHARS) return
  consumeJson(raw, requestId)
  let data: string[] = []
  for (const source of raw.split('\n')) {
    const line = source.replace(/\r$/, '')
    if (line.startsWith('data:')) data.push(line.slice(5).trimStart())
    else if (line === '') {
      if (data.length > 0) consumeJson(data.join('\n'), requestId)
      data = []
    } else if (!line.startsWith(':') && data.length === 0) consumeJson(line, requestId)
  }
  if (data.length > 0) consumeJson(data.join('\n'), requestId)
}

function sameOrigin(raw: unknown): boolean {
  try {
    const url = new URL(String(raw), location.origin)
    return (
      url.origin === location.origin ||
      ((url.protocol === 'ws:' || url.protocol === 'wss:') && url.host === location.host)
    )
  } catch {
    return false
  }
}

const textual = (contentType: string | null): boolean =>
  !contentType || /json|event-stream|text\/plain|text\/x-component|ndjson|jsonl/i.test(contentType)

// Freeze the fallback when a request starts; never attribute a late response to
// whichever conversation happens to be open when the body finishes loading.
function requestConversationId(rawUrl: unknown): string | null {
  try {
    const path = new URL(String(rawUrl), location.origin).pathname
    const explicit = /\/(?:conversation|c)\/([0-9a-f][0-9a-f-]{10,})(?:\/|$)/i.exec(path)?.[1]
    if (explicit) return explicit
  } catch {}
  return conversationId()
}

async function captureResponse(response: Response, rawUrl: unknown, requestId: string | null): Promise<void> {
  try {
    if (!sameOrigin(rawUrl ?? response.url) || !textual(response.headers.get('content-type'))) return
    const length = Number(response.headers.get('content-length') ?? 0)
    if (Number.isFinite(length) && length > MAX_RESPONSE_CHARS) return
    consumeText(await response.text(), requestId)
  } catch {}
}

export function installToolCapture(): void {
  let page: Window & typeof globalThis = window
  try {
    if (typeof unsafeWindow !== 'undefined') page = unsafeWindow as Window & typeof globalThis
  } catch {}

  const originalFetch = page.fetch as (typeof fetch & { __inkstoneToolCapture?: boolean }) | undefined
  if (typeof originalFetch === 'function' && !originalFetch.__inkstoneToolCapture) {
    const wrapped = function (this: unknown, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const rawUrl = typeof input === 'string' || input instanceof URL ? String(input) : input.url
      const requestId = requestConversationId(rawUrl)
      const promise = Reflect.apply(originalFetch, this, [input, init]) as Promise<Response>
      if (!sameOrigin(rawUrl)) return promise
      return Promise.resolve(promise).then((response) => {
        try {
          void captureResponse(response.clone(), rawUrl, requestId)
        } catch {}
        return response
      })
    } as typeof fetch & { __inkstoneToolCapture?: boolean }
    Object.defineProperty(wrapped, '__inkstoneToolCapture', { value: true })
    try {
      page.fetch = wrapped
    } catch {}
  }

  const XHR = page.XMLHttpRequest as typeof XMLHttpRequest & { prototype: XMLHttpRequest & Record<string, unknown> }
  const xhrProto = XHR?.prototype as (XMLHttpRequest & {
    __inkstoneCaptureUrl?: string
    __inkstoneCaptureBound?: boolean
    __inkstoneCaptureConversationId?: string | null
    open: XMLHttpRequest['open'] & { __inkstoneToolCapture?: boolean }
  }) | undefined
  if (xhrProto && !xhrProto.open.__inkstoneToolCapture) {
    const originalOpen = xhrProto.open
    const originalSend = xhrProto.send
    const wrappedOpen = function (this: typeof xhrProto, method: string, url: string | URL, ...rest: unknown[]): void {
      try {
        this.__inkstoneCaptureUrl = new URL(String(url), location.origin).href
      } catch {
        this.__inkstoneCaptureUrl = String(url ?? '')
      }
      Reflect.apply(originalOpen, this, [method, url, ...rest])
    } as XMLHttpRequest['open'] & { __inkstoneToolCapture?: boolean }
    Object.defineProperty(wrappedOpen, '__inkstoneToolCapture', { value: true })
    try {
      xhrProto.open = wrappedOpen
      xhrProto.send = function (this: typeof xhrProto, body?: Document | XMLHttpRequestBodyInit | null): void {
        this.__inkstoneCaptureConversationId = requestConversationId(this.__inkstoneCaptureUrl)
        if (!this.__inkstoneCaptureBound) {
          this.__inkstoneCaptureBound = true
          this.addEventListener('loadend', () => {
            try {
              if (!sameOrigin(this.__inkstoneCaptureUrl) || !textual(this.getResponseHeader('content-type'))) return
              const requestId = this.__inkstoneCaptureConversationId ?? null
              if (this.responseType === '' || this.responseType === 'text') consumeText(this.responseText, requestId)
              else if (this.responseType === 'json') scan(this.response, requestId)
              else if (this.responseType === 'blob') {
                void this.response.text().then((text: string) => consumeText(text, requestId)).catch(() => {})
              }
            } catch {}
          })
        }
        Reflect.apply(originalSend, this, [body])
      }
    } catch {}
  }

  const NativeEventSource = page.EventSource as (typeof EventSource & { __inkstoneToolCapture?: boolean }) | undefined
  if (typeof NativeEventSource === 'function' && !NativeEventSource.__inkstoneToolCapture) {
    const WrappedEventSource = function (url: string | URL, config?: EventSourceInit): EventSource {
      const requestId = requestConversationId(url)
      const source = Reflect.construct(NativeEventSource, [url, config]) as EventSource
      if (sameOrigin(url)) source.addEventListener('message', (event) => consumeText(event.data, requestId))
      return source
    }
    try {
      WrappedEventSource.prototype = NativeEventSource.prototype
      Object.setPrototypeOf(WrappedEventSource, NativeEventSource)
      Object.defineProperty(WrappedEventSource, '__inkstoneToolCapture', { value: true })
      page.EventSource = WrappedEventSource as unknown as typeof EventSource
    } catch {}
  }

  const NativeWebSocket = page.WebSocket as (typeof WebSocket & { __inkstoneToolCapture?: boolean }) | undefined
  if (typeof NativeWebSocket === 'function' && !NativeWebSocket.__inkstoneToolCapture) {
    const WrappedWebSocket = function (url: string | URL, protocols?: string | string[]): WebSocket {
      const requestId = requestConversationId(url)
      const socket = Reflect.construct(
        NativeWebSocket,
        protocols === undefined ? [url] : [url, protocols],
      ) as WebSocket
      if (sameOrigin(url)) {
        socket.addEventListener('message', async (event) => {
          try {
            if (typeof event.data === 'string') consumeText(event.data, requestId)
            else if (event.data instanceof Blob) consumeText(await event.data.text(), requestId)
            else if (event.data instanceof ArrayBuffer) consumeText(new TextDecoder().decode(event.data), requestId)
          } catch {}
        })
      }
      return socket
    }
    try {
      WrappedWebSocket.prototype = NativeWebSocket.prototype
      Object.setPrototypeOf(WrappedWebSocket, NativeWebSocket)
      Object.defineProperty(WrappedWebSocket, '__inkstoneToolCapture', { value: true })
      page.WebSocket = WrappedWebSocket as unknown as typeof WebSocket
    } catch {}
  }
}

function parseInvocation(msg: Message | null | undefined): string | null {
  if (msg?.author?.role !== 'assistant') return null
  const text = typeof msg.content?.text === 'string' ? msg.content.text : null
  const parts = msg.content?.parts
  const raw = text ?? (Array.isArray(parts) ? parts.filter((part): part is string => typeof part === 'string').join('\n') : '')
  if (!raw.trim()) return null
  try {
    const value = JSON.parse(raw) as Record<string, unknown>
    if (typeof value.path === 'string' && value.args && typeof value.args === 'object') {
      const rawName = value.path.split('/').filter(Boolean).at(-1) ?? ''
      let name = rawName
      try {
        name = decodeURIComponent(rawName)
      } catch {}
      return signature(name, value.args)
    }
    if (typeof value.name === 'string') return signature(value.name, value.arguments ?? value.args ?? value.input ?? {})
  } catch {}
  return null
}

function findLatestLeaf(mapping: Record<string, MappingNode>): string | null {
  const hasChild = new Set<string>()
  for (const node of Object.values(mapping)) if (node.parent != null) hasChild.add(node.parent)
  let best: string | null = null
  let bestTime = -Infinity
  for (const [id, node] of Object.entries(mapping)) {
    if ((node.children ?? []).length > 0 || hasChild.has(id)) continue
    const time = node.message?.create_time
    const normalized = typeof time === 'number' ? time : 0
    if (normalized >= bestTime) {
      best = id
      bestTime = normalized
    }
  }
  return best
}

function orderedNodes(conv: ConversationDetail): MappingNode[] {
  const mapping = conv.mapping ?? {}
  let cursor = conv.current_node ?? findLatestLeaf(mapping)
  const chain: MappingNode[] = []
  const seen = new Set<string>()
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor)
    const node = mapping[cursor]
    if (!node) break
    chain.push(node)
    cursor = node.parent ?? null
  }
  return chain.reverse()
}

function applyOutput(msg: Message, call: ToolCall): void {
  if (hasPayload(msg) || !meaningful(call.toolOutput)) return
  msg.content = {
    content_type: 'code',
    language: 'json',
    response_format_name: null,
    text: typeof call.toolOutput === 'string' ? call.toolOutput : JSON.stringify(call.toolOutput, null, 2),
  }
  msg.metadata = {
    ...(msg.metadata ?? {}),
    inkstone_tool_name: call.connector ? `${call.connector}.${call.name}` : call.name,
    ...(call.toolResponseMetadata == null ? {} : { inkstone_tool_response_metadata: call.toolResponseMetadata }),
  }
}

export function hydrateToolMessages(conv: ConversationDetail): ConversationDetail {
  const id = String(conv.conversation_id ?? conv.id ?? '')
  if (!id) return conv
  const cache = loadCache(id)

  for (const node of Object.values(conv.mapping ?? {})) {
    const msg = node?.message
    if (msg?.author?.role !== 'tool') continue
    const cached = cache.messages[msg.id]?.message
    if (!cached || !hasPayload(cached) || hasPayload(msg)) continue
    msg.content = cached.content
    if (cached.metadata) msg.metadata = { ...(msg.metadata ?? {}), ...cached.metadata }
    const source = cached as unknown as Record<string, unknown>
    const target = msg as unknown as Record<string, unknown>
    for (const key of ['recipient', 'channel', 'status', 'end_turn']) {
      if (source[key] != null) target[key] = source[key]
    }
  }

  if (cache.groups.length === 0) return conv
  const mapping = conv.mapping ?? {}
  const pairs: Array<{ msg: Message; signature: string }> = []
  for (const node of orderedNodes(conv)) {
    const msg = node.message
    if (msg?.author?.role !== 'tool') continue
    const invocation = parseInvocation(node.parent ? mapping[node.parent]?.message : null)
    if (invocation) pairs.push({ msg, signature: invocation })
  }

  const proposals = new Map<Message, ToolCall[]>()
  for (const group of cache.groups) {
    const calls = group.calls ?? []
    if (calls.length === 0 || calls.length > pairs.length) continue
    const signatures = calls.map((call) => call.signature ?? signature(call.name, call.toolInput ?? {}))
    const candidates: number[] = []
    for (let i = 0; i <= pairs.length - signatures.length; i++) {
      if (!signatures.every((sig, j) => pairs[i + j]?.signature === sig)) continue
      candidates.push(i)
    }
    // A signature is not an identity: repeated calls may return different data.
    // Even a populated candidate must count, otherwise its result can be copied
    // into a later empty occurrence. Message-ID captures above remain safe.
    if (candidates.length !== 1) continue
    const start = candidates[0]!
    for (let j = 0; j < calls.length; j++) {
      const msg = pairs[start + j]!.msg
      const pending = proposals.get(msg) ?? []
      pending.push(calls[j]!)
      proposals.set(msg, pending)
    }
  }
  for (const [msg, calls] of proposals) {
    // Multiple captures for one unambiguous position can still disagree.
    if (new Set(calls.map((call) => canonical(call.toolOutput))).size !== 1) continue
    applyOutput(msg, calls[0]!)
  }
  return conv
}

if (typeof window !== 'undefined' && typeof location !== 'undefined') installToolCapture()
