// Cost model for downloading a session from OpenF1 in the browser: which raw files a download needs,
// how long each takes, and a live ETA that learns the actual speed. Pure (tested in eta.test.ts).

/** OpenF1 access tier. The browser only uses the free tier for now (no login). */
export type Tier = "sponsor" | "free";

/** Minimum gap between OpenF1 requests, from scripts/lib/openf1Http.ts. */
export const TIER_INTERVAL_S: Record<Tier, number> = { free: 2.2, sponsor: 1.1 };

// Time for one OpenF1 request (server query + transfer + parse + gzip + write) is roughly
// REQUEST_LATENCY_S + gzipped size × SECONDS_PER_BYTE; a request can't start sooner than the tier interval
// after the previous one. Fitted to real downloads: 2025 Australia race telemetry (334 KB avg) 2.45 s per
// file, 2025 China sprint (145 KB) 1.43 s; small files are interval-bound.
export const REQUEST_LATENCY_S = 0.64;
export const SECONDS_PER_BYTE = 5.4e-6;
/** Worker startup and reading what's already cached. */
export const STARTUP_S = 1;
/** Normalizing + writing a race in the browser (spike S1: ~5-10 s once the raw data is in memory). */
export const PROCESSING_PRIOR_S = 8;
/** Re-processing from the stored raw responses: reading them back (~7 s for a race) plus processing. */
export const REPROCESS_PRIOR_S = 15;
/** Reading stored raw responses back (gunzip + parse) when a download resumes: ~8 s for a race's 13 MB. */
export const CACHE_READ_S_PER_BYTE = 6e-7;

/** One raw file a download stores (raw/<key>/<name>.json.gz). */
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

// The files ingest (scripts/lib/ingestCore.ts) requests, in order. Sizes are gzipped, for a 2-hour window.
const SESSION_FILES: RawFileSpec[] = [
  { name: "sessions", required: true, bytes: 300 },
  { name: "meeting", required: true, bytes: 450 },
  { name: "circuit", required: false, external: true, bytes: 6_000 }, // MultiViewer; may be unavailable
  { name: "drivers", required: true, bytes: 1_600 },
  { name: "laps", required: true, bytes: 40_000, scales: true },
  { name: "stints", required: true, bytes: 550 },
  { name: "pit", required: true, bytes: 900 },
  { name: "position", required: true, bytes: 3_500 },
  { name: "intervals", required: true, bytes: 280_000, scales: true },
  { name: "race_control", required: true, bytes: 3_000 },
  { name: "weather", required: true, bytes: 2_700 },
  { name: "team_radio", required: true, bytes: 1_000 },
  { name: "overtakes", required: true, bytes: 2_700 },
  { name: "session_result", required: true, bytes: 450 },
];
const PER_DRIVER: RawFileSpec[] = [
  { name: "car_data", required: true, bytes: 295_000, scales: true },
  { name: "location", required: true, bytes: 325_000, scales: true },
];

const RAW_FILES: Record<string, { session: RawFileSpec[]; perDriver: RawFileSpec[] }> = {
  Race: { session: SESSION_FILES, perDriver: PER_DRIVER },
  // The same requests (and files) as a race; OpenF1 has no interval data outside races.
  Qualifying: {
    session: SESSION_FILES.map((f) => (f.name === "intervals" ? { ...f, bytes: 30, scales: false } : f)),
    perDriver: PER_DRIVER,
  },
};

/** Drivers assumed before drivers.json is in: 22 from 2026 (11 teams), 20 before. */
export const assumedDrivers = (year: number) => (year >= 2026 ? 22 : 20);

/**
 * Raw files a session needs, in request order. Without the driver list (drivers.json not stored yet) the
 * per-driver files are placeholders for `assumed` drivers, named so they never match a file.
 */
export function expectedRawFiles(type: string, driverNumbers: readonly number[] | null, assumed = 22): RawFileSpec[] {
  const { session, perDriver } = RAW_FILES[type] ?? RAW_FILES.Race;
  const numbers = driverNumbers ?? Array.from({ length: assumed }, (_, i) => `?${i + 1}`);
  return [...session, ...numbers.flatMap((n) => perDriver.map((f) => ({ ...f, name: `${f.name}_${n}` })))];
}

export interface CacheProgress {
  cachedFiles: number;
  expectedFiles: number;
  cachedBytes: number;
  /** Files still to fetch, in request order (optional files only while they may still come). */
  missing: RawFileSpec[];
  /** Expected files, as counted in expectedFiles. */
  counted: RawFileSpec[];
  /** Every required file is stored. */
  complete: boolean;
}

/**
 * Count stored files against the expected list. An optional file that's missing is only expected while no
 * later file is stored (ingest requests in order, so once a later one exists it was skipped).
 */
export function cacheProgress(expected: RawFileSpec[], cached: ReadonlyMap<string, number>): CacheProgress {
  let lastCached = -1;
  expected.forEach((f, i) => {
    if (cached.has(f.name)) lastCached = i;
  });
  const counted = expected.filter((f, i) => f.required || cached.has(f.name) || i > lastCached);
  const missing = counted.filter((f) => !cached.has(f.name));
  let cachedBytes = 0;
  for (const size of cached.values()) cachedBytes += size;
  return {
    cachedFiles: counted.length - missing.length,
    expectedFiles: counted.length,
    cachedBytes,
    missing,
    counted,
    complete: missing.every((f) => !f.required),
  };
}

/** Session window relative to a 2-hour race slot, clamped: sprints and qualifying are ~0.5. */
export function sizeScale(dateStart: string, dateEnd: string): number {
  const minutes = (Date.parse(dateEnd) - Date.parse(dateStart)) / 60_000;
  if (!Number.isFinite(minutes) || minutes <= 0) return 1;
  return Math.min(1.5, Math.max(0.25, minutes / 120));
}

export const expectedBytes = (f: RawFileSpec, scale: number) => (f.scales ? f.bytes * scale : f.bytes);

/** Expected seconds to fetch one file. */
export function fileSeconds(f: RawFileSpec, tier: Tier, scale: number): number {
  const work = REQUEST_LATENCY_S + expectedBytes(f, scale) * SECONDS_PER_BYTE;
  return f.external ? work : Math.max(TIER_INTERVAL_S[tier], work);
}

/**
 * Up-front estimate for downloading the missing files and processing; `ratio` is the observed / predicted
 * download speed learned from earlier downloads (1 = the priors above). `cachedBytes`: raw responses
 * already stored, read back instead of downloaded.
 */
export function estimate(
  missing: RawFileSpec[],
  tier: Tier,
  scale: number,
  ratio = 1,
  processingS = PROCESSING_PRIOR_S,
  cachedBytes = 0,
): { seconds: number; mb: number } {
  let download = 0;
  let bytes = 0;
  for (const f of missing) {
    download += fileSeconds(f, tier, scale);
    bytes += expectedBytes(f, scale);
  }
  const read = cachedBytes * CACHE_READ_S_PER_BYTE;
  return { seconds: Math.round(STARTUP_S + ratio * download + read + processingS), mb: Math.round(bytes / 1e5) / 10 };
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

/** Learned processing time: EWMA of observed seconds, clamped to a sane range. */
export function nextProcessingS(prev: number, observedS: number): number {
  if (!(observedS > 0)) return prev;
  return Math.min(120, Math.max(2, prev + 0.3 * (observedS - prev)));
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
  /** Expected processing time. */
  processingPriorS?: number;
}

/**
 * Seconds left: the speed-scaled prediction for the missing files, counting down smoothly while a file is
 * in flight (but never below the prediction for the files after it), plus processing.
 */
export function etaSeconds(i: EtaInput): number {
  const prior = i.processingPriorS ?? PROCESSING_PRIOR_S;
  if (i.phase === "processing") return Math.max(1, prior - (i.processingS ?? 0));
  const all = i.ratio * i.remainingS;
  const afterCurrent = i.ratio * Math.max(0, i.remainingS - i.currentS);
  const download = i.sinceMarkS == null ? STARTUP_S + all : Math.max(afterCurrent, all - i.sinceMarkS);
  return Math.max(1, download + (i.waitS ?? 0) + prior);
}

/** 0-1 progress weighted by predicted seconds, consistent with the ETA. */
export function progressOf(i: {
  totalS: number;
  remainingS: number;
  currentS: number;
  inFlight: number;
  processingS?: number;
  processingPriorS?: number;
  phase: string;
}): number {
  if (i.phase === "done") return 1;
  const prior = i.processingPriorS ?? PROCESSING_PRIOR_S;
  const total = i.totalS + prior;
  if (!(total > 0)) return 0;
  let done = i.totalS - i.remainingS + Math.min(0.95, Math.max(0, i.inFlight)) * i.currentS;
  if (i.phase === "processing") done = i.totalS + Math.min(0.95 * prior, i.processingS ?? 0);
  return Math.min(0.99, Math.max(0, done / total));
}

// ---------------------------------------------------------------- labels

/** Raw file a request fills: `car_data` + driver 44 -> `car_data_44`, `meetings` -> `meeting`. */
export function fileForFetch(endpoint: string, params: Record<string, string | number>): string {
  if (endpoint === "meetings") return "meeting";
  return params.driver_number != null ? `${endpoint}_${params.driver_number}` : endpoint;
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

/** Human label for a request: "Lap times", "Car telemetry · #44 (12/22)". */
export function stepLabel(endpoint: string, params: Record<string, string | number>, drivers: readonly number[] | null): string {
  const base = STEP_LABELS[endpoint] ?? endpoint.replace(/_/g, " ");
  const n = params.driver_number;
  if (n == null) return base;
  const i = drivers?.indexOf(Number(n)) ?? -1;
  return i >= 0 ? `${base} · #${n} (${i + 1}/${drivers!.length})` : `${base} · #${n}`;
}

export function retryNotice(status: number, seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  return status === 429 ? `Rate-limited by OpenF1, retrying in ${s}s` : `OpenF1 error ${status}, retrying in ${s}s`;
}
