// Pure parts of the race downloader (devserver/ingestPlugin.ts): cost model, ETA, log-line parsing.
// No I/O here, so it's unit-tested directly (ingestCore.test.ts).

import type { Tier } from "../src/data/ingestTypes.ts";

/** Minimum gap between OpenF1 requests, from scripts/openf1.ts. */
export const TIER_INTERVAL_S: Record<Tier, number> = { free: 2.2, sponsor: 1.1 };

// Time for one OpenF1 request (server query + transfer + parse + gzip + write) is roughly
// REQUEST_LATENCY_S + gzipped size × SECONDS_PER_BYTE; a request can't start sooner than the tier interval
// after the previous one. Fitted to cache mtimes of real sponsor-tier downloads: 2025 Australia race
// telemetry (334 KB avg) 2.45 s per file, 2025 China sprint (145 KB) 1.43 s; small files are interval-bound.
export const REQUEST_LATENCY_S = 0.64;
export const SECONDS_PER_BYTE = 5.4e-6;
/** Bun startup, OpenF1 token, reading already-cached files. */
export const STARTUP_S = 1;
/** Processing once everything is cached: `bun scripts/ingest.ts 11234` fully cached takes 3.2-3.5 s (11353: 4.6 s). */
export const PROCESSING_PRIOR_S = 4;

/** One raw cache file ingest writes to data/raw/<key>/<name>.json.gz. */
export interface RawFileSpec {
  name: string;
  /** Missing optional files (the MultiViewer circuit map) don't block completion. */
  required: boolean;
  /** Not an OpenF1 request, so not rate-limited. */
  external?: boolean;
  /** Expected gzipped size for a 2-hour session window. */
  bytes: number;
  /** Whether the size scales with the session window (telemetry, laps, intervals). */
  scales?: boolean;
}

/** Session window relative to a 2-hour race slot, clamped: sprints and qualifying are ~0.5. */
export function sizeScale(dateStart: string, dateEnd: string): number {
  const minutes = (Date.parse(dateEnd) - Date.parse(dateStart)) / 60_000;
  if (!Number.isFinite(minutes) || minutes <= 0) return 1;
  return Math.min(1.5, Math.max(0.25, minutes / 120));
}

export const expectedBytes = (f: RawFileSpec, scale: number) => (f.scales ? f.bytes * scale : f.bytes);

/** Expected seconds to fetch one file with no cache. */
export function fileSeconds(f: RawFileSpec, tier: Tier, scale: number): number {
  const work = REQUEST_LATENCY_S + expectedBytes(f, scale) * SECONDS_PER_BYTE;
  return f.external ? work : Math.max(TIER_INTERVAL_S[tier], work);
}

/**
 * Up-front estimate for downloading the missing files and processing; `ratio` is the observed / predicted
 * download speed learned from earlier downloads (1 = the priors above).
 */
export function estimate(missing: RawFileSpec[], tier: Tier, scale: number, ratio = 1): { seconds: number; mb: number } {
  let download = 0;
  let bytes = 0;
  for (const f of missing) {
    download += fileSeconds(f, tier, scale);
    bytes += expectedBytes(f, scale);
  }
  return { seconds: Math.round(STARTUP_S + ratio * download + PROCESSING_PRIOR_S), mb: Math.round(bytes / 1e5) / 10 };
}

// ---------------------------------------------------------------- ETA

/** Weight of each new file in the EWMA of observed / predicted seconds. */
export const EWMA_ALPHA = 0.15;

/**
 * Next speed ratio (observed / predicted seconds per file) after `n` files took `observedS` against a
 * prediction of `predictedS`. Samples and the result are clamped so one stalled or instant file can't
 * swing the ETA far.
 */
export function nextRatio(ratio: number, observedS: number, predictedS: number, n = 1, alpha = EWMA_ALPHA): number {
  if (!(predictedS > 0) || !(observedS >= 0) || n <= 0) return ratio;
  const sample = Math.min(4, Math.max(0.25, observedS / predictedS));
  const a = 1 - (1 - alpha) ** n;
  return Math.min(3, Math.max(0.4, ratio + a * (sample - ratio)));
}

export interface EtaInput {
  phase: "downloading" | "processing";
  /** Predicted seconds for every file still missing (including the one in flight). */
  remainingS: number;
  /** Predicted seconds for the file in flight (the first missing one). */
  currentS: number;
  /** Seconds since the last file landed (or the first fetch started); null before the first fetch. */
  sinceMarkS: number | null;
  ratio: number;
  /** Seconds left on a rate-limit / retry wait. */
  waitS?: number;
  /** Seconds spent processing so far (processing phase). */
  processingS?: number;
}

/**
 * Seconds left: the speed-scaled prediction for the missing files, counting down smoothly while a file is
 * in flight (but never below the prediction for the files after it), plus the processing prior.
 */
export function etaSeconds(i: EtaInput): number {
  if (i.phase === "processing") return Math.max(1, PROCESSING_PRIOR_S - (i.processingS ?? 0));
  const all = i.ratio * i.remainingS;
  const afterCurrent = i.ratio * Math.max(0, i.remainingS - i.currentS);
  const download = i.sinceMarkS == null ? STARTUP_S + all : Math.max(afterCurrent, all - i.sinceMarkS);
  return Math.max(1, download + (i.waitS ?? 0) + PROCESSING_PRIOR_S);
}

/** 0-1 progress weighted by predicted seconds, consistent with the ETA. */
export function progressOf(i: { totalS: number; remainingS: number; currentS: number; inFlight: number; processingS?: number; phase: string }): number {
  if (i.phase === "done") return 1;
  const total = i.totalS + PROCESSING_PRIOR_S;
  if (!(total > 0)) return 0;
  let done = i.totalS - i.remainingS + Math.min(0.95, Math.max(0, i.inFlight)) * i.currentS;
  if (i.phase === "processing") done = i.totalS + Math.min(0.95 * PROCESSING_PRIOR_S, i.processingS ?? 0);
  return Math.min(0.99, Math.max(0, done / total));
}

// ---------------------------------------------------------------- log lines

export type LogEvent =
  | { kind: "fetch"; endpoint: string; params: Record<string, string> }
  | { kind: "retry"; status: number; endpoint: string; seconds: number }
  | { kind: "circuit-unavailable" };

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

/** Parse ingest's progress output (`  fetching laps session_key=1`, `  429 on laps, retrying in 10s`). */
export function parseLogLine(raw: string): LogEvent | null {
  const line = raw.replace(ANSI, "").trim();
  let m = /^fetching circuit info\b/.exec(line);
  if (m) return { kind: "fetch", endpoint: "circuit", params: {} };
  m = /^fetching (\w+)((?: \w+=\S*)*)$/.exec(line);
  if (m) {
    const params: Record<string, string> = {};
    for (const kv of m[2].trim().split(" ").filter(Boolean)) {
      const eq = kv.indexOf("=");
      params[kv.slice(0, eq)] = kv.slice(eq + 1);
    }
    return { kind: "fetch", endpoint: m[1], params };
  }
  m = /^(\d{3}) on (\w+), retrying in ([\d.]+)s$/.exec(line);
  if (m) return { kind: "retry", status: Number(m[1]), endpoint: m[2], seconds: Number(m[3]) };
  if (/^circuit info unavailable\b/.test(line)) return { kind: "circuit-unavailable" };
  return null;
}

/** Cache file (without .json.gz) a fetch writes: `car_data` + driver 44 -> `car_data_44`, `meetings` -> `meeting`. */
export function fileForFetch(endpoint: string, params: Record<string, string>): string {
  if (endpoint === "meetings") return "meeting";
  return params.driver_number ? `${endpoint}_${params.driver_number}` : endpoint;
}

const STEP_LABELS: Record<string, string> = {
  sessions: "Session info",
  meetings: "Meeting info",
  circuit: "Circuit map",
  drivers: "Drivers",
  laps: "Lap times",
  stints: "Tyre stints",
  pit: "Pit stops",
  position: "Positions",
  intervals: "Gaps & intervals",
  race_control: "Race control",
  weather: "Weather",
  team_radio: "Team radio",
  overtakes: "Overtakes",
  session_result: "Results",
  car_data: "Car telemetry",
  location: "Track positions",
};

/** Human label for a fetch: "Lap times", "Car telemetry · #44 (12/22)". */
export function stepLabel(endpoint: string, params: Record<string, string>, drivers: number[] | null): string {
  const base = STEP_LABELS[endpoint] ?? endpoint.replace(/_/g, " ");
  const n = params.driver_number;
  if (!n) return base;
  const i = drivers?.indexOf(Number(n)) ?? -1;
  return i >= 0 ? `${base} · #${n} (${i + 1}/${drivers!.length})` : `${base} · #${n}`;
}

export function retryNotice(status: number, seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  return status === 429 ? `Rate-limited, retrying in ${s}s` : `OpenF1 error ${status}, retrying in ${s}s`;
}

/** Strip anything credential-shaped from a message shown in the browser, and cap its length. */
export function sanitize(text: string, max = 200): string {
  const clean = text
    .replace(ANSI, "")
    .replace(/\b(Bearer|Basic)\s+[\w.~+/=-]+/gi, "$1 [redacted]")
    .replace(/\b(access_token|refresh_token|token|password|passwd|username|secret|api_key|apikey)(["']?\s*[:=]\s*["']?)[^\s"'&,}]+/gi, "$1$2[redacted]")
    .replace(/\bOPENF1_\w+=\S+/g, "[redacted]")
    .trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** The thrown error's message from Bun's uncaught-error output (last one wins), else the last line. */
export function errorFromStderr(lines: string[], code: number | null): string {
  const cleaned = lines.map((l) => l.replace(ANSI, "").trim()).filter(Boolean);
  for (let i = cleaned.length - 1; i >= 0; i--) {
    const m = /^(?:\w*Error|error)(?: \[\w+\])?: (.+)$/.exec(cleaned[i]);
    if (m) return sanitize(m[1]);
  }
  const last = cleaned.filter((l) => !/^Bun v\d/.test(l) && !/^at\s/.test(l) && !/^\d+ \|/.test(l) && l !== "^").at(-1);
  return sanitize(last ?? `ingest exited with code ${code}`);
}
