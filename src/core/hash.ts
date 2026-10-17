/**
 * FNV-1a 32 位摘要，输出 8 位十六进制。用于没有服务端 id 的附件：
 * 标识要稳定（重导时落到同一文件名），而且只含文件名安全的字符。
 */
export function hashText(value: string): string {
  let hash = 0x811c9dc5
  for (const ch of value) {
    hash ^= ch.charCodeAt(0)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}
