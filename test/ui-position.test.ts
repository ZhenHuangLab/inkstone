import { describe, expect, test } from 'bun:test'
import { computeFabPlacement } from '../src/ui-position'

describe('computeFabPlacement', () => {
  test('密集顶栏的左侧锚点没有空间时，按钮移到下方而不是越界或盖住原生控件', () => {
    const placement = computeFabPlacement(
      'header',
      { top: 10, right: 44, bottom: 46, left: 8, height: 36 },
      { width: 360, height: 740 },
      36,
      8,
    )
    expect(placement).toEqual({ right: 8, bottom: 650, panelTop: 100 })
  })

  test('Claude composer 贴在输入框表面右侧并垂直居中，面板尽量向右展开', () => {
    expect(
      computeFabPlacement(
        'composer',
        { top: 893, right: 1274, bottom: 945, left: 506, height: 52 },
        { width: 1494, height: 983 },
        44,
        12,
      ),
    ).toEqual({ right: 164, bottom: 42, panelLeft: 1286 })
  })

  test('composer 子像素越过 viewport 底边时按可见部分定位', () => {
    expect(
      computeFabPlacement(
        'composer',
        { top: 893.2, right: 1274, bottom: 983.4, left: 506, height: 90.2 },
        { width: 1494, height: 983 },
        44,
        12,
      ),
    ).toEqual({ right: 164, bottom: 23, panelLeft: 1286 })
  })

  test('Claude header 贴在 Files + Share 动作组左侧', () => {
    expect(
      computeFabPlacement(
        'header',
        { top: 10, right: 1482, bottom: 38, left: 1392, height: 28 },
        { width: 1494, height: 983 },
        28,
        8,
      ),
    ).toEqual({ right: 110, bottom: 945, panelTop: 48 })
  })

  test('Claude 首页 header 贴在隐身模式动作槽左侧', () => {
    // /new 实测：#dframe-header-actions-slot = x 578–610、y 8–40，viewport 630×898。
    expect(
      computeFabPlacement(
        'header',
        { top: 8, right: 610, bottom: 40, left: 578, height: 32 },
        { width: 630, height: 898 },
        28,
        8,
      ),
    ).toEqual({ right: 60, bottom: 860, panelTop: 50 })
  })

  test('ChatGPT 新会话工作模式没有右侧动作时贴顶栏右内边距', () => {
    expect(
      computeFabPlacement(
        'header',
        { top: 0, right: 630, bottom: 52, left: 0, height: 52 },
        { width: 630, height: 898 },
        36,
        8,
        'inset',
      ),
    ).toEqual({ right: 8, bottom: 854, panelTop: 62 })
  })

  test('360px 窗口中超过一半宽度的动作组仍贴左侧，按钮不重叠', () => {
    const placement = computeFabPlacement(
      'header',
      { top: 10, right: 360, bottom: 46, left: 160, height: 36 },
      { width: 360, height: 740 },
      36,
      8,
    )
    expect(placement).toEqual({ right: 208, bottom: 694, panelTop: 56 })
    expect(360 - placement!.right).toBeLessThanOrEqual(160 - 8)
  })

  test('360px 窗口的完整顶栏兜底仍使用右内边距', () => {
    expect(computeFabPlacement(
      'header',
      { top: 0, right: 360, bottom: 52, left: 0, height: 52 },
      { width: 360, height: 740 },
      36,
      8,
      'inset',
    )).toEqual({ right: 8, bottom: 696, panelTop: 62 })
  })

  test('ChatGPT 四种探针结构的 header 锚点均避开原生控件', () => {
    const viewport = { width: 630, height: 898 }
    const cases = [
      {
        rect: { top: 8, right: 536, bottom: 44, left: 462.7, height: 36 },
        expected: { right: 175, bottom: 854, panelTop: 54 },
      }, // 会话打开 · 工作：Share
      {
        rect: { top: 8, right: 578, bottom: 44, left: 504.7, height: 36 },
        expected: { right: 133, bottom: 854, panelTop: 54 },
      }, // 会话打开 · 聊天：Share
      {
        rect: { top: 0, right: 630, bottom: 52, left: 0, height: 52 },
        expected: { right: 8, bottom: 854, panelTop: 62 },
        headerPlacement: 'inset' as const,
      }, // 新会话页 · 工作：完整顶栏兜底
      {
        rect: { top: 8, right: 622, bottom: 44, left: 586, height: 36 },
        expected: { right: 52, bottom: 854, panelTop: 54 },
      }, // 新会话页 · 聊天：右侧动作
    ]
    for (const { rect, expected, headerPlacement } of cases) {
      expect(computeFabPlacement('header', rect, viewport, 36, 8, headerPlacement)).toEqual(expected)
    }
  })

  test('ChatGPT 四种探针结构的 composer 都落在输入区上方且不越界', () => {
    const viewport = { width: 630, height: 898 }
    const cases = [
      { top: 740, right: 614, bottom: 797, left: 16, height: 57 }, // 会话打开 · 工作
      { top: 755, right: 614, bottom: 842, left: 16, height: 87 }, // 会话打开 · 聊天
      { top: 732, right: 604, bottom: 789, left: 16, height: 57 }, // 新会话页 · 工作
      { top: 787, right: 604, bottom: 874, left: 16, height: 87 }, // 新会话页 · 聊天
    ]
    for (const rect of cases) {
      const placement = computeFabPlacement('composer', rect, viewport, 44, 12)
      expect(placement).not.toBeNull()
      const fabTop = viewport.height - placement!.bottom - 44
      const fabRight = viewport.width - placement!.right
      expect(fabTop).toBeGreaterThanOrEqual(8)
      expect(fabTop + 44).toBeLessThanOrEqual(rect.top - 12)
      expect(fabRight).toBeLessThanOrEqual(viewport.width - 8)
    }
  })
})
