import { mapTextSegmentsOutsideCode } from './codeaware'

// ChatGPT 用私有区 Unicode（U+E200 区段）包裹引用标记，例如 <U+E200>cite<U+E202>turn0search1<U+E201>
const PUA_MARKER_RUN = /\uE200[\s\S]*?\uE201/g
const PUA_ANY = /[\uE000-\uF8FF]/g
const LEGACY_CITATION = /【[^【】\n]*†[^【】\n]*】/g // 【12†source】

/**
 * P1 底线：绝不把乱码留进导出结果。
 * 剥离正文里的私有区引用标记和旧版 【12†source】。
 * P2 将改为用 metadata.content_references 还原成 [title](url) 链接 + 文末 Sources。
 */
export function stripCitationMarkers(text: string): string {
  return mapTextSegmentsOutsideCode(text, seg =>
    seg.replace(PUA_MARKER_RUN, '').replace(PUA_ANY, '').replace(LEGACY_CITATION, ''),
  )
}
