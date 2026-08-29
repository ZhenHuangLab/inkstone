import { describe, expect, test } from 'bun:test'
import { claudeAdapter } from '../src/sites/claude'

describe('Claude 界面主题', () => {
  test('重点色固定为接近 Claude 图标的珊瑚橙', () => {
    expect(claudeAdapter.ui.accent(() => null)).toEqual({
      bg: [217, 119, 87],
      fg: null,
      ring: [217, 119, 87],
    })
  })
})
