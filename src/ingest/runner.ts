// Runs one ingest job in a fresh worker and turns its events into progress and an ETA.

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
  nextProcessingS,
  nextRatio,
  PROCESSING_PRIOR_S,
  progressOf,
  REPROCESS_PRIOR_S,
  retryNotice,
  sizeScale,
  stepLabel,
  type RawFileSpec,
} from "./eta";
import type { FailureKind, FromWorker, IngestRequest, JobMode } from "./protocol";

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
  /** Observed / predicted seconds per file. */
  ratio: number;
  processingS: number;
  reprocessS: number;
}

const LEARNED_KEY = "f1-replay:eta";

export function loadLearned(): Learned {
  const fallback: Learned = { ratio: 1, processingS: PROCESSING_PRIOR_S, reprocessS: REPROCESS_PRIOR_S };
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
}

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
  private readonly scale: number;
  private readonly assumed: number;
  readonly startedAt: number;

  constructor(
    readonly info: JobInfo,
    readonly learned: Learned,
    now = Date.now(),
  ) {
    this.scale = sizeScale(info.dateStart, info.dateEnd);
    this.assumed = assumedDrivers(info.year);
    this.startedAt = now;
    if (info.mode === "reprocess") this.step = "Reading stored data";
  }

  private expected(): RawFileSpec[] {
    return expectedRawFiles(this.info.sessionType, this.drivers, this.assumed);
  }

  private secs = (f: RawFileSpec) => fileSeconds(f, "free", this.scale);

  onMessage(m: FromWorker, now = Date.now()): void {
    switch (m.type) {
      case "start":
        for (const [name, bytes] of Object.entries(m.cached)) {
          this.files.set(name, bytes);
          this.cacheReadS += bytes * CACHE_READ_S_PER_BYTE;
        }
        this.drivers ??= m.drivers;
        return;
      case "drivers":
        this.drivers = m.numbers;
        return;
      case "fetch":
        this.step = stepLabel(m.endpoint, m.params, this.drivers);
        this.mark ??= now;
        this.retryStatus = null;
        return;
      case "fetched": {
        if (m.source !== "network") return;
        const spec = this.expected().find((f) => f.name === m.file);
        // The circuit map isn't an OpenF1 request: not representative of the rest.
        if (spec && !spec.external && this.mark != null) {
          const observed = Math.max(0, now - this.mark - this.waitMs) / 1000;
          this.learned.ratio = nextRatio(this.learned.ratio, observed, this.secs(spec));
        }
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
    const p = cacheProgress(this.expected(), this.files);
    const base = {
      step: this.step,
      cachedFiles: p.cachedFiles,
      expectedFiles: p.expectedFiles,
      cachedBytes: p.cachedBytes,
      startedAt: this.startedAt,
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
    const remainingS = p.missing.reduce((s, f) => s + this.secs(f), 0);
    const currentS = p.missing[0] ? this.secs(p.missing[0]) : 0;
    const totalS = p.counted.reduce((s, f) => s + this.secs(f), 0);
    const missingBytes = p.missing.reduce((s, f) => s + expectedBytes(f, this.scale), 0);
    const waitS = Math.max(0, this.waitUntil - now) / 1000;
    const ratio = this.learned.ratio;
    const processingS = this.processingAt != null ? (now - this.processingAt) / 1000 : 0;
    // Before processing starts, stored files are still being read back (roughly: they're read in request order).
    const prior = this.learned.processingS + (this.phase === "downloading" ? this.cacheReadS : 0);
    // Time since the last file arrived, not counting retry waits already sat out.
    const sinceMarkS = this.mark == null ? null : Math.max(0, now - this.mark - (this.waitMs - waitS * 1000)) / 1000;
    const eta =
      this.phase === "processing"
        ? etaSeconds({ phase: "processing", remainingS: 0, currentS: 0, sinceMarkS, ratio, processingS, processingPriorS: prior })
        : etaSeconds({ phase: "downloading", remainingS, currentS, sinceMarkS, ratio, waitS, processingPriorS: prior });
    const inFlight = this.mark != null && currentS > 0 ? (now - this.mark) / 1000 / (ratio * currentS) : 0;
    return {
      ...base,
      phase: this.phase,
      notice: this.retryStatus != null && waitS > 0 ? retryNotice(this.retryStatus, waitS) : null,
      totalBytes: Math.round(p.cachedBytes + missingBytes),
      progress: progressOf({ phase: this.phase, totalS, remainingS, currentS, inFlight, processingS, processingPriorS: prior }),
      etaSeconds: Math.round(eta),
    };
  }
}

export type RunOutcome =
  | { ok: true; entry: LibraryEntry; timings: IngestTimings; requests: number; status429: number; ms: number }
  | { ok: false; kind: FailureKind | "cancelled" | "crashed"; message: string; detail?: string };

export interface RunHandle {
  tracker: JobTracker;
  done: Promise<RunOutcome>;
  /** Stop now: stored raw files are kept (a later run resumes from them). */
  cancel(): void;
}

/** Start a job in its own worker. `onEvent` fires on every worker message (for re-rendering progress). */
export function runJob(info: JobInfo, backend: StoreBackend, learned: Learned, onEvent: (m: FromWorker) => void): RunHandle {
  const tracker = new JobTracker(info, learned);
  const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module", name: `ingest-${info.key}` });
  let settle!: (o: RunOutcome) => void;
  const done = new Promise<RunOutcome>((resolve) => (settle = resolve));
  let finished = false;
  const end = (o: RunOutcome) => {
    if (finished) return;
    finished = true;
    worker.terminate();
    if (o.ok) tracker.finished();
    settle(o);
  };
  const t0 = performance.now();

  worker.onmessage = (e: MessageEvent<FromWorker>) => {
    const m = e.data;
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
  const request: IngestRequest = { type: "ingest", key: info.key, mode: info.mode, backend };
  worker.postMessage(request);

  return { tracker, done, cancel: () => end({ ok: false, kind: "cancelled", message: "Cancelled" }) };
}
