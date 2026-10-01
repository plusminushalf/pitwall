// Ingest worker: the same pipeline as the CLI (scripts/lib/ingestCore.ts + normalize + quali) with the
// browser as its I/O. Requests go through the credential vault when it's signed in (a port the page got from
// it: the account's limits, in parallel; vaultPort.ts), else straight from this browser to OpenF1 (free tier,
// rate-limited by the shared client), and direct for the rest if the vault goes away mid-download. Raw
// responses and processed output go into the session store (OPFS). One job per worker: the page terminates it
// when the job ends or is cancelled. A race being watched while it downloads is streamed to the page as it comes
// in (stream.ts), its slices fetched from wherever the page says the replay is.

import { runIngest, type IngestIO } from "../../scripts/lib/ingestCore";
import { FORMAT_VERSION } from "../../scripts/lib/formatVersion";
import { fetchCircuit, fetchEndpoint, LiveWindowError, seedRequestStarts, setRequestObserver, setRetryObserver, untilRequestSlot } from "../../scripts/lib/openf1Http";
import { openStore } from "../storage";
import { gunzipBytes, gzipBytes } from "../storage/handleStore";
import type { LibraryEntry } from "../storage/sessionStore";
import { fileForFetch } from "./eta";
import type { FailureKind, FromWorker, IngestRequest, ToWorker } from "./protocol";
import { TIER_CONCURRENCY } from "./eta";
import { choosePath, vaultFetchEndpoint, VaultPort, type Path, type PortLike } from "./vaultPort";
import { StreamBuilder, transferables } from "./stream";
import { parseSliceFile, SlicePlan } from "../../scripts/lib/slices";

const scope = self as unknown as {
  postMessage(m: FromWorker, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<ToWorker>) => void) | null;
};
const post = (m: FromWorker, transfer: Transferable[] = []) => scope.postMessage(m, transfer);

/** After something new comes in, the stream update waits this long for more (several files land together). */
const STREAM_DEBOUNCE_MS = 150;
const dec = new TextDecoder();

/** Re-processing needs a raw response that isn't stored. */
class RawMissingError extends Error {
  override name = "RawMissingError";
}

let vault: VaultPort | null = null;

// Watching: the provisional replay (null outside a download), where the replay is (ms since its t0) and that t0
// (absolute ms, once the slices are planned).
let stream: StreamBuilder | null = null;
/** Watched (a `watch` message may come before the job has its builder). */
let watching = false;
let playhead: number | null = null;
let t0: number | null = null;
let streamTimer: ReturnType<typeof setTimeout> | null = null;

/** Send the page what's new in the provisional replay. */
function flushStream(): void {
  if (streamTimer) clearTimeout(streamTimer);
  streamTimer = null;
  const u = stream?.update();
  if (u) post(u, transferables(u));
}

function scheduleStream(): void {
  if (!streamTimer) streamTimer = setTimeout(flushStream, STREAM_DEBOUNCE_MS);
}

/** Which way this job's requests go: the vault's first status decides (or there's no vault port). */
async function pickPath(port: MessagePort | undefined): Promise<{ path: Path; reason: string }> {
  if (!port) return { path: "direct", reason: "no vault" };
  vault = new VaultPort(port as unknown as PortLike);
  const status = await vault.status();
  const choice = choosePath(status);
  if (choice.path === "direct") {
    vault.close();
    vault = null;
  }
  return status ? choice : { path: "direct", reason: "the vault didn't answer" };
}

async function ingest({ key, mode, backend, vault: port, watch, recentRequests }: IngestRequest): Promise<void> {
  // Watched from the start (a `watch` / `unwatch` coming later wins).
  if (watch) {
    watching = true;
    playhead = watch.playhead;
  }
  // This browser's OpenF1 requests of the last minute (an earlier worker's: a reload, the download before): they count.
  if (recentRequests?.length) seedRequestStarts(recentRequests);
  const store = openStore(backend);
  // Which way requests go is only needed for the first one: what's stored is read meanwhile (a resumed stream can
  // start from it while the vault answers).
  let path: Path | null = mode === "download" ? null : "direct";
  const pathP =
    mode === "download"
      ? pickPath(port).then((choice) => {
          path = choice.path;
          post({ type: "path", path: choice.path, reason: choice.reason });
          return choice.path;
        })
      : Promise.resolve<Path>("direct");
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
  if (mode === "download") {
    stream = new StreamBuilder(key);
    if (watching) stream.watch();
  }
  let plan: SlicePlan | null = null;

  const counts = { requests: 0, status429: 0 };
  const count = (status: number) => {
    counts.requests++;
    if (status === 429) counts.status429++;
  };
  setRequestObserver((e) => {
    count(e.status);
    post({ type: "request", at: Date.now() - e.ms });
  });
  setRetryObserver((e) => post({ type: "retry", status: e.status, waitMs: e.waitMs }));
  const fetchDataP = pathP.then(() =>
    vault
      ? vaultFetchEndpoint({
          vault,
          direct: fetchEndpoint,
          onPath: (p, why) => post({ type: "path", path: p, reason: why }),
          onRequest: count,
          onRetry: (e) => post({ type: "retry", status: e.status, waitMs: e.waitMs }),
        })
      : fetchEndpoint,
  );

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
    rawFiles: async () => [...cached.keys()],
    playhead: () => (playhead != null && t0 != null ? t0 + playhead : null),
    // Direct (free tier): this worker's own pacing. Through the vault, its budget decides; nothing to wait for here.
    whenReady: async (reserve) => {
      await pathP;
      if (!vault) await untilRequestSlot(reserve);
    },
    // Several at once: the vault's budget (signed in) or the direct client's pacing is the real limit.
    concurrency: () => TIER_CONCURRENCY[path === "vault" ? "sponsor" : "free"],
    fetchEndpoint:
      mode === "download"
        ? async <T,>(endpoint: string, params: Record<string, string | number>) => {
            const fetchData = await fetchDataP;
            post({ type: "fetch", file: fileForFetch(endpoint, params), endpoint, params });
            return fetchData<T>(endpoint, params);
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
    else if (e.kind === "phase" && e.phase !== "done") post({ type: "phase", phase: e.phase });
    // How much of a race's telemetry is in (its slices).
    if (e.kind === "plan") {
      plan = new SlicePlan(e.span, e.stored);
      t0 = e.window.t0;
    }
    const part = e.kind === "raw" ? parseSliceFile(e.name) : null;
    if (part) plan?.stored(part);
    if (plan && (e.kind === "plan" || part)) post({ type: "telemetry", progress: plan.progress() });
    if (stream?.onEvent(e)) scheduleStream();
    // Processing keeps the worker busy for a moment: the page gets everything before that.
    if (e.kind === "phase" && e.phase === "normalize") flushStream();
  });
  stream = null;

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
  const m = ev.data;
  if (m?.type === "no-vault") return void vault?.markDown(m.reason);
  if (m?.type === "cancel") return void vault?.close();
  if (m?.type === "watch") {
    watching = true;
    playhead = m.playhead;
    if (stream && !stream.watching) {
      stream.watch();
      scheduleStream();
    }
    return;
  }
  if (m?.type === "unwatch") {
    watching = false;
    return void stream?.unwatch();
  }
  if (m?.type !== "ingest") return;
  ingest(m)
    .catch((e) => post({ type: "failed", ...failure(e) }))
    .finally(() => vault?.close());
};
