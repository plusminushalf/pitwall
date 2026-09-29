// Ingest worker: the same pipeline as the CLI (scripts/lib/ingestCore.ts + normalize + quali) with the
// browser as its I/O. Requests go straight from this browser to OpenF1 (free tier, rate-limited by the
// shared client); raw responses and processed output go into the session store (OPFS). One job per
// worker: the page terminates it when the job ends or is cancelled.

import { runIngest, type IngestIO } from "../../scripts/lib/ingestCore";
import { FORMAT_VERSION } from "../../scripts/lib/formatVersion";
import { fetchCircuit, fetchEndpoint, LiveWindowError, setRequestObserver, setRetryObserver } from "../../scripts/lib/openf1Http";
import { openStore } from "../storage";
import { gunzipBytes, gzipBytes } from "../storage/handleStore";
import type { LibraryEntry } from "../storage/sessionStore";
import { fileForFetch } from "./eta";
import type { FailureKind, FromWorker, IngestRequest } from "./protocol";

const scope = self as unknown as { postMessage(m: FromWorker): void; onmessage: ((e: MessageEvent<IngestRequest>) => void) | null };
const post = (m: FromWorker) => scope.postMessage(m);
const dec = new TextDecoder();

/** Re-processing needs a raw response that isn't stored. */
class RawMissingError extends Error {
  override name = "RawMissingError";
}

async function ingest({ key, mode, backend }: IngestRequest): Promise<void> {
  const store = openStore(backend);
  const rawPrefix = `raw/${key}/`;
  const outPrefix = `sessions/${key}/`;
  const under = (path: string, prefix: string) => (path.startsWith(prefix) ? path.slice(prefix.length) : null);

  // What an earlier (interrupted) download already stored: only the rest is fetched.
  const cached = await store.rawFiles(key);
  let drivers: number[] | null = null;
  const driversGz = cached.has("drivers") ? await store.readRaw(key, "drivers") : undefined;
  if (driversGz) {
    try {
      const rows = JSON.parse(dec.decode(await gunzipBytes(driversGz))) as { driver_number: number }[];
      drivers = [...new Set(rows.map((d) => d.driver_number))].sort((a, b) => a - b);
    } catch {}
  }
  post({ type: "start", cached: Object.fromEntries(cached), drivers });

  const counts = { requests: 0, status429: 0 };
  setRequestObserver((e) => {
    counts.requests++;
    if (e.status === 429) counts.status429++;
  });
  setRetryObserver((e) => post({ type: "retry", status: e.status, waitMs: e.waitMs }));

  const offline = (file: string) => Promise.reject(new RawMissingError(`"${file}" isn't stored in this browser`));
  let cleared = false;
  const io: IngestIO = {
    async readFile(path) {
      const name = under(path, rawPrefix);
      // Only gzipped files: the CLI's legacy uncompressed cache never existed here.
      return name?.endsWith(".json.gz") ? store.readRaw(key, name.slice(0, -".json.gz".length)) : undefined;
    },
    async writeFileAtomic(path, bytes) {
      const name = under(path, rawPrefix);
      if (!name?.endsWith(".json.gz")) throw new Error(`Unexpected raw cache path ${path}`);
      const file = name.slice(0, -".json.gz".length);
      await store.writeRaw(key, file, bytes);
      post({ type: "stored", file, bytes: bytes.length });
    },
    gzip: gzipBytes,
    gunzip: gunzipBytes,
    fetchEndpoint:
      mode === "download"
        ? <T,>(endpoint: string, params: Record<string, string | number>) => {
            post({ type: "fetch", file: fileForFetch(endpoint, params), endpoint, params });
            return fetchEndpoint<T>(endpoint, params);
          }
        : (endpoint, params) => offline(fileForFetch(endpoint, params)),
    fetchCircuit:
      mode === "download"
        ? (url) => {
            post({ type: "fetch", file: "circuit", endpoint: "circuit", params: {} });
            return fetchCircuit(url);
          }
        : () => offline("circuit"),
    async writeOutput(path, json) {
      // Replace an earlier version only once the new one is ready to be written.
      if (!cleared) {
        await store.clearProcessed(key);
        cleared = true;
      }
      const file = under(path, outPrefix);
      if (!file) throw new Error(`Unexpected output path ${path}`);
      return store.writeProcessed(key, file, json);
    },
    log: (line) => post({ type: "log", line }),
    warn: (line) => post({ type: "log", line, warn: true }),
  };

  const out = await runIngest(key, io, { rawDir: `raw/${key}`, sessionsDir: "sessions" }, (e) => {
    if (e.kind === "raw") post({ type: "fetched", file: e.name, source: e.source, ms: e.ms });
    else if (e.kind === "drivers") post({ type: "drivers", numbers: e.numbers });
    else if (e.phase !== "done") post({ type: "phase", phase: e.phase });
  });

  let rawBytes = 0;
  for (const size of (await store.rawFiles(key)).values()) rawBytes += size;
  const entry: LibraryEntry = {
    ...out.entry,
    sessionType: out.entry.sessionType ?? "Race",
    format: FORMAT_VERSION,
    processedAt: new Date().toISOString(),
    processedBytes: out.sizes.reduce((s, [, , gz]) => s + gz, 0),
    rawBytes,
  };
  await store.commit(entry);
  post({ type: "done", entry, timings: out.timings, requests: counts.requests, status429: counts.status429 });
}

function failure(e: unknown): { kind: FailureKind; message: string; detail?: string } {
  if (e instanceof LiveWindowError) return { kind: "live-window", message: e.message, detail: e.detail };
  if (e instanceof RawMissingError) return { kind: "raw-missing", message: e.message };
  const name = (e as { name?: string })?.name;
  const message = e instanceof Error ? e.message : String(e);
  if (name === "QuotaExceededError") return { kind: "quota", message };
  return { kind: "error", message };
}

scope.onmessage = (ev) => {
  if (ev.data?.type !== "ingest") return;
  ingest(ev.data).catch((e) => post({ type: "failed", ...failure(e) }));
};
