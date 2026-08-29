import { describe, expect, test } from 'bun:test'
import { computeFabPlacement } from '../src/ui-position'

describe('computeFabPlacement', () => {
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
})
