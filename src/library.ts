// The race library: what's downloaded into this browser, the OpenF1 calendar, and the download queue.
// Downloads run one at a time in a worker (src/ingest/), guarded by a Web Lock so two tabs never download
// at once; the queue survives reloads of the tab (sessionStorage) and every run resumes from the raw
// responses already stored. Separate from the replay store: finished downloads are handed to it through
// useReplay.getState().loadIndex() / loadSession(). Watching a race that isn't downloaded (stream()) downloads
// it first in the queue, ahead of one running, and the replay store shows it as it comes in (openStream /
// streamUpdate), telling the download where it's watched (onStreamWatch) so the telemetry comes from there on.

import { create } from "zustand";
import { isCurrentFormat } from "../scripts/lib/formatVersion";
import { endBy, fetchEvidence, shouldProbe } from "../scripts/lib/liveness";
import { fetchEndpoint, LiveWindowError, seedRequestStarts, setRequestObserver } from "../scripts/lib/openf1Http";
import { FIRST_YEAR, isIngestible, LIVE_WINDOW_MARGIN_MS } from "../scripts/lib/season";
import type { RawMeeting, RawSession } from "../scripts/lib/openf1Types";
import { buildCatalog, catalogFresh, fetchCatalog, fetchSessionInfo, liveWindowNow, windowLabel, withCurrentRows, type Catalog, type CatalogRow, type Fetcher } from "./ingest/catalog";
import { assumedDrivers, cacheProgress, estimate, expectedRawFiles, layoutOf, placeholderFiles, sizeScale, type CacheProgress } from "./ingest/eta";
import type { FailureKind, FromWorker } from "./ingest/protocol";
import { choosePath } from "./ingest/vaultPort";
import { loadLearned, noteRequest, recentRequests, runJob, type JobInfo, type Progress, type RunHandle } from "./ingest/runner";
import { sessionStore, storageSupported, type LibraryEntry, type StorageUsage } from "./storage";
import { forgetSession } from "./storage/load";
import { clock, onStreamWatch, useReplay, type OpenOpts } from "./store";
import { getVault, type RestEndpoint } from "./vault/client";

export { FIRST_YEAR };
/** UTC, like OpenF1's `year`. */
export const currentYear = () => new Date().getUTCFullYear();
export const YEARS = Array.from({ length: currentYear() - FIRST_YEAR + 1 }, (_, i) => FIRST_YEAR + i);

/** Where to open a session once it's ready (from a shared link: time in ms, drivers, practice's screen). */
export type WatchOpts = OpenOpts;

export type JobPhase = "queued" | "paused" | "downloading" | "processing" | "done" | "failed" | "cancelled";

export interface Job {
  info: JobInfo;
  phase: JobPhase;
  /** While running. */
  progress: Progress | null;
  /** paused: when it's tried again. */
  resumeAt: number | null;
  /** Why it's paused. */
  notice: string | null;
  error: string | null;
  errorKind: FailureKind | "crashed" | null;
  attempt: number;
  finishedAt: number | null;
}

/** A download running in another tab (from its broadcasts). */
export interface RemoteJob {
  key: number;
  label: string;
  progress: Progress | null;
  at: number;
}

export interface YearState {
  catalog: Catalog | null;
  loading: boolean;
  error: string | null;
}

export interface Lookup {
  loading: boolean;
  row: CatalogRow | null;
  error: string | null;
}

/** Session types shown in the calendar: everything, races + sprints, (sprint) qualifying, or free practice. */
export type RaceFilter = "all" | "Race" | "Qualifying" | "Practice";

export const isActive = (phase: JobPhase) => phase === "queued" || phase === "paused" || phase === "downloading" || phase === "processing";
export const isRunning = (phase: JobPhase) => phase === "downloading" || phase === "processing";

interface PartialRaw {
  files: Record<string, number>;
  drivers: number[] | null;
  /** From the stored `sessions` / `meeting` responses, when they're there. */
  row: CatalogRow | null;
}

interface LibraryState {
  /** Browser storage (OPFS) is available. */
  supported: boolean;
  /** The library has been listed once. */
  ready: boolean;
  entries: Record<number, LibraryEntry>;
  /** Raw responses stored for sessions that aren't processed (interrupted downloads). */
  partial: Record<number, PartialRaw>;
  years: Record<number, YearState>;
  jobs: Record<number, Job>;
  /** Unfinished jobs in order (the running one first). */
  queue: number[];
  remote: Record<number, RemoteJob>;
  /** Waiting for another tab to finish its downloads (Web Lock held elsewhere). */
  otherTab: boolean;
  /**
   * Sessions OpenF1 shows running past their scheduled end (a delayed start, red flags): when they really end, ms
   * epoch. The calendars in `years` have it applied (extendCatalog).
   */
  overruns: Record<number, number>;
  /** OpenF1 refused us with its live-window lockout, until about then. */
  blocked: { until: number; label: string } | null;
  usage: StorageUsage | null;
  /** The season shown in Home's calendar. */
  calendarYear: number;
  filter: RaceFilter;
  confirmDelete: number | null;
  /** Open this session when its job is done. */
  watch: { key: number; opts: WatchOpts } | null;
  /** A shared link to a session that isn't in the library (yet). */
  link: { key: number; opts: WatchOpts } | null;
  lookups: Record<number, Lookup>;
  /** A download finished while a replay was on screen: offer to watch it. */
  toast: { key: number; label: string } | null;

  init: () => Promise<void>;
  refreshLibrary: () => Promise<void>;
  refreshUsage: () => Promise<void>;
  setCalendarYear: (year: number) => void;
  setFilter: (filter: RaceFilter) => void;
  loadYear: (year: number, opts?: { force?: boolean }) => Promise<void>;
  lookup: (key: number) => Promise<void>;
  setLink: (link: { key: number; opts: WatchOpts } | null) => void;
  reprocess: (entry: LibraryEntry, opts?: { watch?: WatchOpts }) => void;
  cancel: (key: number) => void;
  askDelete: (key: number | null) => void;
  remove: (key: number) => Promise<void>;
  setWatch: (key: number | null) => void;
  /** Open a downloaded session (useReplay's openSession). */
  watchNow: (key: number, opts?: WatchOpts) => void;
  /**
   * Watch a session: a downloaded one opens; otherwise it's downloaded now (first in the queue, ahead of a download
   * that's running, which carries on after) and watched while it comes in.
   */
  stream: (row: CatalogRow, opts?: WatchOpts) => void;
  dismissToast: () => void;
}

// ---------------------------------------------------------------- helpers

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const LOCK = "f1-replay:downloads";
const QUEUE_KEY = "f1-replay:queue";
/** Automatic retries of a failed download (network drop, OpenF1 hiccup), from what's stored. */
const RETRY_DELAYS_S = [10, 30];
const WATCHED_RETRY_DELAYS_S = [3, 10, 30];
/** How long to wait before trying again after a live-window refusal we can't place on the calendar. */
const BLOCKED_RECHECK_MS = 10 * 60_000;
const PERMANENT = /not found|only races|isn't stored/i;

const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("f1-replay:library") : null;
type Broadcast = { type: "changed" } | { type: "progress"; key: number; label: string; progress: Progress | null } | { type: "ended"; key: number };
const broadcast = (m: Broadcast) => channel?.postMessage(m);

export const labelOf = (r: { meetingName: string; sessionName: string }) => `${r.meetingName} · ${r.sessionName}`;

export function jobInfo(row: CatalogRow, mode: JobInfo["mode"]): JobInfo {
  return { key: row.sessionKey, label: labelOf(row), sessionType: row.sessionType, year: row.year, dateStart: row.dateStart, dateEnd: row.dateEnd, mode };
}

/** A session's slot when only its start is known: practice is an hour, the rest are given two. */
const slotMs = (sessionType: string) => (sessionType === "Practice" ? 1 : 2) * 3600_000;

function entryInfo(e: LibraryEntry): JobInfo {
  const end = new Date(Date.parse(e.dateStart) + slotMs(e.sessionType)).toISOString();
  return { key: e.sessionKey, label: labelOf(e), sessionType: e.sessionType, year: e.year, dateStart: e.dateStart, dateEnd: end, mode: "reprocess" };
}

const newJob = (info: JobInfo): Job => ({
  info,
  phase: "queued",
  progress: null,
  resumeAt: null,
  notice: null,
  error: null,
  errorKind: null,
  attempt: 1,
  finishedAt: null,
});

/** A download paused for a live window says so. */
const LIVE_WINDOW_NOTICE = "OpenF1 blocks free downloads during live sessions";

/** Signed in to the vault with a token that works: downloads go through it, live windows or not (src/ingest/vaultPort.ts). */
const signedIn = () => choosePath(getVault().getState().status ?? null).path === "vault";

/**
 * The page's own OpenF1 reads (the calendar, link lookups): through the vault when signed in (OpenF1 refuses browsers
 * without a token during live sessions, and the vault's reads get through: vault/proxy.ts), else straight to OpenF1.
 */
async function openf1Get(): Promise<Fetcher> {
  if (!(await signedInSoon())) return fetchEndpoint;
  return async <T,>(endpoint: string, params: Record<string, string | number>): Promise<T[]> => {
    const r = await getVault().get(endpoint as RestEndpoint, params);
    if (r.status === 404) return [];
    if (r.status !== 200) throw new Error(`OpenF1 ${r.status} for ${endpoint} (through the vault)`);
    return JSON.parse(new TextDecoder().decode(r.body)) as T[];
  };
}

/** How long the page's first reads wait for the vault to say whether it's signed in (its frame loading, a login restoring). */
const VAULT_SETTLE_MS = 4_000;

/** signedIn(), once the vault has said (at most VAULT_SETTLE_MS after the page loads). */
async function signedInSoon(): Promise<boolean> {
  const vault = getVault();
  if (!vault.origin) return false;
  void vault.start();
  const end = Date.now() + VAULT_SETTLE_MS;
  const unsettled = () => {
    const s = vault.getState();
    return s.phase !== "unavailable" && (!s.status || s.status.state === "connecting");
  };
  while (unsettled() && Date.now() < end) await sleep(100);
  return signedIn();
}

/** Catalogs as OpenF1 published them; the state's have `overruns` applied (extendCatalog). */
const rawCatalogs = new Map<number, Catalog>();

/** How often to ask OpenF1 whether a session is running past its scheduled end. */
const PROBE_MS = 60_000;

/** The catalog with sessions running late ending when they really do (the rows and the free tier's sessions alike). */
export function extendCatalog(c: Catalog, overruns: Record<number, number>): Catalog {
  const endOf = (key: number, scheduled: string) => {
    const end = overruns[key];
    return end != null && end > Date.parse(scheduled) ? new Date(end).toISOString() : scheduled;
  };
  if (!c.rows.some((r) => endOf(r.sessionKey, r.dateEnd) !== r.dateEnd)) return c;
  return {
    ...c,
    rows: c.rows.map((r) => ({ ...r, dateEnd: endOf(r.sessionKey, r.dateEnd) })),
    sessions: Array.isArray(c.sessions) ? c.sessions.map((s) => ({ ...s, date_end: endOf(s.session_key, s.date_end) })) : c.sessions,
  };
}

/** The live window we're in (from the calendar, or from OpenF1 refusing us), or null. */
export function liveWindowOf(s: Pick<LibraryState, "years" | "blocked">, now = Date.now()): { until: number; label: string } | null {
  const catalogs = Object.values(s.years).flatMap((y) => (y.catalog ? [y.catalog] : []));
  const w = liveWindowNow(catalogs, now);
  const fromCalendar = w ? { until: w.to, label: windowLabel(w, catalogs) } : null;
  const refused = s.blocked && s.blocked.until > now ? s.blocked : null;
  if (fromCalendar && refused) return fromCalendar.until >= refused.until ? fromCalendar : refused;
  return fromCalendar ?? refused;
}

// ---------------------------------------------------------------- row states

export type RowState =
  | { kind: "cancelled" }
  | { kind: "upcoming" }
  | { kind: "job"; job: Job; cache: CacheProgress | null }
  | { kind: "remote"; job: RemoteJob }
  | { kind: "ready"; entry: LibraryEntry }
  /** Processed by another version of the app: re-process from the stored raw data. */
  | { kind: "stale"; entry: LibraryEntry }
  | { kind: "partial"; cache: CacheProgress; estimate: { seconds: number; mb: number } }
  | { kind: "available"; estimate: { seconds: number; mb: number } };

const REMOTE_STALE_MS = 5_000;

function partialProgress(row: Pick<CatalogRow, "sessionType" | "year" | "dateStart" | "dateEnd">, p: PartialRaw | undefined): CacheProgress | null {
  if (!p || !Object.keys(p.files).length) return null;
  const files = new Map(Object.entries(p.files));
  const expected = expectedRawFiles(row.sessionType, p.drivers, assumedDrivers(row.year), layoutOf(files.keys()), sizeScale(row.dateStart, row.dateEnd));
  return cacheProgress(expected, placeholderFiles(files));
}

export function rowState(
  row: CatalogRow,
  s: Pick<LibraryState, "jobs" | "remote" | "entries" | "partial">,
  now = Date.now(),
  learned = loadLearned(),
): RowState {
  const key = row.sessionKey;
  const job = s.jobs[key];
  const partial = partialProgress(row, s.partial[key]);
  if (job && isActive(job.phase)) return { kind: "job", job, cache: partial };
  const remote = s.remote[key];
  if (remote && now - remote.at < REMOTE_STALE_MS) return { kind: "remote", job: remote };
  const entry = s.entries[key];
  if (entry) return isCurrentFormat(entry) ? { kind: "ready", entry } : { kind: "stale", entry };
  if (job?.phase === "failed") return { kind: "job", job, cache: partial };
  if (row.cancelled) return { kind: "cancelled" };
  if (Date.parse(row.dateEnd) > now) return { kind: "upcoming" };
  const scale = sizeScale(row.dateStart, row.dateEnd);
  if (partial && partial.cachedFiles > 0) {
    return { kind: "partial", cache: partial, estimate: estimate(partial.missing, "free", scale, learned.ratio, learned.processingS, partial.cachedBytes) };
  }
  const all = expectedRawFiles(row.sessionType, null, assumedDrivers(row.year), layoutOf([]), scale).filter((f) => f.required || !f.external);
  return { kind: "available", estimate: estimate(all, "free", scale, learned.ratio, learned.processingS) };
}

/** Everything known about a session, from the calendar, the library, a job or its stored raw data. */
export function rowForKey(key: number, s: Pick<LibraryState, "years" | "entries" | "partial" | "jobs">): CatalogRow | null {
  for (const y of Object.values(s.years)) {
    const row = y.catalog?.rows.find((r) => r.sessionKey === key);
    if (row) return row;
  }
  const e = s.entries[key];
  const info = s.jobs[key]?.info;
  const base = s.partial[key]?.row;
  if (base) return base;
  if (e)
    return {
      sessionKey: key,
      sessionName: e.sessionName,
      sessionType: e.sessionType,
      meetingKey: 0,
      meetingName: e.meetingName,
      round: null,
      year: e.year,
      dateStart: e.dateStart,
      dateEnd: new Date(Date.parse(e.dateStart) + slotMs(e.sessionType)).toISOString(),
      circuit: e.circuit,
      country: e.country,
      cancelled: false,
    };
  if (info) {
    const [meetingName, sessionName] = info.label.split(" · ");
    return {
      sessionKey: key,
      sessionName: sessionName ?? "",
      sessionType: info.sessionType,
      meetingKey: 0,
      meetingName: meetingName ?? info.label,
      round: null,
      year: info.year,
      dateStart: info.dateStart,
      dateEnd: info.dateEnd,
      circuit: "",
      country: "",
      cancelled: false,
    };
  }
  return null;
}

const gunzipJson = async <T,>(gz: Uint8Array<ArrayBuffer>): Promise<T> =>
  (await new Response(new Blob([gz]).stream().pipeThrough(new DecompressionStream("gzip"))).json()) as T;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- store

let initialized = false;
let running: { key: number; handle: RunHandle } | null = null;
/** The race being watched while it downloads, and where (ms since its t0), from the replay store. */
let watched: { key: number; t: number | null } | null = null;
let pumping = false;
let lockAbort: AbortController | null = null;
let resumeTimer: ReturnType<typeof setTimeout> | null = null;
let persistAsked = false;

/** Seasons being read or fetched, so asking twice makes one request. */
const loadingYears = new Map<number, Promise<void>>();

export const useLibrary = create<LibraryState>((set, get) => {
  /** A season into the state: kept as published, shown with sessions running late ending when they do. */
  const putYear = (year: number, y: YearState) => {
    if (y.catalog) rawCatalogs.set(year, y.catalog);
    else rawCatalogs.delete(year);
    set({ years: { ...get().years, [year]: { ...y, catalog: y.catalog && extendCatalog(y.catalog, get().overruns) } } });
  };

  let probing = false;
  /**
   * A session at or past its scheduled end: ask OpenF1 whether it's still running (a delayed start, red flags) and
   * keep `overruns`, and the calendars, saying when it really ends. One session at a time: the latest to have started.
   */
  const probeOverrun = async () => {
    if (probing) return;
    probing = true;
    try {
      const now = Date.now();
      const row = [...rawCatalogs.values()]
        .flatMap((c) => c.rows)
        .filter((r) => !r.cancelled && Date.parse(r.dateStart) <= now && shouldProbe(Date.parse(r.dateEnd), now))
        .sort((a, b) => b.dateStart.localeCompare(a.dateStart))[0];
      let overruns: Record<number, number> = {};
      if (row) {
        const evidence = await fetchEvidence(row.sessionKey, row.sessionType, now, await openf1Get());
        const end = endBy(Date.parse(row.dateEnd), evidence, now);
        if (end > Date.parse(row.dateEnd)) overruns = { [row.sessionKey]: end };
      }
      if (JSON.stringify(overruns) === JSON.stringify(get().overruns)) return;
      set({ overruns });
      const years = { ...get().years };
      for (const [year, c] of rawCatalogs) if (years[year]) years[year] = { ...years[year], catalog: extendCatalog(c, overruns) };
      set({ years });
    } catch (e) {
      // (The free tier refused: a session is on by the calendar anyway. Anything else: the next ask.)
      if (!(e instanceof LiveWindowError)) console.warn("asking OpenF1 whether the session is still running", e);
    } finally {
      probing = false;
    }
  };

  /** One season's calendar: from this browser when it's fresh enough, else from OpenF1 (and kept). */
  const loadYearOnce = async (year: number, force: boolean) => {
    const prev = get().years[year];
    const setYear = (y: YearState) => putYear(year, y);
    let catalog = rawCatalogs.get(year) ?? prev?.catalog ?? null;
    if (!catalog && get().supported) {
      const cached = await store().readDoc<Catalog>(`catalog-${year}`).catch(() => undefined);
      catalog = cached ? withCurrentRows(cached) : null;
    }
    if (catalog && catalogFresh(catalog) && !force) {
      setYear({ catalog, loading: false, error: null });
      void probeOverrun();
      return;
    }
    setYear({ catalog, loading: true, error: null });
    try {
      const fresh = await fetchCatalog(year, await openf1Get());
      if (get().supported) await store().writeDoc(`catalog-${year}`, fresh).catch(() => {});
      setYear({ catalog: fresh, loading: false, error: null });
      void probeOverrun();
    } catch (e) {
      let error = `Couldn't load the ${year} calendar from OpenF1 (${message(e)}).`;
      // (A browser without an account gets no answer at all during a session: a network error, not a 401.)
      if (!signedIn()) error += " During a live session OpenF1 blocks browsers without an account, from 30 minutes before it until 30 minutes after: try again then, or connect your OpenF1 account in Settings.";
      if (e instanceof LiveWindowError) {
        const w = liveWindowOf(get());
        set({ blocked: { until: w?.until ?? Date.now() + BLOCKED_RECHECK_MS, label: w?.label ?? "a live session" } });
        error = "OpenF1 is blocking free access while a session is live; the calendar loads again once it's over.";
      }
      setYear({ catalog, loading: false, error });
    }
  };
  const store = () => sessionStore();

  onStreamWatch((key, t) => {
    const before = watched;
    watched = key == null ? null : { key, t };
    if (!running) return;
    if (key != null && running.key === key) running.handle.send({ type: "watch", playhead: t });
    else if (before?.key === running.key) running.handle.send({ type: "unwatch" });
  });

  const setJob = (key: number, patch: Partial<Job>) => {
    const job = get().jobs[key];
    if (job) set({ jobs: { ...get().jobs, [key]: { ...job, ...patch } } });
  };

  const saveQueue = () => {
    try {
      const items = get()
        .queue.map((key) => get().jobs[key])
        .filter((j) => j && isActive(j.phase))
        .map((j) => ({ info: j.info, watch: get().watch?.key === j.info.key ? get().watch!.opts : null }));
      sessionStorage.setItem(QUEUE_KEY, JSON.stringify(items));
    } catch {}
  };

  const dequeue = (key: number) => {
    set({ queue: get().queue.filter((k) => k !== key) });
    saveQueue();
  };

  /**
   * The next job that can run now: queued, or paused with its wait over. Downloads wait out live windows, unless the
   * vault is signed in: its requests carry the account's token, through its pass-through while OpenF1 refuses
   * browsers (vault/proxy.ts).
   */
  const nextRunnable = (now = Date.now()): number | null => {
    const w = signedIn() ? null : liveWindowOf(get(), now);
    for (const key of get().queue) {
      const job = get().jobs[key];
      if (!job || !(job.phase === "queued" || job.phase === "paused")) continue;
      if (job.phase === "paused" && (job.resumeAt ?? 0) > now) continue;
      if (job.info.mode === "download" && w) {
        setJob(key, { phase: "paused", resumeAt: w.until, notice: `${LIVE_WINDOW_NOTICE} (${w.label}).` });
        continue;
      }
      return key;
    }
    return null;
  };

  /** Come back when the earliest paused job may run. */
  const scheduleResume = () => {
    if (resumeTimer) clearTimeout(resumeTimer);
    resumeTimer = null;
    const times = get()
      .queue.map((k) => get().jobs[k])
      .filter((j) => j?.phase === "paused" && j.resumeAt != null)
      .map((j) => j.resumeAt!);
    if (!times.length) return;
    const wait = Math.max(1_000, Math.min(...times) - Date.now() + 1_000);
    resumeTimer = setTimeout(() => void pump(), Math.min(wait, 2 ** 31 - 1));
  };

  async function withLock(fn: () => Promise<void>) {
    const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
    if (!locks) return fn();
    const held = (await locks.query()).held?.some((l) => l.name === LOCK);
    if (held) set({ otherTab: true });
    lockAbort = new AbortController();
    try {
      await locks.request(LOCK, { signal: lockAbort.signal }, async () => {
        set({ otherTab: false });
        await fn();
      });
    } catch (e) {
      if ((e as { name?: string }).name !== "AbortError") throw e;
    } finally {
      lockAbort = null;
      set({ otherTab: false });
    }
  }

  /**
   * The race being watched goes before a download of another race: a running one makes way (it's queued right after
   * it, and resumes from what it stored); one that's processing is nearly done, and finishes first.
   */
  function makeWayFor(key: number) {
    const r = running;
    if (!r || r.key === key || get().jobs[r.key]?.phase !== "downloading") return;
    if (nextRunnable() !== key) return; // (it can't run yet anyway: a live window)
    setJob(r.key, { phase: "queued", progress: null });
    r.handle.cancel();
  }

  async function pump() {
    // A watched download whose retry wait is over doesn't wait for the one running.
    if (pumping && watched && get().queue.includes(watched.key)) makeWayFor(watched.key);
    if (pumping || nextRunnable() == null) return scheduleResume();
    pumping = true;
    try {
      await withLock(async () => {
        for (let key = nextRunnable(); key != null; key = nextRunnable()) await runOne(key);
      });
    } catch (e) {
      console.error("download queue", e);
    } finally {
      pumping = false;
    }
    // Queued while the loop was winding down.
    if (nextRunnable() != null) return void pump();
    scheduleResume();
  }

  /** The current season's calendar, for live windows: cached is fine, fetched if there's none. */
  async function ensureCurrentCatalog() {
    const y = currentYear();
    if (get().years[y]?.catalog) return;
    await get().loadYear(y);
  }

  async function runOne(key: number) {
    const job = get().jobs[key];
    if (!job) return dequeue(key);
    const { info } = job;
    if (info.mode === "download") {
      await ensureCurrentCatalog();
      if (nextRunnable() !== key) return; // paused for a live window meanwhile
    }
    // Done meanwhile (e.g. by another tab)?
    const existing = await store().entry(key);
    if (existing && isCurrentFormat(existing)) return finished(key, existing);

    const learned = loadLearned();
    setJob(key, { phase: info.mode === "reprocess" ? "processing" : "downloading", notice: null, error: null, errorKind: null, resumeAt: null });
    let lastBroadcast = 0;
    const update = () => {
      const current = running;
      if (!current || current.key !== key) return;
      const progress = current.handle.tracker.view();
      if (get().jobs[key]?.phase === "cancelled") return;
      setJob(key, { progress, phase: progress.phase });
      if (Date.now() - lastBroadcast > 900) {
        lastBroadcast = Date.now();
        broadcast({ type: "progress", key, label: info.label, progress });
      }
    };
    // (Signed in to the vault: the worker downloads through it, faster.) Watched: it streams to the replay.
    const onMessage = (m: FromWorker) => {
      if (m.type === "stream") useReplay.getState().streamUpdate(m);
      else update();
    };
    const watch = watched?.key === key ? { playhead: watched.t } : null;
    const handle = runJob(info, store().backend, learned, onMessage, getVault(), watch);
    running = { key, handle };
    update();
    const timer = setInterval(update, 500);
    const outcome = await handle.done;
    clearInterval(timer);
    running = null;
    broadcast({ type: "ended", key });

    if (outcome.ok) {
      console.info(
        `[ingest ${key}] ${info.label}: ${info.mode} done in ${(outcome.ms / 1000).toFixed(1)}s (${outcome.requests} requests, ${outcome.status429} rate-limited)`,
        outcome.timings,
      );
      return finished(key, outcome.entry);
    }
    if (outcome.kind === "cancelled") return; // cancel() updated the job
    const now = Date.now();
    if (outcome.kind === "live-window") {
      await get().loadYear(currentYear()).catch(() => {});
      const w = liveWindowOf(get(), now);
      const until = w?.until ?? now + BLOCKED_RECHECK_MS;
      set({ blocked: { until, label: w?.label ?? "a live session" } });
      setJob(key, { phase: "paused", progress: null, resumeAt: until, notice: `${LIVE_WINDOW_NOTICE} (${w?.label ?? "a session is live"}).` });
      return;
    }
    // (Watched: sooner.)
    const retryIn = (watched?.key === key ? WATCHED_RETRY_DELAYS_S : RETRY_DELAYS_S)[job.attempt - 1];
    if ((outcome.kind === "error" || outcome.kind === "crashed") && retryIn != null && !PERMANENT.test(outcome.message)) {
      setJob(key, {
        phase: "paused",
        progress: null,
        attempt: job.attempt + 1,
        resumeAt: now + retryIn * 1000,
        notice: `Interrupted (${outcome.message}); trying again`,
      });
      return;
    }
    const error =
      outcome.kind === "raw-missing"
        ? "Some of the stored OpenF1 data is missing: download the race again."
        : outcome.kind === "quota"
          ? "This browser is out of storage space for this site: delete some races and try again."
          : outcome.message;
    setJob(key, { phase: "failed", progress: null, error, errorKind: outcome.kind, finishedAt: now });
    dequeue(key);
    if (get().watch?.key === key) set({ watch: null });
    void get().refreshLibrary();
  }

  async function finished(key: number, entry: LibraryEntry) {
    setJob(key, { phase: "done", progress: null, finishedAt: Date.now() });
    dequeue(key);
    forgetSession(key);
    broadcast({ type: "changed" });
    await get().refreshLibrary();
    void get().refreshUsage();
    const replay = useReplay.getState();
    await replay.loadIndex();
    if (useReplay.getState().stream?.key === key) {
      // Watched while it downloaded: the stored replay takes over where it is.
      if (get().watch?.key === key) set({ watch: null });
      if (get().link?.key === key) set({ link: null });
      return void useReplay.getState().streamDone(key);
    }
    // Opened for a shared link (its time and drivers), and/or asked to open when ready.
    const link = get().link?.key === key ? get().link : null;
    const watch = get().watch?.key === key ? get().watch : null;
    const opts = { ...link?.opts, ...watch?.opts };
    const shown = useReplay.getState();
    const prompted = link != null && shown.view === "replay" && shown.mode === "replay";
    if (shown.session?.meta.sessionKey === key && shown.mode === "replay") {
      // Re-processed the loaded session: reload it where it was.
      void shown.loadSession(key, { t: clock.t, drivers: shown.selected, focus: shown.focused });
    } else if (watch || prompted) {
      // Asked to open when ready, or it's the shared link on screen.
      set({ watch: null });
      get().watchNow(key, opts);
    } else if (shown.view === "replay") {
      // On Home its card just turns into Watch; over a replay, say so.
      set({ toast: { key, label: labelOf(entry) } });
    }
    if (get().watch?.key === key) set({ watch: null });
    console.debug(`[library] ${labelOf(entry)} ready (format ${entry.format})`);
  }

  /** Cancel a job (a running one stops now; its stored files are kept). Whether it was running. */
  function stop(key: number): boolean {
    if (get().watch?.key === key) set({ watch: null });
    const job = get().jobs[key];
    if (!job || !isActive(job.phase)) return false;
    setJob(key, { phase: "cancelled", progress: null, finishedAt: Date.now(), notice: null });
    dequeue(key);
    const wasRunning = running?.key === key;
    if (wasRunning) running!.handle.cancel();
    // Nothing left to wait for: stop queueing for the lock.
    if (!get().queue.length) lockAbort?.abort();
    return wasRunning;
  }

  /** Queue a job (`first`: ahead of the others). */
  function enqueue(info: JobInfo, watch?: WatchOpts, first = false) {
    const key = info.key;
    const existing = get().jobs[key];
    if (watch) set({ watch: { key, opts: watch } });
    const others = get().queue.filter((k) => k !== key);
    if (existing && isActive(existing.phase)) {
      if (first) set({ queue: [key, ...others] });
      saveQueue();
      return;
    }
    set({ jobs: { ...get().jobs, [key]: newJob(info) }, queue: first ? [key, ...others] : [...others, key] });
    saveQueue();
    void pump();
  }

  /** Ask once, on the first download (a user gesture), for persistent storage: keeps the browser from clearing the library. */
  function askPersist() {
    if (persistAsked || typeof navigator === "undefined" || !navigator.storage?.persist) return;
    persistAsked = true;
    void navigator.storage
      .persist()
      .catch(() => false)
      .then(() => get().refreshUsage());
  }

  channel?.addEventListener("message", (e: MessageEvent<Broadcast>) => {
    const m = e.data;
    if (m.type === "changed") {
      void get()
        .refreshLibrary()
        .then(() => {
          // Downloaded by another tab meanwhile: done here (a race watched here opens), not left queued behind its lock.
          for (const key of get().queue) {
            const entry = get().entries[key];
            if (entry && isCurrentFormat(entry) && running?.key !== key && get().jobs[key]?.info.mode === "download") void finished(key, entry);
          }
        });
      void get().refreshUsage();
      void useReplay.getState().loadIndex();
    } else if (m.type === "progress") {
      set({ remote: { ...get().remote, [m.key]: { key: m.key, label: m.label, progress: m.progress, at: Date.now() } } });
    } else if (m.type === "ended") {
      const remote = { ...get().remote };
      delete remote[m.key];
      set({ remote });
    }
  });

  return {
    supported: true,
    ready: false,
    entries: {},
    partial: {},
    years: {},
    jobs: {},
    queue: [],
    remote: {},
    otherTab: false,
    blocked: null,
    overruns: {},
    usage: null,
    calendarYear: currentYear(),
    filter: "all",
    confirmDelete: null,
    watch: null,
    link: null,
    lookups: {},
    toast: null,

    init: async () => {
      if (initialized) return;
      initialized = true;
      // Signed in: downloads that wait out a live window can go now, and a calendar that couldn't load (OpenF1 refusing
      // browsers without a token during a session) loads through the vault.
      let wasSignedIn = signedIn();
      // (On every page, not only Home's: a download from a shared link needs to know too.)
      if (getVault().origin) void getVault().start();
      getVault().onState(() => {
        const now = signedIn();
        const fresh = now && !wasSignedIn;
        wasSignedIn = now;
        if (!now) return;
        if (fresh) for (const [year, y] of Object.entries(get().years)) if (y.error) void get().loadYear(Number(year), { force: true });
        let woke = false;
        for (const key of get().queue) {
          const job = get().jobs[key];
          if (job?.phase === "paused" && job.info.mode === "download" && job.notice?.startsWith(LIVE_WINDOW_NOTICE)) {
            setJob(key, { resumeAt: Date.now() });
            woke = true;
          }
        }
        if (woke) void pump();
      });
      // This page's own OpenF1 requests (the calendar, link lookups) pace around the downloads' and count for them.
      seedRequestStarts(recentRequests());
      setRequestObserver((e) => noteRequest(Date.now() - e.ms));
      setInterval(() => void probeOverrun(), PROBE_MS);
      if (!storageSupported()) {
        set({ supported: false, ready: true });
        return;
      }
      await get().refreshLibrary();
      set({ ready: true });
      void get().refreshUsage();
      // Downloads queued before a reload carry on (from what they had stored).
      try {
        const items = JSON.parse(sessionStorage.getItem(QUEUE_KEY) ?? "[]") as { info: JobInfo; watch: WatchOpts | null }[];
        for (const { info, watch } of items) enqueue(info, watch ?? undefined);
      } catch {}
    },

    refreshLibrary: async () => {
      if (!get().supported) return;
      try {
        const s = store();
        const [list, rawKeys] = await Promise.all([s.list(), s.rawSessions()]);
        const entries: Record<number, LibraryEntry> = {};
        for (const e of list) entries[e.sessionKey] = e;
        const partial: Record<number, PartialRaw> = {};
        for (const key of rawKeys) {
          if (entries[key]) continue;
          const files = await s.rawFiles(key);
          const raw = async <T,>(name: string): Promise<T | null> => {
            if (!files.has(name)) return null;
            try {
              const gz = await s.readRaw(key, name);
              return gz ? await gunzipJson<T>(gz) : null;
            } catch {
              return null;
            }
          };
          const driverRows = await raw<{ driver_number: number }[]>("drivers");
          const drivers = driverRows ? [...new Set(driverRows.map((d) => d.driver_number))].sort((a, b) => a - b) : null;
          const [session] = (await raw<RawSession[]>("sessions")) ?? [];
          const [meeting] = (await raw<RawMeeting[]>("meeting")) ?? [];
          const row = session ? (buildCatalog(session.year, [session], meeting ? [meeting] : []).rows[0] ?? null) : null;
          partial[key] = { files: Object.fromEntries(files), drivers, row };
        }
        set({ entries, partial });
      } catch (e) {
        console.error("listing the library", e);
      }
    },

    refreshUsage: async () => {
      if (!get().supported) return;
      set({ usage: await store().usage() });
    },

    setCalendarYear: (year) => {
      set({ calendarYear: year, confirmDelete: null });
      void get().loadYear(year);
    },
    setFilter: (filter) => set({ filter }),

    loadYear: async (year, { force = false } = {}) => {
      // Asked again while it's being read or fetched (Home and the jump field both ask): the same request.
      const running = loadingYears.get(year);
      if (running) return running;
      const load = loadYearOnce(year, force).finally(() => loadingYears.delete(year));
      loadingYears.set(year, load);
      return load;
    },

    lookup: async (key) => {
      const known = get().lookups[key];
      if (known?.loading || known?.row) return;
      const setLookup = (l: Lookup) => set({ lookups: { ...get().lookups, [key]: l } });
      const find = () => {
        for (const y of Object.values(get().years)) {
          const row = y.catalog?.rows.find((r) => r.sessionKey === key);
          if (row) return row;
        }
        return null;
      };
      setLookup({ loading: true, row: null, error: null });
      try {
        let row = find();
        // Cached calendars first (no network), newest season first.
        for (const year of [...YEARS].reverse()) {
          if (row) break;
          if (get().years[year]?.catalog) continue;
          const cached = await store().readDoc<Catalog>(`catalog-${year}`).catch(() => undefined);
          if (cached) {
            putYear(year, { catalog: withCurrentRows(cached), loading: false, error: null });
            row = find();
          }
        }
        if (!row) {
          const info = await fetchSessionInfo(key, await openf1Get());
          if (!info) throw new Error(`OpenF1 has no session ${key}.`);
          if (!isIngestible(info)) throw new Error(`Session ${key} is ${info.session_name} (${info.country_name} ${info.year}); only races, sprints, qualifying and free practice can be replayed.`);
          await get().loadYear(info.year);
          row = find();
          if (!row) throw new Error(get().years[info.year]?.error ?? `Couldn't find session ${key} in the ${info.year} calendar.`);
        }
        setLookup({ loading: false, row, error: null });
      } catch (e) {
        const error =
          e instanceof LiveWindowError ? "OpenF1 is blocking free access while a session is live; try again once it's over." : message(e);
        setLookup({ loading: false, row: null, error });
      }
    },

    setLink: (link) => set({ link }),

    stream: (row, opts = {}) => {
      const key = row.sessionKey;
      const state = rowState(row, get());
      if (state.kind === "ready") return get().watchNow(key, opts);
      if (state.kind === "stale") return get().reprocess(state.entry, { watch: opts });
      if (state.kind === "upcoming" || state.kind === "cancelled") return;
      set({ link: null, confirmDelete: null, toast: get().toast?.key === key ? null : get().toast });
      if (get().watch?.key === key) set({ watch: null });
      useReplay.getState().openStream(key, opts);
      askPersist();
      enqueue(jobInfo(row, "download"), undefined, true);
      // Waiting to retry: now (a live window pauses it again).
      if (get().jobs[key]?.phase === "paused") setJob(key, { resumeAt: Date.now() });
      makeWayFor(key);
      void pump();
    },

    reprocess: (entry, { watch } = {}) => enqueue(entryInfo(entry), watch),

    cancel: (key) => {
      if (stop(key)) void get().refreshLibrary();
    },

    askDelete: (key) => set({ confirmDelete: key }),

    remove: async (key) => {
      set({ confirmDelete: null });
      const wasRunning = stop(key);
      // A worker that was just stopped may hold its files for a moment.
      for (let attempt = 0; ; attempt++) {
        try {
          await store().delete(key);
          break;
        } catch (e) {
          if (attempt >= 10 || !wasRunning) throw e;
          await sleep(200);
        }
      }
      forgetSession(key);
      const jobs = { ...get().jobs };
      delete jobs[key];
      set({ jobs });
      broadcast({ type: "changed" });
      await get().refreshLibrary();
      void get().refreshUsage();
      const replay = useReplay.getState();
      await replay.loadIndex();
      if (replay.session?.meta.sessionKey === key || replay.stream?.key === key) useReplay.getState().closeSession();
    },

    setWatch: (key) => set({ watch: key == null ? null : { key, opts: {} } }),

    watchNow: (key, opts) => {
      set({ link: null, confirmDelete: null, toast: get().toast?.key === key ? null : get().toast });
      useReplay.getState().openSession(key, opts);
    },

    dismissToast: () => set({ toast: null }),
  };
});

/** Minutes OpenF1's free-tier lockout extends before and after each session. */
export const LIVE_MARGIN_MIN = LIVE_WINDOW_MARGIN_MS / 60_000;

// Dev app only: browser checks (vault/livecheck.ts) read the downloads through the library the app uses.
if (import.meta.env.DEV && typeof window !== "undefined") Object.assign(window, { __library: useLibrary });
