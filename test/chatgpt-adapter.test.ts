import { describe, expect, test } from 'bun:test'
import { createChatGPTIRContextResolver } from '../src/sites/chatgpt'

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
