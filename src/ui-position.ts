export interface AnchorRect {
  top: number
  right: number
  bottom: number
  left: number
  height: number
}

export interface FabPlacement {
  right: number
  bottom: number
  panelTop?: number
  panelLeft?: number
}

export type HeaderPlacement = 'beside' | 'inset' | 'below'

/**
 * 把页面锚点换算成 fixed FAB 的 right / bottom。
 *
 * Claude 的 sticky composer 实测会因缩放和子像素布局略微越过 viewport 底边；
 * 这里按可见区域裁剪，而不是把整个定位判作失败。
 */
export function computeFabPlacement(
  mode: 'composer' | 'header',
  rect: AnchorRect,
  viewport: { width: number; height: number },
  size: number,
  gap: number,
  headerPlacement: HeaderPlacement = 'beside',
): FabPlacement | null {
  if (
    !Number.isFinite(rect.top) ||
    !Number.isFinite(rect.right) ||
    !Number.isFinite(rect.bottom) ||
    !Number.isFinite(rect.left) ||
    !Number.isFinite(rect.height) ||
    rect.height <= 0 ||
    viewport.width <= 0 ||
    viewport.height <= 0
  ) {
    return null
  }

  const visibleTop = Math.max(0, rect.top)
  const visibleBottom = Math.min(viewport.height, rect.bottom)
  if (visibleBottom <= visibleTop) return null
  const visibleHeight = visibleBottom - visibleTop

  if (mode === 'header') {
    if (rect.top < 0) return null
    // 密集顶栏没有按钮宽度和边距时，放在控件下方；只钳制 x 会盖住最左控件。
    if (headerPlacement === 'below' || (headerPlacement === 'beside' && rect.left - gap - size < 8)) {
      return {
        right: 8,
        bottom: Math.round(viewport.height - rect.bottom - gap - size),
        panelTop: Math.round(rect.bottom + gap + size + 10),
      }
    }
    // 新会话的某些 ChatGPT 变体没有 Share/Profile 等右侧动作，adapter 会把
    // 完整顶栏作为兜底锚点并明确指定 inset；宽动作组仍贴左侧，不按宽度猜测。
    const right =
      headerPlacement === 'inset'
        ? Math.max(8, Math.round(viewport.width - rect.right + 8))
        : Math.round(viewport.width - rect.left + gap)
    return {
      right,
      bottom: Math.round(viewport.height - rect.bottom + (rect.height - size) / 2),
      panelTop: Math.round(rect.bottom + 10),
    }
  }

  const beside = Math.round(viewport.width - rect.right - gap - size)
  if (beside >= 8) {
    const right = beside
    return {
      right,
      bottom: Math.round(Math.max(8, viewport.height - visibleBottom + (visibleHeight - size) / 2)),
      panelLeft: composerPanelLeft(viewport.width, right, size),
    }
  }
  const right = 20
  return {
    right,
    bottom: Math.round(Math.min(viewport.height - 60, viewport.height - visibleTop + gap)),
    panelLeft: composerPanelLeft(viewport.width, right, size),
  }
}

/** 面板从按钮向右展开；仅在不足 192px 可用宽度时才向左平移。 */
function composerPanelLeft(viewportWidth: number, fabRight: number, fabSize: number): number {
  const fabLeft = viewportWidth - fabRight - fabSize
  return Math.round(Math.max(16, Math.min(fabLeft, viewportWidth - 192 - 16)))
}
