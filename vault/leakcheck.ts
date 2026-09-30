// The vault's secret-leak check (spike S3's success criterion: "no password or token readable from the
// app's origin"), reusable by every e2e step. Run it on an app page (Playwright, Chromium):
//
//   const report = await findAppSecrets(page, [password]);
//   report.findings  -> [] when clean
//
// It looks where app-origin code could look:
// - the app main frame's JS heap: a CDP heap snapshot of the page's renderer. The vault iframe is
//   cross-site, so it is an out-of-process iframe with its own renderer and isolate: not in this snapshot.
//   (`vaultIsOutOfProcess` checks that premise.)
// - app-origin storage: localStorage, sessionStorage, every IndexedDB database (all records), OPFS (every
//   file), Cache Storage (every response), document.cookie.
//
// It searches for each given secret (raw and JSON-escaped) and for anything JWT-shaped ("eyJhbGciOi", the
// base64 of `{"alg":`, which every OpenF1 token starts with). Findings never contain a secret: only where,
// what, and at most 6 characters of a JWT-looking match.
//
// The needles are only ever in this (Node) process: nothing is passed into the app page, which would put
// them in the very heap being searched. So take the heap snapshot first, then dump storage (the dump code
// reads what is already there).

export const JWT_PREFIX = "eyJhbGciOi";

export type LeakFinding = { where: string; what: "secret" | "jwt"; sample?: string };
export type LeakReport = { findings: LeakFinding[]; scanned: Record<string, number> };

/** Per-file and total caps for OPFS / Cache Storage reads (the library can hold hundreds of MB). */
const FILE_CAP = 32 * 1024 * 1024;
const TOTAL_CAP = 256 * 1024 * 1024;

function search(where: string, haystack: string, needles: string[], out: LeakFinding[]) {
  for (const n of needles) if (n && haystack.includes(n)) out.push({ where, what: "secret" });
  const at = haystack.indexOf(JWT_PREFIX);
  if (at >= 0) out.push({ where, what: "jwt", sample: haystack.slice(at, at + 6) });
}

/** The raw secret and how it appears inside JSON (heap snapshots escape strings). */
const variants = (secrets: string[]) => [...new Set(secrets.flatMap((s) => (s ? [s, JSON.stringify(s).slice(1, -1)] : [])))];

/** A heap snapshot of a page's main-frame renderer (or of an out-of-process frame's), as one string. */
export async function heapSnapshot(target: any): Promise<string> {
  const page = typeof target.page === "function" ? target.page() : target;
  const cdp = await page.context().newCDPSession(target);
  const chunks: string[] = [];
  cdp.on("HeapProfiler.addHeapSnapshotChunk", (e: { chunk: string }) => chunks.push(e.chunk));
  await cdp.send("HeapProfiler.enable");
  await cdp.send("HeapProfiler.takeHeapSnapshot", { reportProgress: false, captureNumericValue: false });
  await cdp.send("HeapProfiler.disable");
  await cdp.detach();
  return chunks.join("");
}

/**
 * A heap snapshot of a dedicated worker of the page (the first whose URL contains `urlPart`), as one string, or
 * null if there's none. Playwright has no CDP session for workers, so this attaches to the worker's target
 * from the page's session and talks to it through Target.sendMessageToTarget.
 */
export async function workerHeapSnapshot(page: any, urlPart: string): Promise<string | null> {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { targetInfos } = await cdp.send("Target.getTargets");
    const target = targetInfos.find((t: { type: string; url: string }) => t.type === "worker" && t.url.includes(urlPart));
    if (!target) return null;
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: target.targetId, flatten: false });
    const chunks: string[] = [];
    const waiting = new Map<number, () => void>();
    let id = 0;
    cdp.on("Target.receivedMessageFromTarget", (e: { sessionId: string; message: string }) => {
      if (e.sessionId !== sessionId) return;
      const m = JSON.parse(e.message);
      if (m.method === "HeapProfiler.addHeapSnapshotChunk") chunks.push(m.params.chunk);
      else if (m.id) waiting.get(m.id)?.();
    });
    const send = (method: string, params: object = {}) =>
      new Promise<void>((resolve) => {
        const n = ++id;
        waiting.set(n, resolve);
        void cdp.send("Target.sendMessageToTarget", { sessionId, message: JSON.stringify({ id: n, method, params }) });
      });
    await send("HeapProfiler.enable");
    await send("HeapProfiler.takeHeapSnapshot", { reportProgress: false, captureNumericValue: false });
    await send("HeapProfiler.disable");
    await cdp.send("Target.detachFromTarget", { sessionId }).catch(() => {});
    return chunks.join("");
  } finally {
    await cdp.detach();
  }
}

/** Search a worker's heap (workerHeapSnapshot) for the secrets and JWTs; null if the worker isn't there. */
export async function findInWorker(page: any, urlPart: string, secrets: string[]): Promise<{ findings: LeakFinding[]; bytes: number } | null> {
  const heap = await workerHeapSnapshot(page, urlPart);
  if (heap === null) return null;
  const findings: LeakFinding[] = [];
  search("worker heap snapshot", heap, variants(secrets), findings);
  return { findings, bytes: heap.length };
}

/** Whether the page's vault iframe runs in its own process (a separate CDP "iframe" target). */
export async function vaultIsOutOfProcess(page: any, vaultOrigin: string): Promise<boolean> {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { targetInfos } = await cdp.send("Target.getTargets");
    return targetInfos.some((t: { type: string; url: string }) => t.type === "iframe" && t.url.startsWith(`${vaultOrigin}/frame.html`));
  } finally {
    await cdp.detach();
  }
}

/** Everything app-origin script can read from storage, as strings (runs in the app page). */
async function dumpStorage(caps: { file: number; total: number }): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  let total = 0;
  const bytes = (b: ArrayBuffer | ArrayBufferView) => {
    const u = b instanceof ArrayBuffer ? new Uint8Array(b) : new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    let s = "";
    for (let i = 0; i < u.length; i += 8192) s += String.fromCharCode(...u.subarray(i, i + 8192));
    // Both as bytes (latin1) and as UTF-8 text, so ASCII secrets match either way.
    return s + "\n" + new TextDecoder().decode(u);
  };
  const ser = (x: unknown): string => {
    const seen = new WeakSet();
    const walk = (v: unknown): unknown => {
      if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) return bytes(v as ArrayBuffer);
      if (typeof CryptoKey !== "undefined" && v instanceof CryptoKey) return `[CryptoKey ${v.algorithm.name} extractable=${v.extractable}]`;
      if (v && typeof v === "object") {
        if (seen.has(v)) return "[cycle]";
        seen.add(v);
        if (v instanceof Map) return [...v].map(([k, x]) => [walk(k), walk(x)]);
        if (v instanceof Set) return [...v].map(walk);
        if (Array.isArray(v)) return v.map(walk);
        return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
      }
      return v;
    };
    return JSON.stringify(walk(x)) ?? String(x);
  };
  const read = async (blob: Blob) => {
    if (total >= caps.total) return "[total cap]";
    const slice = blob.size > caps.file ? blob.slice(0, caps.file) : blob;
    total += slice.size;
    return bytes(await slice.arrayBuffer());
  };

  out.cookie = document.cookie;
  out.localStorage = ser(Object.fromEntries(Object.entries(localStorage)));
  out.sessionStorage = ser(Object.fromEntries(Object.entries(sessionStorage)));

  for (const info of await indexedDB.databases()) {
    if (!info.name) continue;
    const db = await new Promise<IDBDatabase>((res, rej) => {
      const r = indexedDB.open(info.name!);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    for (const name of db.objectStoreNames) {
      const rows = await new Promise<unknown[]>((res, rej) => {
        const tx = db.transaction(name, "readonly");
        const store = tx.objectStore(name);
        const vals = store.getAll();
        const keys = store.getAllKeys();
        tx.oncomplete = () => res([keys.result, vals.result]);
        tx.onerror = () => rej(tx.error);
      });
      out[`indexedDB ${info.name}/${name}`] = ser(rows);
    }
    db.close();
  }

  const walkDir = async (dir: FileSystemDirectoryHandle, path: string) => {
    for await (const [name, h] of (dir as any).entries() as AsyncIterable<[string, FileSystemHandle]>) {
      if (h.kind === "directory") await walkDir(h as FileSystemDirectoryHandle, `${path}${name}/`);
      else out[`OPFS ${path}${name}`] = await read(await (h as FileSystemFileHandle).getFile());
    }
  };
  try {
    await walkDir(await navigator.storage.getDirectory(), "/");
  } catch (e) {
    out["OPFS (error)"] = String(e);
  }

  for (const name of await caches.keys()) {
    const cache = await caches.open(name);
    for (const req of await cache.keys()) {
      const res = await cache.match(req);
      out[`CacheStorage ${name} ${req.url}`] = `${ser([...req.headers])}\n${res ? ser([...res.headers]) + "\n" + (await read(await res.blob())) : ""}`;
    }
  }
  return out;
}

/** Search one heap snapshot (e.g. the vault frame's, as a positive control that the search works). */
export async function findInHeap(target: any, secrets: string[]): Promise<LeakFinding[]> {
  const findings: LeakFinding[] = [];
  search("heap snapshot", await heapSnapshot(target), variants(secrets), findings);
  return findings;
}

/** Search the app page's heap and app-origin storage for the secrets and for JWTs. */
export async function findAppSecrets(page: any, secrets: string[]): Promise<LeakReport> {
  const needles = variants(secrets);
  const findings: LeakFinding[] = [];
  const scanned: Record<string, number> = {};

  const heap = await heapSnapshot(page);
  scanned["heap snapshot (app main frame)"] = heap.length;
  search("heap snapshot (app main frame)", heap, needles, findings);

  const dump: Record<string, string> = await page.mainFrame().evaluate(dumpStorage, { file: FILE_CAP, total: TOTAL_CAP });
  for (const [where, text] of Object.entries(dump)) {
    scanned[where] = text.length;
    search(where, text, needles, findings);
  }
  return { findings, scanned };
}
