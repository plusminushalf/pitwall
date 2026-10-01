// Runs one ingest job in a fresh worker and turns its events into progress and an ETA. A download gets a port
// from the credential vault (openPort) and hands it to the worker, so a signed-in download's requests go worker
// <-> vault with nothing relayed by this page (src/ingest/vaultPort.ts).

import type { IngestTimings } from "../../scripts/lib/ingestCore";
import type { LibraryEntry, StoreBackend } from "../storage/sessionStore";
import {
  assumedDrivers,
  CACHE_READ_S_PER_BYTE,
  cacheProgress,
  etaSeconds,
  expectedBytes,
  expectedRawFiles,
  fileSeconds,
  layoutOf,
  minuteFloor,
  nextProcessingS,
  nextRatio,
  placeholderFiles,
  PROCESSING_PRIOR_S,
  progressOf,
  REPROCESS_PRIOR_S,
  retryNotice,
  sizeScale,
  stepLabel,
  type Layout,
  type RawFileSpec,
  type Tier,
} from "./eta";
import { parseSliceFile } from "../../scripts/lib/slices";
import type { FailureKind, FromWorker, IngestRequest, JobMode, ToWorker } from "./protocol";

/** What a job needs to know about its session up front (from the catalogue). */
export interface JobInfo {
  key: number;
  /** "Australian Grand Prix · Race" */
  label: string;
  sessionType: string;
  year: number;
  dateStart: string;
  dateEnd: string;
  mode: JobMode;
}

/** Download speed learned across jobs (kept in localStorage). */
export interface Learned {
  /** Observed / predicted seconds per file, free tier (direct). */
  ratio: number;
  /** The same, signed in (through the vault). */
  sponsorRatio: number;
  processingS: number;
  reprocessS: number;
}

const LEARNED_KEY = "f1-replay:eta";

export function loadLearned(): Learned {
  const fallback: Learned = { ratio: 1, sponsorRatio: 1, processingS: PROCESSING_PRIOR_S, reprocessS: REPROCESS_PRIOR_S };
  try {
    const v = JSON.parse(localStorage.getItem(LEARNED_KEY) ?? "null") as Partial<Learned> | null;
    return { ...fallback, ...(v ?? {}) };
  } catch {
    return fallback;
  }
}

function saveLearned(l: Learned) {
  try {
    localStorage.setItem(LEARNED_KEY, JSON.stringify(l));
  } catch {}
}

export interface Progress {
  phase: "downloading" | "processing";
  /** What's happening, e.g. "Car telemetry · #44 (12/22)". */
  step: string | null;
  /** e.g. "Rate-limited by OpenF1, retrying in 10s". */
  notice: string | null;
  cachedFiles: number;
  expectedFiles: number;
  /** Stored raw bytes so far, and the expected total. */
  cachedBytes: number;
  totalBytes: number;
  /** 0-1 */
  progress: number;
  etaSeconds: number;
  startedAt: number;
  /** Signed in (requests through the vault, the account's limits) or the free tier; null until known. */
  fast: boolean | null;
  /** Watching it while it downloads: how much of what the replay needs to start is in (0-1). */
  startup: number;
  /** A race downloaded in slices: how much of its telemetry is in (0-1); null before they're planned (or per driver). */
  telemetry: number | null;
  /** It can be watched while it downloads (a race in slices); else it opens once it's downloaded. */
  streams: boolean;
}

/** What a streamed replay needs to start (src/ingest/stream.ts): these files, and a slice of each telemetry endpoint. */
const STARTUP_FILES = ["sessions", "meeting", "drivers", "laps", "race_control", "position", "intervals", "stints"];

/** Follows one job's worker events; `view()` is its progress at any moment. */
export class JobTracker {
  private files = new Map<string, number>();
  private drivers: number[] | null = null;
  private phase: "downloading" | "processing" = "downloading";
  private step: string | null = "Starting";
  /** When the last file arrived (or the first request started). */
  private mark: number | null = null;
  /** Retry waits since the mark (ms), and when the current one ends. */
  private waitMs = 0;
  private waitUntil = 0;
  private retryStatus: number | null = null;
  private processingAt: number | null = null;
  /** Reading back what an earlier run stored (resumed downloads). */
  private cacheReadS = 0;
  /** Predicted seconds of what was stored when the job started (a head start for progress). */
  private headS = 0;
  private readonly scale: number;
  private readonly assumed: number;
  readonly startedAt: number;
  /** Which way the requests go (the worker's "path"): the cost model and the learned ratio follow it. */
  private tier: Tier | null = null;
  private telemetry: number | null = null;
  /** Races in slices, unless an earlier run stored per-driver files (known at "start"). */
  private layout: Layout;
  /** When this run's OpenF1 requests started (for the minute's worth the free tier allows), and how many are in. */
  private requestStarts: number[] = [];
  private requestsIn = 0;
  /** Files in memory (read or downloaded): what a streamed replay waits for. */
  private inMemory = new Set<string>();

  constructor(
    readonly info: JobInfo,
    readonly learned: Learned,
    now = Date.now(),
  ) {
    this.scale = sizeScale(info.dateStart, info.dateEnd);
    this.assumed = assumedDrivers(info.year);
    this.startedAt = now;
    this.layout = layoutOf([]);
    if (info.mode === "reprocess") this.step = "Reading stored data";
  }

  private expected(): RawFileSpec[] {
    return expectedRawFiles(this.info.sessionType, this.drivers, this.assumed, this.layout, this.scale);
  }

  private secs = (f: RawFileSpec) => fileSeconds(f, this.tier ?? "free", this.scale);

  private get ratio() {
    return this.tier === "sponsor" ? (this.learned.sponsorRatio ?? 1) : this.learned.ratio;
  }
  private set ratio(r: number) {
    if (this.tier === "sponsor") this.learned.sponsorRatio = r;
    else this.learned.ratio = r;
  }

  onMessage(m: FromWorker, now = Date.now()): void {
    switch (m.type) {
      case "start":
        for (const [name, bytes] of Object.entries(m.cached)) {
          this.files.set(name, bytes);
          this.cacheReadS += bytes * CACHE_READ_S_PER_BYTE;
        }
        this.drivers ??= m.drivers;
        this.layout = layoutOf(Object.keys(m.cached));
        {
          const p = cacheProgress(this.expected(), placeholderFiles(this.files));
          this.headS = p.counted.filter((f) => !p.missing.includes(f)).reduce((s, f) => s + this.secs(f), 0);
        }
        return;
      case "drivers":
        this.drivers = m.numbers;
        return;
      case "path":
        this.tier = m.path === "vault" ? "sponsor" : "free";
        return;
      case "fetch":
        this.step = stepLabel(m.endpoint, m.params, this.drivers);
        this.mark ??= now;
        this.retryStatus = null;
        if (m.endpoint !== "circuit") this.requestStarts.push(now);
        return;
      case "telemetry":
        this.telemetry = m.progress;
        return;
      case "fetched": {
        this.inMemory.add(parseSliceFile(m.file)?.endpoint ?? m.file);
        if (m.source !== "network") return;
        // (A slice: as its endpoint's placeholders are, all alike.)
        const part = parseSliceFile(m.file);
        const spec = this.expected().find((f) => f.name === (part ? `${part.endpoint}#0` : m.file));
        // The circuit map isn't an OpenF1 request: not representative of the rest.
        if (spec && !spec.external && this.mark != null) {
          const observed = Math.max(0, now - this.mark - this.waitMs) / 1000;
          // (Not across a wait for the minute's requests to roll over: that's the pace, not the speed.)
          if (observed < 10 + 4 * this.secs(spec)) this.ratio = nextRatio(this.ratio, observed, this.secs(spec));
        }
        if (m.file !== "circuit") this.requestsIn++;
        if (!this.files.has(m.file)) this.files.set(m.file, 0);
        this.mark = now;
        this.waitMs = 0;
        this.retryStatus = null;
        return;
      }
      case "stored":
        this.files.set(m.file, m.bytes);
        return;
      case "retry":
        this.retryStatus = m.status;
        this.waitMs += m.waitMs;
        this.waitUntil = now + m.waitMs;
        return;
      case "phase":
        if (m.phase === "normalize") {
          this.phase = "processing";
          this.processingAt = now;
          this.step = "Processing";
        } else if (m.phase === "write") this.step = "Saving to this browser";
        return;
    }
  }

  /** Learn from a finished job (processing time), and keep what was learned. */
  finished(now = Date.now()): void {
    if (this.info.mode === "reprocess") this.learned.reprocessS = nextProcessingS(this.learned.reprocessS, (now - this.startedAt) / 1000);
    else if (this.processingAt != null) this.learned.processingS = nextProcessingS(this.learned.processingS, (now - this.processingAt) / 1000);
    saveLearned(this.learned);
  }

  view(now = Date.now()): Progress {
    const p = cacheProgress(this.expected(), placeholderFiles(this.files));
    const needed = [...STARTUP_FILES, "location", "car_data"];
    const base = {
      step: this.step,
      cachedFiles: p.cachedFiles,
      expectedFiles: p.expectedFiles,
      cachedBytes: p.cachedBytes,
      startedAt: this.startedAt,
      fast: this.tier === null ? null : this.tier === "sponsor",
      startup: needed.filter((f) => this.inMemory.has(f)).length / needed.length,
      telemetry: this.telemetry,
      streams: this.layout === "sliced" && this.info.sessionType !== "Qualifying",
    };
    if (this.info.mode === "reprocess") {
      const elapsed = (now - this.startedAt) / 1000;
      const prior = this.learned.reprocessS;
      return {
        ...base,
        phase: "processing",
        notice: null,
        totalBytes: p.cachedBytes,
        progress: Math.min(0.95, elapsed / prior),
        etaSeconds: Math.max(1, Math.round(prior - elapsed)),
      };
    }
    // Requests of the last minute that are in (the ones in flight are still missing files): how long the rest take at
    // least, waiting for the minute to roll over if they don't fit in it.
    const recent = this.requestStarts.filter((t) => t > now - 60_000);
    const made = Math.max(0, recent.length - Math.max(0, this.requestStarts.length - this.requestsIn));
    // Slices: what's left of the telemetry is what the plan says (more slices than placeholders after a jump or a
    // long race), at the placeholders' cost.
    const isSlice = (f: RawFileSpec) => f.name.includes("#");
    const slices = p.counted.filter(isSlice);
    const sliceShare = this.layout === "sliced" && this.telemetry != null && slices.length ? 1 - this.telemetry : null;
    const missing = sliceShare == null ? p.missing : p.missing.filter((f) => !isSlice(f));
    const sliceS = sliceShare == null ? 0 : sliceShare * slices.reduce((s, f) => s + this.secs(f), 0);
    const requestsLeft = missing.filter((f) => !f.external).length + (sliceShare == null ? 0 : Math.ceil(sliceShare * slices.length));
    const floorS = minuteFloor(requestsLeft, this.tier ?? "free", made, recent.length ? (now - recent[0]) / 1000 : 0);
    const remainingS = missing.reduce((s, f) => s + this.secs(f), 0) + sliceS;
    const currentS = p.missing[0] ? this.secs(p.missing[0]) : 0;
    const missingBytes = p.missing.reduce((s, f) => s + expectedBytes(f, this.scale), 0);
    const waitS = Math.max(0, this.waitUntil - now) / 1000;
    const ratio = this.ratio;
    const processingS = this.processingAt != null ? (now - this.processingAt) / 1000 : 0;
    // Before processing starts, stored files are still being read back (roughly: they're read in request order).
    const prior = this.learned.processingS + (this.phase === "downloading" ? this.cacheReadS : 0);
    // Time since the last file arrived, not counting retry waits already sat out.
    const sinceMarkS = this.mark == null ? null : Math.max(0, now - this.mark - (this.waitMs - waitS * 1000)) / 1000;
    const eta =
      this.phase === "processing"
        ? etaSeconds({ phase: "processing", remainingS: 0, currentS: 0, sinceMarkS, ratio, processingS, processingPriorS: prior })
        : etaSeconds({ phase: "downloading", remainingS, currentS, sinceMarkS, ratio, waitS, floorS, processingPriorS: prior });
    return {
      ...base,
      phase: this.phase,
      notice: this.retryStatus != null && waitS > 0 ? retryNotice(this.retryStatus, waitS) : null,
      totalBytes: Math.round(p.cachedBytes + missingBytes),
      progress: progressOf({ phase: this.phase, headS: this.headS, elapsedS: (now - this.startedAt) / 1000, etaS: eta }),
      etaSeconds: Math.round(eta),
    };
  }
}

const REQUESTS_KEY = "f1-replay:requests";

/**
 * When this browser's direct OpenF1 requests of the last minute started, across workers and tabs (OpenF1 counts them
 * per IP): a new job's worker paces itself around them (a reload mid-download, the next download in the queue).
 */
export function recentRequests(now = Date.now()): number[] {
  try {
    const v = JSON.parse(localStorage.getItem(REQUESTS_KEY) ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((t): t is number => typeof t === "number" && t > now - 60_000) : [];
  } catch {
    return [];
  }
}

export function noteRequest(at: number): void {
  try {
    localStorage.setItem(REQUESTS_KEY, JSON.stringify([...recentRequests(), at]));
  } catch {}
}

/** On cancel, the worker gets this long to tell the vault before it's terminated. */
const CANCEL_GRACE_MS = 200;

export type RunOutcome =
  | { ok: true; entry: LibraryEntry; timings: IngestTimings; requests: number; status429: number; ms: number }
  | { ok: false; kind: FailureKind | "cancelled" | "crashed"; message: string; detail?: string };

export interface RunHandle {
  tracker: JobTracker;
  done: Promise<RunOutcome>;
  /** Stop now: stored raw files are kept (a later run resumes from them). */
  cancel(): void;
  /** Tell the worker (a race being watched: where; or that nobody is). */
  send(m: Extract<ToWorker, { type: "watch" | "unwatch" }>): void;
}

/** What runJob needs from the credential vault's client (src/vault/client.ts getVault()): a port for the worker. */
export type VaultLink = { origin: string | null; openPort(port: MessagePort): Promise<unknown> };

/**
 * Start a job in its own worker. `onEvent` fires on every worker message (for re-rendering progress). `vault`:
 * a download asks it for a port, which the worker uses if the vault is signed in (else it goes direct).
 */
export function runJob(
  info: JobInfo,
  backend: StoreBackend,
  learned: Learned,
  onEvent: (m: FromWorker) => void,
  vault: VaultLink | null = null,
  watch: { playhead: number | null } | null = null,
): RunHandle {
  const tracker = new JobTracker(info, learned);
  const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module", name: `ingest-${info.key}` });
  const send = (m: ToWorker, transfer: MessagePort[] = []) => worker.postMessage(m, transfer);
  let settle!: (o: RunOutcome) => void;
  const done = new Promise<RunOutcome>((resolve) => (settle = resolve));
  let finished = false;
  const end = (o: RunOutcome) => {
    if (finished) return;
    finished = true;
    if (o.ok || o.kind !== "cancelled") worker.terminate();
    else {
      // Let the worker tell the vault first (its queued requests are dropped), then stop it.
      send({ type: "cancel" });
      setTimeout(() => worker.terminate(), CANCEL_GRACE_MS);
    }
    if (o.ok) tracker.finished();
    settle(o);
  };
  const t0 = performance.now();

  worker.onmessage = (e: MessageEvent<FromWorker>) => {
    const m = e.data;
    if (m.type === "request") return noteRequest(m.at);
    tracker.onMessage(m);
    if (m.type === "log") (m.warn ? console.warn : console.debug)(`[ingest ${info.key}] ${m.line}`);
    onEvent(m);
    if (m.type === "done") end({ ok: true, entry: m.entry, timings: m.timings, requests: m.requests, status429: m.status429, ms: performance.now() - t0 });
    else if (m.type === "failed") end({ ok: false, kind: m.kind, message: m.message, detail: m.detail });
  };
  worker.onerror = (e) => {
    e.preventDefault();
    end({ ok: false, kind: "crashed", message: e.message || "The download stopped unexpectedly (out of memory?)" });
  };
  // A download gets its own port to the vault (the worker speaks the vault's protocol on it; the vault decides
  // nothing here: the worker asks it for its status and goes direct unless it's signed in).
  let vaultPort: MessagePort | undefined;
  if (info.mode === "download" && vault?.origin) {
    const channel = new MessageChannel();
    vaultPort = channel.port2;
    vault
      .openPort(channel.port1)
      .catch((e: Error) => {
        if (!finished) send({ type: "no-vault", reason: e.message });
      });
  }
  const request: IngestRequest = {
    type: "ingest",
    key: info.key,
    mode: info.mode,
    backend,
    ...(vaultPort && { vault: vaultPort }),
    ...(watch && { watch }),
    recentRequests: recentRequests(),
  };
  send(request, vaultPort ? [vaultPort] : []);

  return {
    tracker,
    done,
    cancel: () => end({ ok: false, kind: "cancelled", message: "Cancelled" }),
    send: (m) => {
      if (!finished) send(m);
    },
  };
}
