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
    return {
      right: Math.round(viewport.width - rect.left + gap),
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
