import { describe, expect, test } from 'bun:test'
import {
  createChatGPTIRContextResolver,
  cssColorIsDark,
  resolveChatGPTAccent,
} from '../src/sites/chatgpt'

describe('ChatGPT IR 上下文', () => {
  test('一次导出内多个未知 gizmo_id 只补拉一次 project 列表', async () => {
    let requests = 0
    const loadProjects = async () => {
      requests++
      return []
    }
    const resolve = createChatGPTIRContextResolver('token', undefined, loadProjects)

    await resolve('a', { gizmo_id: 'g-custom-a' })
    await resolve('b', { gizmo_id: 'g-custom-b' })
    await resolve('c', { gizmo_id: 'g-custom-c' })

    expect(requests).toBe(1)
  })

  test('新一次导出会创建新的 project 补拉作用域', async () => {
    let requests = 0
    const loadProjects = async () => {
      requests++
      return []
    }

    await createChatGPTIRContextResolver('token', undefined, loadProjects)('a', {
      gizmo_id: 'g-custom-a',
    })
    await createChatGPTIRContextResolver('token', undefined, loadProjects)('b', {
      gizmo_id: 'g-custom-b',
    })

    expect(requests).toBe(2)
  })
})

describe('ChatGPT 界面主题', () => {
  test('按实际表面颜色识别暗色，并忽略透明背景', () => {
    expect(cssColorIsDark('rgb(33, 33, 33)')).toBe(true)
    expect(cssColorIsDark('rgb(255 255 255)')).toBe(false)
    expect(cssColorIsDark('rgba(0, 0, 0, 0)')).toBeNull()
  })

  test('旧主题变量仍优先于 Inkstone 回退色', () => {
    const variables: Record<string, string> = {
      '--purple-theme-submit-btn-bg': '#7c3aed',
      '--purple-theme-submit-btn-text': '#ffffff',
      '--purple-theme-entity-accent': '#8b5cf6',
    }
    const parse = (raw: string): [number, number, number] | null => {
      const value = raw.trim().replace('#', '')
      if (!/^[0-9a-f]{6}$/i.test(value)) return null
      return [0, 2, 4].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16)) as [
        number,
        number,
        number,
      ]
    }
    expect(resolveChatGPTAccent('purple', (name) => variables[name] ?? '', parse)).toEqual({
      bg: [124, 58, 237],
      fg: [255, 255, 255],
      ring: [139, 92, 246],
    })
  })

  test('新版页面没有旧变量时回退历史蓝色，不扫描出无关橙色', () => {
    expect(resolveChatGPTAccent(null, () => '', () => null)).toEqual({
      bg: [94, 106, 210],
      fg: [255, 255, 255],
      ring: [94, 106, 210],
    })
  })
})
