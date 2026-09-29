// Dev-server race downloader: a Vite plugin serving /api/ingest for the in-app race picker.
//
//   GET    /api/ingest/races?year=YYYY   ingestible sessions of a season, with download status + estimate
//   GET    /api/ingest/jobs              every download job's state and progress
//   POST   /api/ingest/jobs/:key         queue a download (idempotent); also resumes a paused/failed one
//   DELETE /api/ingest/jobs/:key         cancel a queued job or stop a running one (cached files are kept)
//
// Vite runs under node, so everything Bun / OpenF1 runs as a child process (`bun scripts/sessions-json.ts`,
// `bun scripts/ingest.ts <key>`): credentials stay in those processes and never reach the browser.
// One ingest runs at a time (OpenF1's rate limit is per client); progress comes from polling the raw cache
// directory, which ingest writes atomically, one file per request.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statfsSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { gunzipSync } from "node:zlib";
import type { Plugin } from "vite";
import type { JobPhase, JobView, RaceRow, RaceStatus, RacesResponse, Tier } from "../src/data/ingestTypes.ts";
import {
  errorFromStderr,
  estimate,
  etaSeconds,
  expectedBytes,
  fileForFetch,
  fileSeconds,
  nextRatio,
  parseLogLine,
  progressOf,
  retryNotice,
  sanitize,
  sizeScale,
  stepLabel,
  type RawFileSpec,
} from "./ingestCore.ts";

/**
 * OpenF1 session types the app can ingest: "Race" covers sprints, "Qualifying" covers sprint qualifying and
 * shootouts (session_name tells them apart).
 */
export const INGESTIBLE_TYPES = ["Race", "Qualifying"];
export const FIRST_YEAR = 2023;

const CURRENT_YEAR_TTL_MS = 10 * 60_000;
const MAX_QUEUE = 30;
const POLL_MS = 500;
/** Delays before automatic retries of a failed ingest (reusing the cache). */
const RETRY_DELAYS_S = [10, 30];
/** No new fetch this long after the last requested file landed: ingest has moved on to processing. */
const QUIET_MS = 3_000;
const MIN_FREE_BYTES = 1e9;
const KEEP_FINISHED = 50;

// ---------------------------------------------------------------- expected raw files

// Files scripts/ingest.ts writes to data/raw/<key>/, in request order. Sizes are gzipped, for a 2-hour window.
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

/** Drivers assumed before drivers.json is cached: 22 from 2026 (11 teams), 20 before. */
export const assumedDrivers = (year: number) => (year >= 2026 ? 22 : 20);

/**
 * Raw cache files ingest writes for a session, in request order. Without the driver list (drivers.json not
 * cached yet) the per-driver files are placeholders for `assumed` drivers, named so they never match a file.
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
  /** Every required file is cached. */
  complete: boolean;
}

/**
 * Count cached files against the expected list. An optional file that's missing is only expected while no
 * later file is cached (ingest requests in order, so once a later one exists it was skipped).
 */
export function cacheProgress(expected: RawFileSpec[], cached: ReadonlyMap<string, { size: number }>): CacheProgress {
  let lastCached = -1;
  expected.forEach((f, i) => {
    if (cached.has(f.name)) lastCached = i;
  });
  const counted = expected.filter((f, i) => f.required || cached.has(f.name) || i > lastCached);
  const missing = counted.filter((f) => !cached.has(f.name));
  let cachedBytes = 0;
  for (const { size } of cached.values()) cachedBytes += size;
  return {
    cachedFiles: counted.length - missing.length,
    expectedFiles: counted.length,
    cachedBytes,
    missing,
    counted,
    complete: missing.every((f) => !f.required),
  };
}

// ---------------------------------------------------------------- disk

interface CachedFile {
  size: number;
  mtimeMs: number;
}

/** data/raw/<key>: cache name (no extension) -> size / mtime. `.json.gz`, or a legacy plain `.json`; `.tmp` ignored. */
function scanRaw(dir: string): Map<string, CachedFile> {
  const out = new Map<string, CachedFile>();
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const file of names) {
    const m = /^(.+)\.json(\.gz)?$/.exec(file);
    if (!m || (!m[2] && out.has(m[1]))) continue;
    try {
      const st = statSync(join(dir, file));
      if (st.isFile()) out.set(m[1], { size: st.size, mtimeMs: st.mtimeMs });
    } catch {
      // Renamed / removed between readdir and stat.
    }
  }
  return out;
}

/** Driver numbers from a cached drivers.json(.gz), sorted as ingest requests them; null if not cached yet. */
function readDrivers(dir: string): number[] | null {
  try {
    const gz = join(dir, "drivers.json.gz");
    const text = existsSync(gz) ? gunzipSync(readFileSync(gz)).toString("utf8") : readFileSync(join(dir, "drivers.json"), "utf8");
    const rows = JSON.parse(text) as { driver_number: number }[];
    return [...new Set(rows.map((d) => d.driver_number))].sort((a, b) => a - b);
  } catch {
    return null;
  }
}

function readIndexKeys(root: string): Set<number> {
  try {
    const index = JSON.parse(readFileSync(join(root, "public/sessions/index.json"), "utf8")) as { sessionKey: number }[];
    return new Set(index.map((e) => e.sessionKey));
  } catch {
    return new Set();
  }
}

// ---------------------------------------------------------------- listings

interface ListedSession {
  session_key: number;
  session_name: string;
  session_type: string;
  meeting_key: number;
  meeting_name: string;
  date_start: string;
  date_end: string;
  circuit_short_name: string;
  country_name: string;
  location: string;
  is_cancelled: boolean;
}

interface Listing {
  at: number;
  tier: Tier;
  sessions: ListedSession[];
}

/** Run `bun <args>` in the repo root, collecting output. */
function runBun(root: string, args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((done, fail) => {
    const child = spawn("bun", ["--preload", join(root, "devserver/orphanGuard.ts"), ...args], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c));
    child.stderr.on("data", (c: Buffer) => (stderr += c));
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.on("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      fail(new Error(e.code === "ENOENT" ? "bun not found on PATH" : e.message));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ code, stdout, stderr });
    });
  });
}

// ---------------------------------------------------------------- jobs

interface Job {
  key: number;
  year: number;
  type: string;
  label: string;
  scale: number;
  assumed: number;
  dir: string;
  phase: JobPhase;
  attempt: number;
  startedAt: number | null;
  finishedAt: number | null;
  error: string | null;
  /** Cache files present when the job was queued (for bytesThisRun). */
  initial: Set<string>;
  drivers: number[] | null;
  cached: Map<string, CachedFile>;

  child: ChildProcess | null;
  poll: ReturnType<typeof setInterval> | null;
  /** Pending automatic retry after a failed run. */
  retryTimer: ReturnType<typeof setTimeout> | null;
  retryAt: number | null;
  cancelRequested: boolean;
  /** POSTed again while a cancelled child was still exiting: re-queue once it's gone. */
  requeue: boolean;

  // Per run.
  /** When the last file landed (its mtime) or the first fetch started. */
  mark: number | null;
  /** Rate-limit waits since the mark (ms), and when the current one ends. */
  waitMs: number;
  waitUntil: number;
  retryStatus: number | null;
  lastFetch: { file: string; at: number } | null;
  step: string | null;
  processingAt: number | null;
  stderrTail: string[];
}

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return null; // e.g. "null" from sandboxed frames
  }
};

/** Errors a retry can't fix. */
const PERMANENT = /rejected the credentials|not found|only races|usage:|Low disk space/i;

function createIngest(root: string, log: (msg: string) => void) {
  const rawDir = (key: number) => join(root, "data/raw", String(key));
  const listings = new Map<number, Listing>();
  const listingRequests = new Map<number, Promise<Listing>>();
  /** Every session seen in a listing: POSTed keys must be one of these. */
  const known = new Map<number, ListedSession & { year: number }>();
  const driverCache = new Map<number, number[]>();
  const jobs = new Map<number, Job>();
  const queue: number[] = [];
  let active: Job | null = null;
  let tier: Tier | null = null;
  /** Observed / predicted seconds per file, carried from job to job (starts each job's EWMA). */
  let speed = 1;
  let closed = false;

  const drivers = (key: number): number[] | null => {
    const hit = driverCache.get(key);
    if (hit) return hit;
    const found = readDrivers(rawDir(key));
    if (found) driverCache.set(key, found);
    return found;
  };

  // ---------------------------------------------------------------- listing

  async function fetchListing(year: number): Promise<Listing> {
    const { code, stdout, stderr } = await runBun(root, ["scripts/sessions-json.ts", String(year)], 90_000);
    if (code !== 0) throw new Error(`Couldn't list ${year} sessions from OpenF1: ${errorFromStderr(stderr.split("\n"), code)}`);
    const body = JSON.parse(stdout) as { tier: Tier; sessions: ListedSession[] };
    for (const s of body.sessions) known.set(s.session_key, { ...s, year });
    tier = body.tier;
    return { at: Date.now(), tier: body.tier, sessions: body.sessions };
  }

  function listing(year: number): Promise<Listing> {
    const hit = listings.get(year);
    const fresh = hit && (year < new Date().getUTCFullYear() || Date.now() - hit.at < CURRENT_YEAR_TTL_MS);
    if (hit && fresh) return Promise.resolve(hit);
    let req = listingRequests.get(year);
    if (!req) {
      req = fetchListing(year)
        .then((l) => (listings.set(year, l), l))
        .finally(() => listingRequests.delete(year));
      listingRequests.set(year, req);
    }
    return req;
  }

  function rowStatus(s: ListedSession, t: Tier, indexKeys: Set<number>, now: number): Pick<RaceRow, "status" | "cachedFiles" | "expectedFiles" | "cachedBytes" | "estimate"> {
    if (s.is_cancelled) return { status: "cancelled" };
    if (Date.parse(s.date_end) > now) return { status: "not-run" };
    const key = s.session_key;
    if (indexKeys.has(key) && existsSync(join(root, "public/sessions", String(key), "meta.json"))) return { status: "ready" };
    const cached = scanRaw(rawDir(key));
    const year = Number(s.date_start.slice(0, 4));
    const p = cacheProgress(expectedRawFiles(s.session_type, cached.has("drivers") ? drivers(key) : null, assumedDrivers(year)), cached);
    const status: RaceStatus = p.cachedFiles > 0 ? "partial" : "none";
    return {
      status,
      ...(status === "partial" ? { cachedFiles: p.cachedFiles, expectedFiles: p.expectedFiles, cachedBytes: p.cachedBytes } : {}),
      estimate: estimate(p.missing, t, sizeScale(s.date_start, s.date_end), speed),
    };
  }

  async function races(year: number): Promise<RacesResponse> {
    const l = await listing(year);
    // Championship rounds: meetings with a race that went ahead, in date order.
    const firstRace = new Map<number, string>();
    for (const s of l.sessions) {
      if (s.session_type !== "Race" || s.is_cancelled) continue;
      const prev = firstRace.get(s.meeting_key);
      if (!prev || s.date_start < prev) firstRace.set(s.meeting_key, s.date_start);
    }
    const round = new Map([...firstRace].sort((a, b) => a[1].localeCompare(b[1])).map(([m], i) => [m, i + 1]));
    const indexKeys = readIndexKeys(root);
    const now = Date.now();
    const rows = l.sessions
      .filter((s) => INGESTIBLE_TYPES.includes(s.session_type))
      .sort((a, b) => a.date_start.localeCompare(b.date_start))
      .map(
        (s): RaceRow => ({
          sessionKey: s.session_key,
          sessionName: s.session_name,
          sessionType: s.session_type,
          meetingKey: s.meeting_key,
          meetingName: s.meeting_name,
          round: s.is_cancelled ? null : (round.get(s.meeting_key) ?? null),
          dateStart: s.date_start,
          dateEnd: s.date_end,
          circuit: s.circuit_short_name,
          country: s.country_name,
          location: s.location,
          ...rowStatus(s, l.tier, indexKeys, now),
        }),
      );
    return { year, tier: l.tier, rows };
  }

  // ---------------------------------------------------------------- job progress

  function progressOfJob(job: Job, cached = job.cached) {
    const t = tier ?? "free";
    const expected = expectedRawFiles(job.type, job.drivers, job.assumed);
    const p = cacheProgress(expected, cached);
    const secs = (f: RawFileSpec) => fileSeconds(f, t, job.scale);
    const remainingS = p.missing.reduce((s, f) => s + secs(f), 0);
    const currentS = p.missing[0] ? secs(p.missing[0]) : 0;
    const totalS = p.counted.reduce((s, f) => s + secs(f), 0);
    const missingBytes = p.missing.reduce((s, f) => s + expectedBytes(f, job.scale), 0);
    return { ...p, expected, remainingS, currentS, totalS, missingBytes };
  }

  /** Scan the cache: feed newly landed files into the speed EWMA, advance the phase. */
  function pollJob(job: Job) {
    const now = Date.now();
    const cached = scanRaw(job.dir);
    if (!job.drivers && cached.has("drivers")) job.drivers = drivers(job.key);
    const specs = new Map(expectedRawFiles(job.type, job.drivers, job.assumed).map((f) => [f.name, f]));
    const landed = [...cached].filter(([name]) => !job.cached.has(name)).sort((a, b) => a[1].mtimeMs - b[1].mtimeMs);
    for (const [name, f] of landed) {
      const spec = specs.get(name);
      // The circuit map isn't an OpenF1 request: not representative of the rest.
      if (spec && !spec.external && job.mark != null && f.mtimeMs >= job.mark) {
        const observed = Math.max(0, f.mtimeMs - job.mark - job.waitMs) / 1000;
        speed = nextRatio(speed, observed, fileSeconds(spec, tier ?? "free", job.scale));
      }
      job.mark = Math.max(job.mark ?? 0, f.mtimeMs);
      job.waitMs = 0;
      job.retryStatus = null;
    }
    job.cached = cached;

    if (job.phase !== "downloading") return;
    const p = progressOfJob(job);
    const lastLanded = job.lastFetch && cached.has(job.lastFetch.file);
    const quiet = job.lastFetch && now - Math.max(job.lastFetch.at, job.mark ?? 0) > QUIET_MS && now > job.waitUntil;
    if (p.complete || (lastLanded && quiet)) {
      job.phase = "processing";
      job.processingAt = now;
      job.step = "Processing race data";
    }
  }

  function onLine(job: Job, line: string, stderr: boolean) {
    if (stderr) {
      job.stderrTail.push(line);
      if (job.stderrTail.length > 40) job.stderrTail.shift();
    }
    const ev = parseLogLine(line);
    if (!ev) return;
    const now = Date.now();
    if (ev.kind === "fetch") {
      job.lastFetch = { file: fileForFetch(ev.endpoint, ev.params), at: now };
      if (!job.drivers && ev.endpoint === "car_data") job.drivers = drivers(job.key);
      job.step = stepLabel(ev.endpoint, ev.params, job.drivers);
      job.mark ??= now;
      job.retryStatus = null;
      if (job.phase === "processing") {
        job.phase = "downloading";
        job.processingAt = null;
      }
    } else if (ev.kind === "retry") {
      job.retryStatus = ev.status;
      job.waitMs += ev.seconds * 1000;
      job.waitUntil = now + ev.seconds * 1000;
    }
  }

  // ---------------------------------------------------------------- runner

  function freeBytes(): number {
    try {
      const s = statfsSync(root);
      return s.bavail * s.bsize;
    } catch {
      return Infinity;
    }
  }

  function finish(job: Job, phase: "done" | "failed" | "cancelled", error: string | null = null) {
    job.phase = phase;
    job.error = error;
    job.finishedAt = Date.now();
    job.step = null;
    job.retryAt = null;
    if (active === job) active = null;
    const took = job.startedAt ? ` in ${Math.round((job.finishedAt - job.startedAt) / 1000)}s` : "";
    log(`[ingest] ${job.key} ${job.label}: ${phase}${took}${error ? ` (${error})` : ""}`);
    // Forget old finished jobs.
    const finished = [...jobs.values()].filter((j) => j.finishedAt != null).sort((a, b) => a.finishedAt! - b.finishedAt!);
    for (const j of finished.slice(0, Math.max(0, finished.length - KEEP_FINISHED))) jobs.delete(j.key);
    pump();
  }

  function startRun(job: Job) {
    job.retryTimer = null;
    job.retryAt = null;
    if (freeBytes() < MIN_FREE_BYTES) {
      finish(job, "failed", `Low disk space (${(freeBytes() / 1e9).toFixed(2)} GB free); a race needs ~30 MB, keep 1 GB free`);
      return;
    }
    Object.assign(job, { mark: null, waitMs: 0, waitUntil: 0, retryStatus: null, lastFetch: null, processingAt: null, stderrTail: [] });
    job.phase = "downloading";
    job.step = "Starting";
    job.startedAt ??= Date.now();
    job.cached = scanRaw(job.dir);
    job.drivers ??= job.cached.has("drivers") ? drivers(job.key) : null;
    log(`[ingest] ${job.key} ${job.label}: ${job.attempt > 1 ? `retry ${job.attempt - 1}` : "start"} (${job.cached.size} files cached)`);

    const child = spawn("bun", ["--preload", join(root, "devserver/orphanGuard.ts"), "scripts/ingest.ts", String(job.key)], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1" },
    });
    job.child = child;
    createInterface({ input: child.stdout! }).on("line", (l) => onLine(job, l, false));
    createInterface({ input: child.stderr! }).on("line", (l) => onLine(job, l, true));
    job.poll = setInterval(() => pollJob(job), POLL_MS);

    let settled = false;
    const exited = (code: number | null, spawnError?: string) => {
      if (settled) return;
      settled = true;
      clearInterval(job.poll!);
      job.poll = null;
      job.child = null;
      pollJob(job);
      if (job.requeue) {
        job.requeue = false;
        job.cancelRequested = false;
        if (active === job) active = null;
        enqueueJob(job, true);
        return;
      }
      if (job.cancelRequested || closed) return finish(job, "cancelled");
      if (code === 0) return finish(job, "done");
      const error = spawnError ?? errorFromStderr(job.stderrTail, code);
      const delay = RETRY_DELAYS_S[job.attempt - 1];
      if (delay == null || PERMANENT.test(error)) return finish(job, "failed", error);
      // Retry from the cache after a pause (OpenF1 hiccups, rate limits, network drops).
      job.error = error;
      job.step = null;
      job.retryAt = Date.now() + delay * 1000;
      job.retryTimer = setTimeout(() => {
        job.attempt++;
        job.error = null;
        startRun(job);
      }, delay * 1000);
    };
    child.on("error", (e: NodeJS.ErrnoException) => exited(null, e.code === "ENOENT" ? "bun not found on PATH" : sanitize(e.message)));
    child.on("close", (code) => exited(code));
  }

  function pump() {
    if (active || closed) return;
    const key = queue.shift();
    if (key == null) return;
    active = jobs.get(key)!;
    startRun(active);
  }

  function enqueueJob(job: Job, front = false) {
    job.phase = "queued";
    if (front) queue.unshift(job.key);
    else queue.push(job.key);
    pump();
  }

  function newJob(s: ListedSession & { year: number }): Job {
    const dir = rawDir(s.session_key);
    const cached = scanRaw(dir);
    return {
      key: s.session_key,
      year: s.year,
      type: s.session_type,
      label: `${s.meeting_name} · ${s.session_name}`,
      scale: sizeScale(s.date_start, s.date_end),
      assumed: assumedDrivers(s.year),
      dir,
      phase: "queued",
      attempt: 1,
      startedAt: null,
      finishedAt: null,
      error: null,
      initial: new Set(cached.keys()),
      drivers: cached.has("drivers") ? drivers(s.session_key) : null,
      cached,
      child: null,
      poll: null,
      retryTimer: null,
      retryAt: null,
      cancelRequested: false,
      requeue: false,
      mark: null,
      waitMs: 0,
      waitUntil: 0,
      retryStatus: null,
      lastFetch: null,
      step: null,
      processingAt: null,
      stderrTail: [],
    };
  }

  class HttpError extends Error {
    constructor(
      readonly status: number,
      message: string,
    ) {
      super(message);
    }
  }

  async function enqueue(key: number, year: number | null): Promise<Job> {
    if (!known.has(key) && year != null) await listing(year).catch(() => null);
    const s = known.get(key);
    if (!s) throw new HttpError(404, `Unknown session ${key}; list its season first`);
    if (!INGESTIBLE_TYPES.includes(s.session_type)) throw new HttpError(400, `Session ${key} is ${s.session_name}; only ${INGESTIBLE_TYPES.join(", ")} sessions can be downloaded`);
    if (s.is_cancelled) throw new HttpError(400, `Session ${key} was cancelled`);
    if (Date.parse(s.date_end) > Date.now()) throw new HttpError(400, `Session ${key} hasn't finished yet`);

    const existing = jobs.get(key);
    if (existing && (existing.phase === "queued" || existing.phase === "downloading" || existing.phase === "processing")) {
      // Stopping but not gone yet: run again once it has exited, never alongside.
      if (existing.cancelRequested) existing.requeue = true;
      return existing;
    }
    if (queue.length >= MAX_QUEUE) throw new HttpError(429, `The download queue is full (${MAX_QUEUE})`);
    const job = newJob(s);
    jobs.set(key, job);
    enqueueJob(job);
    return job;
  }

  function cancel(key: number): Job {
    const job = jobs.get(key);
    if (!job) throw new HttpError(404, `No download for session ${key}`);
    job.requeue = false;
    if (job.phase === "queued") {
      queue.splice(queue.indexOf(key), 1);
      finish(job, "cancelled");
    } else if (job.child) {
      job.cancelRequested = true;
      const child = job.child;
      child.kill("SIGTERM");
      setTimeout(() => child.exitCode == null && child.signalCode == null && child.kill("SIGKILL"), 5_000).unref();
    } else if (job.retryTimer) {
      clearTimeout(job.retryTimer);
      job.retryTimer = null;
      finish(job, "cancelled");
    }
    return job;
  }

  function view(job: Job): JobView {
    const now = Date.now();
    const running = job.phase === "downloading" || job.phase === "processing";
    const cached = job.child ? job.cached : scanRaw(job.dir);
    const drv = job.drivers ?? (cached.has("drivers") ? drivers(job.key) : null);
    const p = progressOfJob({ ...job, drivers: drv }, cached);
    let bytesThisRun = 0;
    for (const [name, f] of cached) if (!job.initial.has(name)) bytesThisRun += f.size;

    let eta: number | null = null;
    let notice: string | null = null;
    if (running) {
      const waitS = Math.max(0, job.waitUntil - now) / 1000;
      const retryS = job.retryAt ? Math.max(0, job.retryAt - now) / 1000 : 0;
      // Time since the last file landed, not counting rate-limit waits already sat out.
      const sinceMarkS = job.mark == null ? null : Math.max(0, now - job.mark - (job.waitMs - waitS * 1000)) / 1000;
      eta =
        job.phase === "processing"
          ? etaSeconds({ phase: "processing", remainingS: 0, currentS: 0, sinceMarkS, ratio: speed, processingS: (now - (job.processingAt ?? now)) / 1000 })
          : etaSeconds({ phase: "downloading", remainingS: p.remainingS, currentS: p.currentS, sinceMarkS, ratio: speed, waitS: waitS + retryS });
      eta = Math.round(eta);
      if (job.retryAt) notice = `Ingest failed (${job.error}); retrying in ${Math.ceil(retryS)}s (attempt ${job.attempt + 1} of ${RETRY_DELAYS_S.length + 1})`;
      else if (job.retryStatus != null && waitS > 0) notice = retryNotice(job.retryStatus, waitS);
    }
    const inFlight = job.mark != null && p.currentS > 0 ? (now - job.mark) / 1000 / (speed * p.currentS) : 0;
    return {
      key: job.key,
      year: job.year,
      label: job.label,
      phase: job.phase,
      queuePosition: job.phase === "queued" ? queue.indexOf(job.key) + 1 : null,
      attempt: job.attempt,
      cachedFiles: p.cachedFiles,
      expectedFiles: p.expectedFiles,
      cachedBytes: p.cachedBytes,
      bytesThisRun,
      totalBytes: Math.round(p.cachedBytes + p.missingBytes),
      step: running ? job.step : null,
      retryNotice: notice,
      progress: progressOf({
        phase: job.phase,
        totalS: p.totalS,
        remainingS: p.remainingS,
        currentS: p.currentS,
        inFlight: running && !job.retryAt ? inFlight : 0,
        processingS: job.processingAt ? (now - job.processingAt) / 1000 : 0,
      }),
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      etaSeconds: eta,
      error: job.phase === "failed" || job.phase === "cancelled" ? job.error : null,
    };
  }

  /** Stop everything (server closing): kill the running child, drop timers. */
  function shutdown() {
    if (closed) return;
    closed = true;
    queue.length = 0;
    for (const job of jobs.values()) {
      if (job.retryTimer) clearTimeout(job.retryTimer);
      if (job.poll) clearInterval(job.poll);
      job.child?.kill("SIGTERM");
    }
  }

  // ---------------------------------------------------------------- HTTP

  function send(res: ServerResponse, status: number, body: unknown) {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify(body));
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = req.method ?? "GET";
    try {
      // Browsers send Origin with POST / DELETE: refuse other sites (the dev server listens on the LAN).
      const origin = req.headers.origin;
      if (method !== "GET" && origin && hostOf(origin) !== req.headers.host) throw new HttpError(403, "Cross-origin request refused");

      if (path === "/races") {
        if (method !== "GET") throw new HttpError(405, "Method not allowed");
        const year = Number(url.searchParams.get("year"));
        const current = new Date().getUTCFullYear();
        if (!Number.isInteger(year) || year < FIRST_YEAR || year > current) throw new HttpError(400, `year must be ${FIRST_YEAR}-${current}`);
        return send(res, 200, await races(year));
      }
      if (path === "/jobs") {
        if (method !== "GET") throw new HttpError(405, "Method not allowed");
        return send(res, 200, { tier, jobs: [...jobs.values()].map(view) });
      }
      const m = /^\/jobs\/(\d{1,7})$/.exec(path);
      if (m) {
        const key = Number(m[1]);
        const yearParam = Number(url.searchParams.get("year"));
        const year = Number.isInteger(yearParam) && yearParam >= FIRST_YEAR && yearParam <= new Date().getUTCFullYear() ? yearParam : null;
        if (method === "POST") return send(res, 202, view(await enqueue(key, year)));
        if (method === "DELETE") return send(res, 200, view(cancel(key)));
        throw new HttpError(405, "Method not allowed");
      }
      throw new HttpError(404, "Not found");
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message });
      send(res, 502, { error: sanitize(e instanceof Error ? e.message : String(e)) });
    }
  }

  return { handle, shutdown };
}

/** Serve /api/ingest from the dev server (`vite`); absent from `vite build` / `vite preview`. */
export function ingestPlugin(): Plugin {
  return {
    name: "f1-replay:ingest",
    apply: "serve",
    configureServer(server) {
      const root = resolve(server.config.root);
      const logger = server.config.logger;
      const api = createIngest(root, (msg) => logger.info(msg, { timestamp: true }));
      server.middlewares.use("/api/ingest", (req, res) => void api.handle(req, res));
      // Leave no ingest running once the server is gone (restart, Ctrl-C, SIGTERM).
      const onExit = () => api.shutdown();
      process.once("exit", onExit);
      server.httpServer?.once("close", () => {
        process.off("exit", onExit);
        api.shutdown();
      });
    },
  };
}
