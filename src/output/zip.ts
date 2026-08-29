import { zip, strToU8, type Zippable } from 'fflate'

export { strToU8 }

export type ZipEntries = Record<
  string,
  Uint8Array | [Uint8Array, { level: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 }]
>

/** 文本走压缩；图片等已压缩的二进制传 [bytes, {level: 0}] 免得白费 CPU。 */
export function makeZip(files: ZipEntries): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    zip(files as Zippable, { level: 6 }, (err, data) => (err ? reject(err) : resolve(data)))
  })
}

export function downloadBlob(filename: string, data: Uint8Array, mime = 'application/zip'): void {
  // SAFETY: Uint8Array 本就是合法 BlobPart；TS lib 把 BlobPart 窄化成 ArrayBuffer 支撑的视图，
  // 而 fflate 返回的是 Uint8Array<ArrayBufferLike>，只能靠断言跨过这道编译期鸿沟
  const blob = new Blob([data as unknown as BlobPart], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}
