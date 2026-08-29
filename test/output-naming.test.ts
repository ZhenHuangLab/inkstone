import { describe, expect, test } from 'bun:test'
import type { AssetRef } from '../src/core/ir'
import { assetFileName, assetReferencePath } from '../src/output/naming'

const image: AssetRef = {
  fileId: 'image-1',
  kind: 'image',
  name: 'capture.png',
}

describe('assetFileName', () => {
  test('实际响应为 WebP 时纠正来源 PNG 扩展名', () => {
    expect(assetFileName(image, null, 'image/webp')).toBe('capture.webp')
  })

  test('Content-Type 参数不影响 MIME 识别', () => {
    expect(assetFileName(image, null, 'image/jpeg; charset=binary')).toBe('capture.jpg')
  })

  test('未知 MIME 保留来源扩展名', () => {
    expect(assetFileName(image, null, 'application/octet-stream')).toBe('capture.png')
  })

  test('没有来源扩展时按已知 MIME 补齐', () => {
    expect(assetFileName({ ...image, name: undefined }, null, 'image/png')).toBe('image.png')
  })
})

describe('assetReferencePath', () => {
  test('Wikilink 使用 vault 根路径，包含笔记子目录', () => {
    expect(assetReferencePath('wikilink', 'conversations/', 'attachments/a.png')).toBe(
      'conversations/attachments/a.png',
    )
  })

  test('标准 Markdown 链接仍相对当前笔记', () => {
    expect(assetReferencePath('markdown', 'conversations/', 'attachments/a.png')).toBe(
      'attachments/a.png',
    )
  })
})
