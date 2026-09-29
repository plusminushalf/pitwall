// Spike S1 ingest worker: the real ingest pipeline (scripts/lib/ingestCore.ts + normalize + quali) with a
// browser I/O adapter. Network through the shared OpenF1 client (free tier: no credentials here), raw cache
// and processed output in OPFS, gzip through CompressionStream / DecompressionStream.

import { runIngest, type IngestIO, type IngestTimings } from "../../scripts/lib/ingestCore";
import { fetchCircuit, fetchEndpoint, setRequestObserver } from "../../scripts/lib/openf1Http";
import type { RawSession } from "../../scripts/lib/openf1Types";
import { gunzipBytes, gzipBytes, opfsFile, opfsParent, type Bytes } from "../../src/data/opfs";
import type { FromWorker, Mode, RunResult, ToWorker } from "./protocol";

const scope = self as unknown as { postMessage(m: FromWorker): void; onmessage: ((e: MessageEvent<ToWorker>) => void) | null };
const post = (m: FromWorker) => scope.postMessage(m);
const enc = new TextEncoder();
const dec = new TextDecoder();

// ---------------------------------------------------------------- OPFS writes

// createWritable swaps the file in on close() (atomic). Safari before 26 only has sync access handles in workers.
const hasWritable = "createWritable" in FileSystemFileHandle.prototype;
const hasMove = "move" in FileSystemHandle.prototype;
const writeApi = hasWritable ? "createWritable" : hasMove ? "syncAccessHandle+move" : "syncAccessHandle (not atomic)";

async function dirOf(path: string, create: boolean) {
  return (await opfsParent(path, create)) as unknown as [FileSystemDirectoryHandle, string];
}

interface SyncHandle {
  truncate(n: number): void;
  write(b: Bytes, o: { at: number }): number;
  flush(): void;
  close(): void;
}
async function syncWrite(fh: FileSystemFileHandle, bytes: Bytes) {
  const h = (await (fh as unknown as { createSyncAccessHandle(): Promise<SyncHandle> }).createSyncAccessHandle()) as SyncHandle;
  try {
    h.truncate(0);
    h.write(bytes, { at: 0 });
    h.flush();
  } finally {
    h.close();
  }
}

async function writeFileAtomic(path: string, bytes: Bytes): Promise<void> {
  const [dir, name] = await dirOf(path, true);
  if (hasWritable) {
    const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
    await w.write(bytes);
    await w.close();
    return;
  }
  if (hasMove) {
    const tmp = await dir.getFileHandle(`${name}.tmp`, { create: true });
    await syncWrite(tmp, bytes);
    await (tmp as unknown as { move(name: string): Promise<void> }).move(name);
    return;
  }
  await syncWrite(await dir.getFileHandle(name, { create: true }), bytes);
}

async function readFile(path: string): Promise<Bytes | undefined> {
  const f = await opfsFile(path);
  return f ? new Uint8Array(await f.arrayBuffer()) : undefined;
}

async function* walk(dir: FileSystemDirectoryHandle, prefix = ""): AsyncGenerator<[string, FileSystemFileHandle]> {
  for await (const h of (dir as unknown as { values(): AsyncIterable<FileSystemHandle> }).values()) {
    if (h.kind === "directory") yield* walk(h as FileSystemDirectoryHandle, `${prefix}${h.name}/`);
    else yield [`${prefix}${h.name}`, h as FileSystemFileHandle];
  }
}

async function dirIfExists(path: string): Promise<FileSystemDirectoryHandle | null> {
  let dir = await navigator.storage.getDirectory();
  for (const p of path.split("/")) {
    try {
      dir = await dir.getDirectoryHandle(p);
    } catch {
      return null;
    }
  }
  return dir;
}

async function sizeOf(path: string): Promise<[number, number]> {
  const dir = await dirIfExists(path);
  let bytes = 0;
  let files = 0;
  if (dir) {
    for await (const [, fh] of walk(dir)) {
      bytes += (await fh.getFile()).size;
      files++;
    }
  }
  return [bytes, files];
}

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

// ---------------------------------------------------------------- ingest

const zero = (): IngestTimings => ({ fetch: 0, rawWrite: 0, cacheRead: 0, normalize: 0, encode: 0, write: 0 });

/** Free-tier users are reportedly blocked from every endpoint from 30 min before a session to 30 min after. */
async function liveCheck(): Promise<string | null> {
  const [s] = await fetchEndpoint<RawSession>("sessions", { session_key: "latest" });
  if (!s) return null;
  const now = Date.now();
  const from = Date.parse(s.date_start) - 30 * 60_000;
  const to = Date.parse(s.date_end) + 30 * 60_000;
  const label = `latest session ${s.session_key} (${s.session_name}, ${s.date_start} to ${s.date_end})`;
  if (now >= from && now <= to) throw new Error(`OpenF1 live window: ${label}; the free tier is blocked until 30 min after it ends`);
  return `${label}: not live`;
}

async function run(key: number, mode: Mode, rawBase: string): Promise<RunResult> {
  const counts = { requests: 0, status429: 0, otherErrors: 0 };
  const result: RunResult = {
    key, mode, ok: false, totalMs: 0, seedMs: 0, seedBytes: 0, timings: zero(), requests: 0, status429: 0, otherErrors: 0,
    outputFiles: 0, outputJsonBytes: 0, outputGzBytes: 0, writeApi,
  };
  let t0 = performance.now();
  try {
    if (mode === "network") {
      result.liveCheck = (await liveCheck()) ?? "no latest session";
      t0 = performance.now(); // the check isn't part of the ingest
    }
    setRequestObserver((e) => {
      counts.requests++;
      if (e.status === 429) counts.status429++;
      else if (e.status >= 400 && e.status !== 404) counts.otherErrors++;
      post({ type: "request", status: e.status, ms: e.ms, requests: counts.requests, status429: counts.status429 });
    });

    if (mode === "compute") {
      // Seed OPFS with the local disk cache (data/raw/<key>), served by the spike's dev server.
      const res = await fetch(`${rawBase}/${key}/`);
      if (!res.ok) throw new Error(`no local raw cache for ${key} at ${rawBase} (HTTP ${res.status})`);
      const list = (await res.json()) as { name: string }[];
      let done = 0;
      for (const f of list) {
        const r = await fetch(`${rawBase}/${key}/${f.name}`);
        if (!r.ok) throw new Error(`HTTP ${r.status} for raw ${f.name}`);
        const bytes = new Uint8Array(await r.arrayBuffer());
        await writeFileAtomic(`raw/${key}/${f.name}`, bytes);
        result.seedBytes += bytes.length;
        post({ type: "seed", done: ++done, total: list.length });
      }
      result.seedMs = performance.now() - t0;
    }

    const offline = () => Promise.reject(new Error("compute-only mode: file missing from the local raw cache"));
    const io: IngestIO = {
      readFile,
      writeFileAtomic,
      gzip: gzipBytes,
      gunzip: gunzipBytes,
      fetchEndpoint: mode === "network" ? fetchEndpoint : offline,
      fetchCircuit: mode === "network" ? fetchCircuit : offline,
      async writeOutput(path, json) {
        const gz = await gzipBytes(enc.encode(json));
        await writeFileAtomic(`${path}.gz`, gz);
        return gz.length;
      },
      async readIndex(path) {
        const b = await readFile(`${path}.gz`);
        return b ? JSON.parse(dec.decode(await gunzipBytes(b))) : undefined;
      },
      async writeIndex(path, text) {
        await writeFileAtomic(`${path}.gz`, await gzipBytes(enc.encode(text)));
      },
      log: (line) => post({ type: "log", line }),
      warn: (line) => post({ type: "log", line, warn: true }),
    };
    const out = await runIngest(key, io, { rawDir: `raw/${key}`, sessionsDir: "sessions" }, (e) => post({ type: "event", e }));
    result.timings = out.timings;
    result.outputFiles = out.sizes.length;
    for (const [, json, gz] of out.sizes) {
      result.outputJsonBytes += json;
      result.outputGzBytes += gz;
    }
    result.ok = true;
  } catch (e) {
    result.error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  } finally {
    setRequestObserver(null);
    result.totalMs = performance.now() - t0;
    Object.assign(result, counts);
  }
  return result;
}

scope.onmessage = async (ev) => {
  const msg = ev.data;
  try {
    if (msg.type === "run") post({ type: "done", result: await run(msg.key, msg.mode, msg.rawBase) });
    else if (msg.type === "hashes") {
      // SHA-256 of each processed file's uncompressed content, keyed like public/sessions/<key>/.
      const files: Record<string, { sha256: string; bytes: number }> = {};
      const dir = await dirIfExists(`sessions/${msg.key}`);
      if (dir) {
        for await (const [path, fh] of walk(dir)) {
          const raw = await gunzipBytes(await fh.getFile());
          files[path.replace(/\.gz$/, "")] = { sha256: hex(await crypto.subtle.digest("SHA-256", raw)), bytes: raw.length };
        }
      }
      post({ type: "hashes", files });
    } else if (msg.type === "usage") {
      const [raw, rawFiles] = await sizeOf(`raw/${msg.key}`);
      const [processed, processedFiles] = await sizeOf(`sessions/${msg.key}`);
      post({ type: "usage", raw, processed, rawFiles, processedFiles });
    } else if (msg.type === "clear") {
      const root = await navigator.storage.getDirectory();
      const names: string[] = [];
      for await (const h of (root as unknown as { values(): AsyncIterable<FileSystemHandle> }).values()) names.push(h.name);
      for (const n of names) await root.removeEntry(n, { recursive: true });
      post({ type: "cleared" });
    }
  } catch (e) {
    post({ type: "error", message: e instanceof Error ? `${e.name}: ${e.message}` : String(e) });
  }
};
