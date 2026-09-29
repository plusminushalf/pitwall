// Race downloader state: the picker, season listings and download jobs from the dev server
// (src/data/ingestApi.ts). Separate from the replay store; finished downloads are handed to it through
// useReplay.getState().loadIndex() / loadSession().

import { create } from "zustand";
import { cancelJob, fetchJobs, fetchRaces, IngestUnavailable, startJob } from "./data/ingestApi";
import type { JobPhase, JobView, RaceRow, Tier } from "./data/ingestTypes";
import { useReplay } from "./store";

export const FIRST_YEAR = 2023;
// UTC, like the server's year check.
export const currentYear = () => new Date().getUTCFullYear();

/** Session types shown: everything, races + sprints, or (sprint) qualifying. */
export type RaceFilter = "all" | "Race" | "Qualifying";

export const isActive = (phase: JobPhase) => phase === "queued" || phase === "downloading" || phase === "processing";

interface YearRows {
  rows: RaceRow[] | null;
  loading: boolean;
  error: string | null;
}

interface DownloadsState {
  open: boolean;
  /** Whether the dev server's downloader API answered; null until it has been asked. */
  available: boolean | null;
  tier: Tier | null;
  /** Season shown in the picker; null until the default (latest with races) is picked. */
  year: number | null;
  filter: RaceFilter;
  years: Record<number, YearRows>;
  jobs: Record<number, JobView>;
  /** Session to open once its download finishes. */
  watchKey: number | null;
  /** Errors from starting / pausing a download, by session. */
  actionErrors: Record<number, string>;

  openPicker: () => void;
  closePicker: () => void;
  /** Fetch jobs and the shown season (picker opened). */
  refresh: () => Promise<void>;
  setYear: (year: number) => void;
  setFilter: (filter: RaceFilter) => void;
  loadYear: (year: number) => Promise<void>;
  refreshJobs: () => Promise<void>;
  download: (key: number, opts?: { watch?: boolean }) => Promise<void>;
  cancel: (key: number) => Promise<void>;
  setWatch: (key: number | null) => void;
  /** Open a downloaded session and close the picker. */
  watch: (key: number) => Promise<void>;
}

let pollTimer: ReturnType<typeof setTimeout> | null = null;

/** Poll jobs every second while any is queued or running. */
function ensurePolling() {
  if (pollTimer) return;
  const { jobs } = useDownloads.getState();
  if (!Object.values(jobs).some((j) => isActive(j.phase))) return;
  pollTimer = setTimeout(async () => {
    pollTimer = null;
    await useDownloads.getState().refreshJobs();
    ensurePolling();
  }, 1000);
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const useDownloads = create<DownloadsState>((set, get) => {
  /** Handle an API error: flag the API as missing, or return the message. */
  const failed = (e: unknown): string | null => {
    if (e instanceof IngestUnavailable) {
      set({ available: false });
      return null;
    }
    return message(e);
  };

  /** A job left the queued/running phases. */
  const finished = async (job: JobView) => {
    if (get().years[job.year]) void get().loadYear(job.year);
    if (job.phase !== "done") {
      if (get().watchKey === job.key) set({ watchKey: null });
      return;
    }
    const replay = useReplay.getState();
    await replay.loadIndex();
    // Open it if asked to, or if nothing is loaded yet (first run).
    const idle = !useReplay.getState().session && !useReplay.getState().loading;
    if (get().watchKey === job.key || idle) {
      set({ watchKey: null, open: false });
      void useReplay.getState().loadSession(job.key);
    }
  };

  return {
    open: false,
    available: null,
    tier: null,
    year: null,
    filter: "all",
    years: {},
    jobs: {},
    watchKey: null,
    actionErrors: {},

    openPicker: () => set({ open: true }),
    closePicker: () => set({ open: false }),

    refresh: async () => {
      void get().refreshJobs();
      const { year } = get();
      if (year != null) return get().loadYear(year);
      // Default to the latest season with a race that has run.
      const latest = currentYear();
      set({ year: latest });
      await get().loadYear(latest);
      const rows = get().years[latest]?.rows;
      const ran = rows?.some((r) => r.status !== "not-run" && r.status !== "cancelled");
      if (rows && !ran && latest > FIRST_YEAR && get().year === latest) get().setYear(latest - 1);
    },

    setYear: (year) => {
      set({ year });
      void get().loadYear(year);
    },

    setFilter: (filter) => set({ filter }),

    loadYear: async (year) => {
      const prev = get().years[year];
      set({ years: { ...get().years, [year]: { rows: prev?.rows ?? null, loading: true, error: null } } });
      try {
        const res = await fetchRaces(year);
        set({ available: true, tier: res.tier, years: { ...get().years, [year]: { rows: res.rows, loading: false, error: null } } });
      } catch (e) {
        const error = failed(e);
        set({ years: { ...get().years, [year]: { rows: prev?.rows ?? null, loading: false, error } } });
      }
    },

    refreshJobs: async () => {
      let res;
      try {
        res = await fetchJobs();
      } catch (e) {
        failed(e);
        return;
      }
      const prev = get().jobs;
      const jobs: Record<number, JobView> = {};
      for (const j of res.jobs) jobs[j.key] = j;
      set({ available: true, jobs, ...(res.tier ? { tier: res.tier } : {}) });
      for (const j of res.jobs) {
        const before = prev[j.key];
        if (before && isActive(before.phase) && !isActive(j.phase)) void finished(j);
      }
      // Active jobs that vanished: the dev server restarted (its jobs are gone, the files stay).
      for (const before of Object.values(prev)) {
        if (isActive(before.phase) && !jobs[before.key]) void finished({ ...before, phase: "cancelled" });
      }
      ensurePolling();
    },

    download: async (key, { watch = false } = {}) => {
      const year = Object.entries(get().years).find(([, y]) => y.rows?.some((r) => r.sessionKey === key))?.[0];
      const actionErrors = { ...get().actionErrors };
      delete actionErrors[key];
      set({ actionErrors, ...(watch ? { watchKey: key } : {}) });
      try {
        const job = await startJob(key, Number(year ?? get().year ?? currentYear()));
        set({ available: true, jobs: { ...get().jobs, [key]: job } });
        ensurePolling();
      } catch (e) {
        const error = failed(e);
        set({
          ...(get().watchKey === key ? { watchKey: null } : {}),
          ...(error ? { actionErrors: { ...get().actionErrors, [key]: error } } : {}),
        });
      }
    },

    cancel: async (key) => {
      if (get().watchKey === key) set({ watchKey: null });
      try {
        const job = await cancelJob(key);
        set({ jobs: { ...get().jobs, [key]: job } });
        // A running job reports "cancelled" once its process has exited.
        ensurePolling();
        if (!isActive(job.phase)) void finished(job);
      } catch (e) {
        const error = failed(e);
        if (error) set({ actionErrors: { ...get().actionErrors, [key]: error } });
      }
    },

    setWatch: (key) => set({ watchKey: key }),

    watch: async (key) => {
      const replay = useReplay.getState();
      if (!replay.index.some((e) => e.sessionKey === key)) await replay.loadIndex();
      set({ open: false });
      void useReplay.getState().loadSession(key);
    },
  };
});
