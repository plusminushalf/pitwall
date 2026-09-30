// The race library: what's downloaded into this browser, the OpenF1 calendar, and the download queue.
// Downloads run one at a time in a worker (src/ingest/), guarded by a Web Lock so two tabs never download
// at once; the queue survives reloads of the tab (sessionStorage) and every run resumes from the raw
// responses already stored. Separate from the replay store: finished downloads are handed to it through
// useReplay.getState().loadIndex() / loadSession().

import { create } from "zustand";
import { FORMAT_VERSION } from "../scripts/lib/formatVersion";
import { LiveWindowError } from "../scripts/lib/openf1Http";
import { FIRST_YEAR, isIngestible, LIVE_WINDOW_MARGIN_MS } from "../scripts/lib/season";
import type { RawMeeting, RawSession } from "../scripts/lib/openf1Types";
import { buildCatalog, catalogFresh, fetchCatalog, fetchSessionInfo, liveWindowNow, windowLabel, type Catalog, type CatalogRow } from "./ingest/catalog";
import { assumedDrivers, cacheProgress, estimate, expectedRawFiles, sizeScale, type CacheProgress } from "./ingest/eta";
import type { FailureKind } from "./ingest/protocol";
import { loadLearned, runJob, type JobInfo, type Progress, type RunHandle } from "./ingest/runner";
import { sessionStore, storageSupported, type LibraryEntry, type StorageUsage } from "./storage";
import { forgetSession } from "./storage/load";
import { clock, useReplay } from "./store";

export { FIRST_YEAR };
/** UTC, like OpenF1's `year`. */
export const currentYear = () => new Date().getUTCFullYear();
export const YEARS = Array.from({ length: currentYear() - FIRST_YEAR + 1 }, (_, i) => FIRST_YEAR + i);

/** Where to open a session once it's ready (from a shared link: time in ms, drivers). */
export interface WatchOpts {
  t?: number;
  drivers?: number[];
  focus?: number | null;
}

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

/** Session types shown in the calendar: everything, races + sprints, or (sprint) qualifying. */
export type RaceFilter = "all" | "Race" | "Qualifying";

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
  download: (row: CatalogRow, opts?: { watch?: WatchOpts }) => void;
  reprocess: (entry: LibraryEntry, opts?: { watch?: WatchOpts }) => void;
  cancel: (key: number) => void;
  askDelete: (key: number | null) => void;
  remove: (key: number) => Promise<void>;
  setWatch: (key: number | null) => void;
  /** Open a downloaded session (useReplay's openSession). */
  watchNow: (key: number, opts?: WatchOpts) => void;
  dismissToast: () => void;
}

// ---------------------------------------------------------------- helpers

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const LOCK = "f1-replay:downloads";
const QUEUE_KEY = "f1-replay:queue";
/** Automatic retries of a failed download (network drop, OpenF1 hiccup), from what's stored. */
const RETRY_DELAYS_S = [10, 30];
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

function entryInfo(e: LibraryEntry): JobInfo {
  const end = new Date(Date.parse(e.dateStart) + 2 * 3600_000).toISOString();
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

function partialProgress(row: Pick<CatalogRow, "sessionType" | "year">, p: PartialRaw | undefined): CacheProgress | null {
  if (!p || !Object.keys(p.files).length) return null;
  return cacheProgress(expectedRawFiles(row.sessionType, p.drivers, assumedDrivers(row.year)), new Map(Object.entries(p.files)));
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
  if (entry) return entry.format === FORMAT_VERSION ? { kind: "ready", entry } : { kind: "stale", entry };
  if (job?.phase === "failed") return { kind: "job", job, cache: partial };
  if (row.cancelled) return { kind: "cancelled" };
  if (Date.parse(row.dateEnd) > now) return { kind: "upcoming" };
  const scale = sizeScale(row.dateStart, row.dateEnd);
  if (partial && partial.cachedFiles > 0) {
    return { kind: "partial", cache: partial, estimate: estimate(partial.missing, "free", scale, learned.ratio, learned.processingS, partial.cachedBytes) };
  }
  const all = expectedRawFiles(row.sessionType, null, assumedDrivers(row.year)).filter((f) => f.required || !f.external);
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
      dateEnd: new Date(Date.parse(e.dateStart) + 2 * 3600_000).toISOString(),
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
let pumping = false;
let lockAbort: AbortController | null = null;
let resumeTimer: ReturnType<typeof setTimeout> | null = null;
let persistAsked = false;

export const useLibrary = create<LibraryState>((set, get) => {
  const store = () => sessionStore();

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

  /** The next job that can run now: queued, or paused with its wait over (downloads wait out live windows). */
  const nextRunnable = (now = Date.now()): number | null => {
    const w = liveWindowOf(get(), now);
    for (const key of get().queue) {
      const job = get().jobs[key];
      if (!job || !(job.phase === "queued" || job.phase === "paused")) continue;
      if (job.phase === "paused" && (job.resumeAt ?? 0) > now) continue;
      if (job.info.mode === "download" && w) {
        setJob(key, { phase: "paused", resumeAt: w.until, notice: `OpenF1 blocks free downloads during live sessions (${w.label}).` });
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

  async function pump() {
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
    if (existing?.format === FORMAT_VERSION) return finished(key, existing);

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
    const handle = runJob(info, store().backend, learned, update);
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
      setJob(key, { phase: "paused", progress: null, resumeAt: until, notice: `OpenF1 blocks free downloads during live sessions (${w?.label ?? "a session is live"}).` });
      return;
    }
    const retryIn = RETRY_DELAYS_S[job.attempt - 1];
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

  function enqueue(info: JobInfo, watch?: WatchOpts) {
    const key = info.key;
    const existing = get().jobs[key];
    if (watch) set({ watch: { key, opts: watch } });
    if (existing && isActive(existing.phase)) {
      saveQueue();
      return;
    }
    set({ jobs: { ...get().jobs, [key]: newJob(info) }, queue: [...get().queue.filter((k) => k !== key), key] });
    saveQueue();
    void pump();
  }

  channel?.addEventListener("message", (e: MessageEvent<Broadcast>) => {
    const m = e.data;
    if (m.type === "changed") {
      void get().refreshLibrary();
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
      const prev = get().years[year];
      if (prev?.loading) return;
      const setYear = (y: YearState) => set({ years: { ...get().years, [year]: y } });
      let catalog = prev?.catalog ?? null;
      if (!catalog && get().supported) catalog = (await store().readDoc<Catalog>(`catalog-${year}`).catch(() => undefined)) ?? null;
      if (catalog && catalogFresh(catalog) && !force) {
        setYear({ catalog, loading: false, error: null });
        return;
      }
      setYear({ catalog, loading: true, error: null });
      try {
        const fresh = await fetchCatalog(year);
        if (get().supported) await store().writeDoc(`catalog-${year}`, fresh).catch(() => {});
        setYear({ catalog: fresh, loading: false, error: null });
      } catch (e) {
        let error = `Couldn't load the ${year} calendar from OpenF1 (${message(e)}).`;
        if (e instanceof LiveWindowError) {
          const w = liveWindowOf(get());
          set({ blocked: { until: w?.until ?? Date.now() + BLOCKED_RECHECK_MS, label: w?.label ?? "a live session" } });
          error = "OpenF1 is blocking free access while a session is live; the calendar loads again once it's over.";
        }
        setYear({ catalog, loading: false, error });
      }
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
            set({ years: { ...get().years, [year]: { catalog: cached, loading: false, error: null } } });
            row = find();
          }
        }
        if (!row) {
          const info = await fetchSessionInfo(key);
          if (!info) throw new Error(`OpenF1 has no session ${key}.`);
          if (!isIngestible(info)) throw new Error(`Session ${key} is ${info.session_name} (${info.country_name} ${info.year}); only races, sprints and qualifying can be replayed.`);
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

    download: (row, { watch } = {}) => {
      if (!persistAsked && typeof navigator !== "undefined" && navigator.storage?.persist) {
        // Ask once, on the first download (a user gesture): keeps the browser from clearing the library.
        persistAsked = true;
        void navigator.storage
          .persist()
          .catch(() => false)
          .then(() => get().refreshUsage());
      }
      enqueue(jobInfo(row, "download"), watch);
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
      if (replay.session?.meta.sessionKey === key) useReplay.getState().closeSession();
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
