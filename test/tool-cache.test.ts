import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { conversationToMarkdown } from '../src/convert/markdown'
import { hydrateToolMessages, installToolCapture } from '../src/tool-cache'
import type { ConversationDetail, Message } from '../src/types'

const cacheKey = (id: string): string => `inkstone:tool-cache:v1:${id}`

const memory = new Map<string, string>()
const storage = {
  getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => {
    memory.set(key, value)
  },
}

describe('tool output cache', () => {
  const globals = ['localStorage', 'window', 'location', 'unsafeWindow']
  let descriptors: Array<PropertyDescriptor | undefined>
  beforeEach(() => {
    descriptors = globals.map((key) => Object.getOwnPropertyDescriptor(globalThis, key))
    memory.clear()
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, writable: true, value: storage })
    Reflect.deleteProperty(globalThis, 'unsafeWindow')
  })
  afterEach(() => {
    globals.forEach((key, i) => {
      const descriptor = descriptors[i]
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    })
  })

  test('hydrates an empty tool message from a captured message', () => {
    const conversationId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const cachedMessage: Message = {
      id: 'tool-1',
      author: { role: 'tool', name: 'web.run' },
      content: { content_type: 'code', language: 'json', text: '{"answer":42}' },
      metadata: { source: 'capture' },
    }
    localStorage.setItem(
      cacheKey(conversationId),
      JSON.stringify({
        messages: { 'tool-1': { capturedAt: 1, message: cachedMessage } },
        groups: [],
      }),
    )

    const conv = {
      conversation_id: conversationId,
      current_node: 'tool-node',
      mapping: {
        'tool-node': {
          id: 'tool-node',
          parent: null,
          children: [],
          message: {
            id: 'tool-1',
            author: { role: 'tool', name: 'web.run' },
            content: { content_type: 'code', language: 'json', text: '' },
            metadata: { is_visually_hidden_from_conversation: true },
          },
        },
      },
    } as unknown as ConversationDetail

    hydrateToolMessages(conv)
    expect(conv.mapping['tool-node']!.message!.content.text).toBe('{"answer":42}')
    expect(conv.mapping['tool-node']!.message!.metadata?.source).toBe('capture')
  })

  test('exports visually hidden tool results only when toolTraces is enabled', () => {
    const conv = {
      title: 'tool trace',
      conversation_id: 'ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee',
      current_node: 'a2',
      mapping: {
        a1: {
          id: 'a1',
          parent: null,
          children: ['t1'],
          message: {
            id: 'a1',
            author: { role: 'assistant' },
            recipient: 'web.run',
            content: { content_type: 'text', parts: ['{"search_query":[{"q":"inkstone"}]}'] },
          },
        },
        t1: {
          id: 't1',
          parent: 'a1',
          children: ['a2'],
          message: {
            id: 'tool-2',
            author: { role: 'tool', name: 'web.run' },
            content: {
              content_type: 'code',
              language: 'json',
              text: '{"results":[{"title":"Inkstone"}]}',
            },
            metadata: {
              is_visually_hidden_from_conversation: true,
              inkstone_tool_name: 'web.run',
            },
          },
        },
        a2: {
          id: 'a2',
          parent: 't1',
          children: [],
          message: {
            id: 'a2',
            author: { role: 'assistant' },
            content: { content_type: 'text', parts: ['done'] },
          },
        },
      },
    } as unknown as ConversationDetail

    const off = conversationToMarkdown(conv).markdown
    expect(off).not.toContain('工具返回')
    expect(off).not.toContain('"results"')

    const on = conversationToMarkdown(conv, '', { toolTraces: true }).markdown
    expect(on).toContain('工具返回 ← `web.run`')
    expect(on).toContain('"results"')
  })

  const idA = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
  const idB = 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee'
  const call = (output: string) => ({ name: 'lookup', toolInput: { q: 'same' }, toolOutput: output })
  const cacheGroups = (outputs: string[]) => {
    localStorage.setItem(cacheKey(idA), JSON.stringify({
      messages: {},
      groups: outputs.map((output, i) => ({ capturedAt: i, calls: [call(output)] })),
    }))
  }
  function conversation(outputs: string[]): ConversationDetail {
    const mapping: ConversationDetail['mapping'] = {}
    outputs.forEach((output, i) => {
      const assistantId = `a${i}`
      const toolId = `t${i}`
      mapping[assistantId] = {
        id: assistantId, parent: i === 0 ? null : `t${i - 1}`, children: [toolId],
        message: {
          id: assistantId, author: { role: 'assistant' },
          content: { content_type: 'text', parts: [JSON.stringify({ name: 'lookup', arguments: { q: 'same' } })] },
        },
      }
      mapping[toolId] = {
        id: toolId, parent: assistantId, children: i + 1 < outputs.length ? [`a${i + 1}`] : [],
        message: { id: toolId, author: { role: 'tool' }, content: { content_type: 'code', text: output } },
      }
    })
    return { conversation_id: idA, current_node: `t${outputs.length - 1}`, mapping } as ConversationDetail
  }

  test('skips repeated signatures even when the first result already exists', () => {
    cacheGroups(['A', 'B'])
    const conv = conversation(['A', ''])
    hydrateToolMessages(conv)
    expect(conv.mapping.t0!.message!.content.text).toBe('A')
    expect(conv.mapping.t1!.message!.content.text).toBe('')
  })

  test('message IDs still hydrate repeated signatures safely', () => {
    cacheGroups(['A', 'B'])
    const cached = JSON.parse(localStorage.getItem(cacheKey(idA))!)
    cached.messages.t1 = { capturedAt: 1, message: { id: 't1', author: { role: 'tool' }, content: { content_type: 'code', text: 'B' } } }
    localStorage.setItem(cacheKey(idA), JSON.stringify(cached))
    const conv = conversation(['A', ''])
    hydrateToolMessages(conv)
    expect(conv.mapping.t1!.message!.content.text).toBe('B')
  })

  test('hydrates a unique signature, but skips conflicting captures', () => {
    cacheGroups(['A'])
    expect(hydrateToolMessages(conversation([''])).mapping.t0!.message!.content.text).toBe('A')
    cacheGroups(['A', 'B'])
    expect(hydrateToolMessages(conversation([''])).mapping.t0!.message!.content.text).toBe('')
  })

  function pageAt(pathname: string, page: object) {
    const location = { origin: 'https://chatgpt.com', host: 'chatgpt.com', pathname }
    Object.defineProperty(globalThis, 'location', { configurable: true, writable: true, value: location })
    Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: page })
    installToolCapture()
    return location
  }
  function groups(id: string) {
    return JSON.parse(memory.get(cacheKey(id)) ?? '{"groups":[]}').groups
  }

  test('a delayed fetch from A is cached in A after navigating to B', async () => {
    let resolve!: (response: Response) => void
    const page = { fetch: (_url: string) => new Promise<Response>((done) => { resolve = done }) }
    const location = pageAt(`/c/${idA}`, page)
    const pending = page.fetch('/backend-api/conversation')
    location.pathname = `/c/${idB}`
    const response = new Response(JSON.stringify({ toolCalls: [call('from A')] }), { headers: { 'content-type': 'application/json' } })
    resolve(response)
    expect(await pending).toBe(response)
    await Bun.sleep(0)
    expect(groups(idA)[0].calls[0].toolOutput).toBe('from A')
    expect(groups(idB)).toEqual([])
  })

  test('response identity takes precedence over the request snapshot', async () => {
    const page = { fetch: async (_url: string) => new Response(JSON.stringify({ conversation_id: idB, toolCalls: [call('explicit B')] })) }
    pageAt(`/c/${idA}`, page)
    await page.fetch('/backend-api/conversation')
    await Bun.sleep(0)
    expect(groups(idA)).toEqual([])
    expect(groups(idB)[0].calls[0].toolOutput).toBe('explicit B')
  })

  test('explicit conversation URLs take precedence over the open page', async () => {
    const page = { fetch: async (_url: string) => new Response(JSON.stringify({ toolCalls: [call('URL A')] })) }
    pageAt(`/c/${idB}`, page)
    await page.fetch(`/backend-api/conversation/${idA}`)
    await Bun.sleep(0)
    expect(groups(idA)[0].calls[0].toolOutput).toBe('URL A')
    expect(groups(idB)).toEqual([])
  })

  test('a request with no conversation identity is not assigned after navigation', async () => {
    let resolve!: (response: Response) => void
    const page = { fetch: (_url: string) => new Promise<Response>((done) => { resolve = done }) }
    const location = pageAt('/', page)
    const pending = page.fetch('/backend-api/conversation')
    location.pathname = `/c/${idB}`
    resolve(new Response(JSON.stringify({ toolCalls: [call('unassigned')] })))
    await pending
    await Bun.sleep(0)
    expect(memory.size).toBe(0)
  })

  test('XHR, EventSource and WebSocket retain their initiating conversation', async () => {
    class XHR extends EventTarget {
      responseType = ''
      responseText = ''
      response: unknown
      open(_method: string, _url: string) {}
      send() {}
      getResponseHeader() { return 'application/json' }
    }
    class Stream extends EventTarget {
      constructor(_url: string) { super() }
    }
    const page = { XMLHttpRequest: XHR, EventSource: Stream, WebSocket: Stream }
    const location = pageAt(`/c/${idA}`, page)
    const xhr = new page.XMLHttpRequest()
    xhr.open('GET', '/backend-api/conversation')
    xhr.send()
    const events = new page.EventSource('/events')
    const socket = new page.WebSocket('wss://chatgpt.com/socket')
    location.pathname = `/c/${idB}`
    xhr.responseText = JSON.stringify({ toolCalls: [call('XHR A')] })
    xhr.dispatchEvent(new Event('loadend'))
    events.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ toolCalls: [call('SSE A')] }) }))
    socket.dispatchEvent(new MessageEvent('message', { data: new Blob([JSON.stringify({ toolCalls: [call('WS A')] })]) }))
    let resolveBlob!: (text: string) => void
    location.pathname = `/c/${idA}`
    xhr.open('GET', '/backend-api/conversation')
    xhr.responseType = 'blob'
    xhr.response = { text: () => new Promise<string>((done) => { resolveBlob = done }) }
    xhr.send()
    xhr.dispatchEvent(new Event('loadend'))
    // Reuse the same XHR on B while the previous Blob is still being read.
    location.pathname = `/c/${idB}`
    xhr.open('GET', '/backend-api/conversation')
    xhr.send()
    resolveBlob(JSON.stringify({ toolCalls: [call('Blob A')] }))
    await Bun.sleep(0)
    expect(groups(idA).map((group: { calls: Array<{ toolOutput: string }> }) => group.calls[0]!.toolOutput)).toEqual(['XHR A', 'SSE A', 'WS A', 'Blob A'])
    expect(groups(idB)).toEqual([])
  })
})
