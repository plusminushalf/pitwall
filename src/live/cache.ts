// The live worker's cache (LiveDeps.cache): the session followed, in IndexedDB, so a page load mid-session shows it at
// once and fetches only what came since instead of backfilling the whole session again. One session at a time; the
// worker clears it when the session ends.

import type { CachedSession, LiveCache } from "./openf1"

const DB = "pitwall-live"
const STORE = "session"
/** (A new version when CachedSession's shape changes: an old one is never read.) */
const KEY = "followed-v1"

let db: Promise<IDBDatabase> | null = null

function open(): Promise<IDBDatabase> {
    db ??= new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(DB, 1)
        req.onupgradeneeded = () => req.result.createObjectStore(STORE)
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
        req.onblocked = () => reject(new Error("the live cache is blocked"))
    }).catch((e) => {
        db = null
        throw e
    })
    return db
}

async function run<T>(
    mode: IDBTransactionMode,
    op: (s: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
    const tx = (await open()).transaction(STORE, mode)
    const req = op(tx.objectStore(STORE))
    return new Promise<T>((resolve, reject) => {
        tx.oncomplete = () => resolve(req.result)
        tx.onerror = tx.onabort = () =>
            reject(tx.error ?? new Error("live cache transaction failed"))
    })
}

export const liveCache: LiveCache = {
    async load(sessionKey) {
        const saved = await run<CachedSession | undefined>("readonly", (s) =>
            s.get(KEY)
        )
        return saved?.store.session.session_key === sessionKey ? saved : null
    },
    async save(session) {
        await run("readwrite", (s) => s.put(session, KEY))
    },
    async clear() {
        await run("readwrite", (s) => s.delete(KEY))
    }
}
