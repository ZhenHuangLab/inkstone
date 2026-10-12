import type { AssetRef } from '../core/ir'
import { sanitizeName } from '../core/render'

const EXT_BY_MIME: Record<string, string> = {
  'image/avif': '.avif',
  'image/gif': '.gif',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/svg+xml': '.svg',
  'image/webp': '.webp',
}

/**
 * 下载落盘名必须服从实际响应 MIME。Claude 的图片 preview_url 会把上传的 PNG
 * 转码为 WebP；若继续沿用原文件名，Markdown 会得到扩展名与字节格式不一致的附件。
 */
export function assetFileName(
  asset: AssetRef,
  downloadName: string | null,
  contentType: string | null,
): string {
  const raw = sanitizeName(downloadName ?? asset.name ?? '')
  const matchedExt = /\.[A-Za-z0-9]{1,8}$/.exec(raw)?.[0] ?? ''
  const base = (matchedExt ? raw.slice(0, -matchedExt.length) : raw).slice(0, 60).trim()
  const mime = (contentType ?? '').split(';')[0]!.trim().toLowerCase()
  const mimeExt = EXT_BY_MIME[mime]

  // 已知图片 MIME 是实际下载字节的权威格式；未知 MIME 才保留来源文件名扩展。
  const ext = mimeExt ?? matchedExt
  return (base || (asset.kind === 'image' ? 'image' : 'file')) + ext
}

/**
 * 标准 Markdown 链接相对当前笔记；Obsidian Wikilink 的带目录路径则相对 vault 根。
 */
export function assetReferencePath(
  style: 'wikilink' | 'markdown',
  notesPrefix: string,
  relativePath: string,
): string {
  return style === 'wikilink' ? `${notesPrefix}${relativePath}` : relativePath
}
