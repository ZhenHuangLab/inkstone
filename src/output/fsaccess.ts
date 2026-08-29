// File System Access 直写 Obsidian vault（v2 输出形态，仅 Chromium 系）。
// 目录句柄存 IndexedDB 跨会话复用；权限随时可能被收回，每次导出前 query/request。

// showDirectoryPicker 与句柄权限 API 还不在 lib.dom 里，自己补最小声明
declare global {
  interface Window {
    showDirectoryPicker?(options?: { id?: string; mode?: 'read' | 'readwrite' }): Promise<FileSystemDirectoryHandle>
  }
  interface FileSystemHandle {
    queryPermission?(desc: { mode: 'read' | 'readwrite' }): Promise<PermissionState>
    requestPermission?(desc: { mode: 'read' | 'readwrite' }): Promise<PermissionState>
  }
}

export function supportsDirectoryPicker(): boolean {
  return typeof window.showDirectoryPicker === 'function'
}

const DB_NAME = 'inkstone'
const STORE = 'kv'
const KEY = 'vaultDir'

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error as Error)
  })
}

async function idbRun<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb()
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = fn(db.transaction(STORE, mode).objectStore(STORE))
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error as Error)
    })
  } finally {
    db.close()
  }
}

/** 清掉记住的目录，下次导出重新弹选择器。 */
export async function forgetVaultDir(): Promise<void> {
  try {
    await idbRun('readwrite', (s) => s.delete(KEY))
  } catch {
    /* 清不掉也无碍，句柄权限迟早过期 */
  }
}

/**
 * 取写入目录：优先复用记住的句柄（权限静默续期或在用户手势里申请），
 * 没有/被拒则弹目录选择器。用户取消返回 null。
 * 必须在用户手势（点击）链路里尽早调用，权限申请和选择器都吃 transient activation。
 */
export async function acquireVaultDir(): Promise<FileSystemDirectoryHandle | null> {
  if (!supportsDirectoryPicker()) return null

  try {
    const saved = await idbRun<FileSystemDirectoryHandle | undefined>('readonly', (s) => s.get(KEY))
    if (saved && (await ensurePermission(saved))) return saved
  } catch {
    /* IDB 不可用或句柄失效：走选择器 */
  }

  try {
    const handle = await window.showDirectoryPicker!({ id: 'inkstone-vault', mode: 'readwrite' })
    try {
      await idbRun('readwrite', (s) => s.put(handle, KEY))
    } catch {
      /* 记不住就每次都选，功能不受影响 */
    }
    return handle
  } catch (e) {
    // 用户取消（AbortError）或安全策略拒绝
    if (e instanceof DOMException && e.name === 'AbortError') return null
    throw e
  }
}

async function ensurePermission(handle: FileSystemDirectoryHandle): Promise<boolean> {
  if (typeof handle.queryPermission !== 'function') return false
  if ((await handle.queryPermission({ mode: 'readwrite' })) === 'granted') return true
  return typeof handle.requestPermission === 'function'
    ? (await handle.requestPermission({ mode: 'readwrite' })) === 'granted'
    : false
}

/** 写入 root 下的相对路径（如 `<笔记目录>/x.md`），中间目录自动创建。 */
export async function writeVaultFile(
  root: FileSystemDirectoryHandle,
  relPath: string,
  data: Uint8Array,
): Promise<void> {
  const parts = relPath.split('/').filter((p) => p !== '' && p !== '.' && p !== '..')
  if (parts.length === 0) throw new Error(`非法写入路径：${relPath}`)
  let dir = root
  for (const part of parts.slice(0, -1)) {
    dir = await dir.getDirectoryHandle(part, { create: true })
  }
  const file = await dir.getFileHandle(parts[parts.length - 1]!, { create: true })
  const w = await file.createWritable()
  try {
    // SAFETY: 同 zip.ts 里的 BlobPart 断言——Uint8Array 运行时就是 BufferSource，
    // 只是 TS lib 把它窄化成了 ArrayBuffer 支撑的视图
    await w.write(data as unknown as BufferSource)
    await w.close() // close 才落盘
  } catch (e) {
    await w.abort().catch(() => {})
    throw e
  }
}
