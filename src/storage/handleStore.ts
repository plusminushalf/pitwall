// SessionStore on a directory handle: the origin-private file system (OPFS) by default, or any folder
// handle from the File System Access API (same API). Works in the page and in workers.
//
// Layout (every JSON file of race data is stored gzipped):
//   sessions/<key>/entry.json                 LibraryEntry, written last (its presence = complete)
//   sessions/<key>/meta.json.gz, drivers/<n>.json.gz, laps/<n>.json.gz    processed (src/types.ts)
//   raw/<key>/<name>.json.gz                  raw OpenF1 responses, as in the CLI's data/raw/<key>/
//   docs/<name>.json                          small documents (catalogue cache)

import type { DriverLapTraces, DriverTelemetry, SessionMeta } from "../types";
import type { Bytes, LibraryEntry, SessionStore, StorageUsage, StoreBackend } from "./sessionStore";

const pipe = (data: Blob | Bytes, t: CompressionStream | DecompressionStream) =>
  new Response((data instanceof Blob ? data : new Blob([data])).stream().pipeThrough(t));

export const gzipBytes = async (b: Bytes): Promise<Bytes> => new Uint8Array(await pipe(b, new CompressionStream("gzip")).arrayBuffer());
export const gunzipBytes = async (b: Blob | Bytes): Promise<Bytes> =>
  new Uint8Array(await pipe(b, new DecompressionStream("gzip")).arrayBuffer());

const enc = new TextEncoder();

const missing = (e: unknown) => {
  const name = (e as { name?: string }).name;
  return name === "NotFoundError" || name === "TypeMismatchError";
};

// createWritable swaps the file in on close() (atomic). Safari before 26 only has sync access handles, in workers.
const hasWritable = typeof FileSystemFileHandle !== "undefined" && "createWritable" in FileSystemFileHandle.prototype;
const hasMove = typeof FileSystemHandle !== "undefined" && "move" in FileSystemHandle.prototype;

interface SyncHandle {
  truncate(n: number): void;
  write(b: Bytes, o: { at: number }): number;
  flush(): void;
  close(): void;
}

async function syncWrite(fh: FileSystemFileHandle, bytes: Bytes) {
  const h = await (fh as unknown as { createSyncAccessHandle(): Promise<SyncHandle> }).createSyncAccessHandle();
  try {
    h.truncate(0);
    h.write(bytes, { at: 0 });
    h.flush();
  } finally {
    h.close();
  }
}

export function handleStore(backend: StoreBackend, root: () => Promise<FileSystemDirectoryHandle>): SessionStore {
  let rootHandle: Promise<FileSystemDirectoryHandle> | null = null;
  const getRoot = () => (rootHandle ??= root());

  /** The directory at `parts`, or undefined if it doesn't exist (and `create` is off). */
  async function dir(parts: string[], create = false): Promise<FileSystemDirectoryHandle | undefined> {
    let d = await getRoot();
    try {
      for (const p of parts) d = await d.getDirectoryHandle(p, { create });
      return d;
    } catch (e) {
      if (missing(e)) return undefined;
      throw e;
    }
  }

  async function readFile(parts: string[]): Promise<File | undefined> {
    const d = await dir(parts.slice(0, -1));
    if (!d) return undefined;
    try {
      return await (await d.getFileHandle(parts.at(-1)!)).getFile();
    } catch (e) {
      if (missing(e)) return undefined;
      throw e;
    }
  }

  async function writeFile(parts: string[], bytes: Bytes): Promise<void> {
    const d = (await dir(parts.slice(0, -1), true))!;
    const name = parts.at(-1)!;
    if (hasWritable) {
      const w = await (await d.getFileHandle(name, { create: true })).createWritable();
      await w.write(bytes);
      await w.close();
      return;
    }
    if (hasMove) {
      const tmp = await d.getFileHandle(`${name}.tmp`, { create: true });
      await syncWrite(tmp, bytes);
      await (tmp as unknown as { move(name: string): Promise<void> }).move(name);
      return;
    }
    await syncWrite(await d.getFileHandle(name, { create: true }), bytes);
  }

  async function remove(parts: string[]): Promise<void> {
    const d = await dir(parts.slice(0, -1));
    if (!d) return;
    try {
      await d.removeEntry(parts.at(-1)!, { recursive: true });
    } catch (e) {
      if (!missing(e)) throw e;
    }
  }

  async function* children(parts: string[]): AsyncGenerator<FileSystemHandle> {
    const d = await dir(parts);
    if (d) yield* d.values();
  }

  async function gzJson<T>(parts: string[], what: string): Promise<T> {
    const file = await readFile(parts);
    if (!file) throw new Error(`${what} isn't in this browser's storage`);
    return (await pipe(file, new DecompressionStream("gzip")).json()) as T;
  }

  async function plainJson<T>(parts: string[]): Promise<T | undefined> {
    const file = await readFile(parts);
    if (!file) return undefined;
    try {
      return JSON.parse(await file.text()) as T;
    } catch {
      return undefined; // unreadable: treated as absent
    }
  }

  const sessionKeys = async (area: "sessions" | "raw") => {
    const keys: number[] = [];
    for await (const h of children([area])) if (h.kind === "directory" && /^\d+$/.test(h.name)) keys.push(Number(h.name));
    return keys;
  };

  const entry = (key: number) => plainJson<LibraryEntry>(["sessions", String(key), "entry.json"]);

  return {
    backend,

    async list() {
      const entries = await Promise.all((await sessionKeys("sessions")).map(entry));
      return entries.filter((e): e is LibraryEntry => e != null).sort((a, b) => a.dateStart.localeCompare(b.dateStart));
    },
    entry,
    has: async (key) => (await entry(key)) != null,
    readMeta: (key) => gzJson<SessionMeta>(["sessions", String(key), "meta.json.gz"], `Session ${key}`),
    readDriver: (key, n) => gzJson<DriverTelemetry>(["sessions", String(key), "drivers", `${n}.json.gz`], `Telemetry of #${n}`),
    readLaps: (key, n) => gzJson<DriverLapTraces>(["sessions", String(key), "laps", `${n}.json.gz`], `Lap traces of #${n}`),

    async delete(key) {
      // The entry goes first: a half-deleted session is never listed as complete.
      await remove(["sessions", String(key), "entry.json"]);
      await remove(["sessions", String(key)]);
      await remove(["raw", String(key)]);
    },

    async usage(): Promise<StorageUsage> {
      const storage = typeof navigator !== "undefined" ? navigator.storage : undefined;
      const [estimate, persisted] = await Promise.all([
        storage?.estimate?.().catch(() => undefined),
        storage?.persisted?.().catch(() => undefined),
      ]);
      return { usage: estimate?.usage ?? null, quota: estimate?.quota ?? null, persisted: persisted ?? null };
    },

    rawSessions: () => sessionKeys("raw"),
    async rawFiles(key) {
      const out = new Map<string, number>();
      for await (const h of children(["raw", String(key)])) {
        const m = /^(.+)\.json\.gz$/.exec(h.name);
        if (h.kind === "file" && m) out.set(m[1], (await (h as FileSystemFileHandle).getFile()).size);
      }
      return out;
    },
    async readRaw(key, name) {
      const f = await readFile(["raw", String(key), `${name}.json.gz`]);
      return f ? new Uint8Array(await f.arrayBuffer()) : undefined;
    },
    writeRaw: (key, name, gz) => writeFile(["raw", String(key), `${name}.json.gz`], gz),

    clearProcessed: (key) => remove(["sessions", String(key)]),
    async writeProcessed(key, file, json) {
      const gz = await gzipBytes(enc.encode(json));
      await writeFile(["sessions", String(key), ...`${file}.gz`.split("/")], gz);
      return gz.length;
    },
    commit: (e) => writeFile(["sessions", String(e.sessionKey), "entry.json"], enc.encode(JSON.stringify(e))),

    readDoc: <T>(name: string) => plainJson<T>(["docs", `${name}.json`]),
    writeDoc: (name, value) => writeFile(["docs", `${name}.json`], enc.encode(JSON.stringify(value))),
  };
}
