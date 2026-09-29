import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import type { CatalogRow } from "../ingest/catalog";
import { loadLearned } from "../ingest/runner";
import {
  currentYear,
  isRunning,
  liveWindowOf,
  rowForKey,
  rowState,
  useLibrary,
  YEARS,
  type Job,
  type RaceFilter,
  type RemoteJob,
  type RowState,
} from "../library";
import { useReplay } from "../store";

const FILTERS: { id: RaceFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "Race", label: "Races" },
  { id: "Qualifying", label: "Qualifying" },
];

const BUTTON = "whitespace-nowrap rounded px-2.5 py-1 text-xs font-semibold transition-colors disabled:opacity-50";
export const PRIMARY = `${BUTTON} bg-zinc-100 text-zinc-900 hover:bg-white`;
export const SECONDARY = `${BUTTON} border border-zinc-700 text-zinc-200 hover:border-zinc-500 hover:text-white`;
const DANGER = `${BUTTON} bg-red-600 text-white hover:bg-red-500`;
const ICON = "flex h-6 w-6 shrink-0 items-center justify-center rounded text-zinc-500 hover:bg-zinc-800 hover:text-zinc-100";

/** Up-front estimate: "~45s", "~1.5 min", "~12 min". */
export const approx = (s: number) =>
  s < 60 ? `~${Math.max(1, Math.round(s))}s` : s < 600 ? `~${Math.round(s / 30) / 2} min` : `~${Math.round(s / 60)} min`;
/** Countdown: "~45s left", "~2.5 min left". */
const left = (s: number) => (s < 90 ? `~${Math.max(1, Math.ceil(s))}s left` : `${approx(s)} left`);
export const mb = (bytes: number) => {
  const v = bytes / 1e6;
  return v < 10 ? v.toFixed(1) : String(Math.round(v));
};
export const size = (bytes: number) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : `${mb(bytes)} MB`);
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
const date = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
export const clockTime = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

/** Re-render every `ms` (countdowns, live windows). */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

/** A session's state in the library, kept current. */
export function useRowState(row: CatalogRow | null): RowState | null {
  const jobs = useLibrary((s) => s.jobs);
  const remote = useLibrary((s) => s.remote);
  const entries = useLibrary((s) => s.entries);
  const partial = useLibrary((s) => s.partial);
  const now = useNow(2000);
  return row ? rowState(row, { jobs, remote, entries, partial }, now) : null;
}

// ---------------------------------------------------------------- progress + actions

/** Progress bar and details of a running (or waiting) job. */
export function JobProgress({ job, remote }: { job?: Job; remote?: RemoteJob }) {
  const watchKey = useLibrary((s) => s.watch?.key);
  const setWatch = useLibrary((s) => s.setWatch);
  const otherTab = useLibrary((s) => s.otherTab);
  const now = useNow(1000);
  const p = job?.progress ?? remote?.progress ?? null;
  const key = job?.info.key ?? remote?.key;

  if (job && job.phase === "queued") {
    return otherTab ? <p className="mt-1 text-[11px] text-zinc-400">Another tab is downloading; this starts when it's done.</p> : null;
  }
  if (job && job.phase === "paused") {
    const wait = job.resumeAt != null ? Math.max(0, job.resumeAt - now) : null;
    return (
      <p className="mt-1 text-[11px] text-amber-300">
        {job.notice ?? "Paused"}
        {wait != null && (wait > 90_000 ? ` Starts by itself at ${clockTime(job.resumeAt!)}.` : ` Starts by itself in ${Math.ceil(wait / 1000)}s.`)}
      </p>
    );
  }
  if (!p) return null;
  const pct = Math.round(p.progress * 100);
  const details = [
    remote ? "In another tab" : null,
    p.step,
    p.phase === "downloading" ? `${p.cachedFiles}/${p.expectedFiles} files` : null,
    p.phase === "downloading" && p.totalBytes > 0 ? `${mb(p.cachedBytes)} / ~${mb(p.totalBytes)} MB` : null,
  ].filter(Boolean);
  const watching = key != null && watchKey === key;

  return (
    <div className="mt-1.5">
      <div className="h-1.5 overflow-hidden rounded bg-zinc-800" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Download progress">
        <div className={`h-full bg-zinc-200 transition-all duration-700 ${p.phase === "processing" ? "animate-pulse" : ""}`} style={{ width: `${pct}%` }} />
      </div>
      <div className="mt-1 flex items-center gap-3 text-[11px]">
        <span className="min-w-0 flex-1 truncate tabular-nums text-zinc-400">{details.join(" · ")}</span>
        {job && key != null && (
          <button
            onClick={() => setWatch(watching ? null : key)}
            className={`shrink-0 rounded px-1 hover:bg-zinc-800 ${watching ? "text-zinc-200" : "text-zinc-500 hover:text-zinc-200"}`}
            title={watching ? "Don't switch to this session when it's ready" : "Switch to this session when it's ready"}
          >
            {watching ? "✓ Opens when ready" : "Open when ready"}
          </button>
        )}
      </div>
      {p.notice && <p className="mt-0.5 text-[11px] text-amber-300">{p.notice}</p>}
    </div>
  );
}

const muted = (text: ReactNode) => <span className="whitespace-nowrap text-xs text-zinc-500">{text}</span>;

function TrashButton({ sessionKey, title }: { sessionKey: number; title: string }) {
  const askDelete = useLibrary((s) => s.askDelete);
  return (
    <button onClick={() => askDelete(sessionKey)} className={ICON} aria-label={title} title={title}>
      <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
        <path d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4M6.8 6.5v4.5M9.2 6.5v4.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );
}

/** The buttons for a session in its current state. */
export function Action({ row, state, current, compact = false }: { row: CatalogRow; state: RowState; current: boolean; compact?: boolean }) {
  const download = useLibrary((s) => s.download);
  const reprocess = useLibrary((s) => s.reprocess);
  const cancel = useLibrary((s) => s.cancel);
  const watchNow = useLibrary((s) => s.watchNow);
  const confirming = useLibrary((s) => s.confirmDelete === row.sessionKey);
  const askDelete = useLibrary((s) => s.askDelete);
  const remove = useLibrary((s) => s.remove);
  const key = row.sessionKey;

  if (confirming) {
    const bytes = state.kind === "ready" || state.kind === "stale" ? state.entry.processedBytes + state.entry.rawBytes : state.kind === "partial" ? state.cache.cachedBytes : 0;
    return (
      <>
        <span className="whitespace-nowrap text-xs text-zinc-300">Delete{bytes ? ` ${size(bytes)}` : ""} from this browser?</span>
        <button onClick={() => void remove(key)} className={DANGER}>
          Delete
        </button>
        <button onClick={() => askDelete(null)} className={SECONDARY}>
          Keep
        </button>
      </>
    );
  }

  switch (state.kind) {
    case "cancelled":
      return muted("Cancelled");
    case "upcoming":
      return muted("Upcoming");
    case "remote":
      return <span className="whitespace-nowrap text-xs tabular-nums text-zinc-400">{state.job.progress ? `${Math.round(state.job.progress.progress * 100)}% · other tab` : "Downloading in another tab"}</span>;
    case "ready":
      return (
        <>
          {!compact && muted(size(state.entry.processedBytes + state.entry.rawBytes))}
          {current ? (
            muted("Watching")
          ) : (
            <button onClick={() => watchNow(key)} className={PRIMARY}>
              Watch
            </button>
          )}
          <TrashButton sessionKey={key} title="Delete from this browser" />
        </>
      );
    case "stale":
      return (
        <>
          {muted("Needs an update")}
          <button
            onClick={() => reprocess(state.entry, { watch: {} })}
            className={PRIMARY}
            title="Processed by an older version of the app: re-process it from the stored OpenF1 data (no download)"
          >
            Update
          </button>
          <TrashButton sessionKey={key} title="Delete from this browser" />
        </>
      );
    case "job": {
      const { job } = state;
      if (job.phase === "failed") {
        const cached = state.cache;
        return (
          <>
            <button
              onClick={() => download(row, { watch: {} })}
              className={SECONDARY}
              title={cached ? "Continue from the files already downloaded" : "Try again"}
            >
              {cached && cached.cachedFiles > 0 ? `Retry · ${cached.cachedFiles}/${cached.expectedFiles} files` : "Retry"}
            </button>
            {cached && <TrashButton sessionKey={key} title="Discard the partial download" />}
          </>
        );
      }
      if (job.phase === "queued" || job.phase === "paused") {
        return (
          <>
            {muted(job.phase === "paused" ? "Waiting" : "Queued")}
            <button onClick={() => cancel(key)} className={SECONDARY}>
              Cancel
            </button>
          </>
        );
      }
      const p = job.progress;
      return (
        <>
          <span className="whitespace-nowrap text-xs tabular-nums text-zinc-300">
            {p ? `${Math.round(p.progress * 100)}% · ${left(p.etaSeconds)}` : job.info.mode === "reprocess" ? "Updating…" : "Starting…"}
          </span>
          <button onClick={() => cancel(key)} className={SECONDARY} title="Stop; what's downloaded so far is kept">
            Cancel
          </button>
        </>
      );
    }
    case "partial":
      return (
        <>
          {!compact && muted(`${approx(state.estimate.seconds)} left`)}
          <button onClick={() => download(row, { watch: {} })} className={SECONDARY} title="Continue from the files already downloaded">
            Resume · {state.cache.cachedFiles}/{state.cache.expectedFiles} files
          </button>
          <TrashButton sessionKey={key} title="Discard the partial download" />
        </>
      );
    case "available":
      return (
        <>
          {!compact && muted(`${approx(state.estimate.seconds)} · ~${state.estimate.mb < 10 ? state.estimate.mb.toFixed(1) : Math.round(state.estimate.mb)} MB`)}
          <button onClick={() => download(row, { watch: {} })} className={PRIMARY} title="Download from OpenF1 into this browser">
            Download
          </button>
        </>
      );
  }
}

/** Progress, pause reasons and errors under a row. */
function RowDetails({ state }: { state: RowState }) {
  if (state.kind === "remote") return <JobProgress remote={state.job} />;
  if (state.kind !== "job") return null;
  const { job } = state;
  if (job.phase === "failed") {
    return (
      <p className="mt-1 text-[11px] text-red-400">
        {job.error ?? "Download failed"}
        {state.cache && job.errorKind !== "raw-missing" && <span className="text-zinc-500"> · Downloaded files are kept; Retry continues from them.</span>}
      </p>
    );
  }
  return <JobProgress job={job} />;
}

// ---------------------------------------------------------------- rows

function SessionRow({ row, state, title }: { row: CatalogRow; state: RowState; title?: ReactNode }) {
  const current = useReplay((s) => s.session?.meta.sessionKey === row.sessionKey);
  const dim = state.kind === "cancelled" || state.kind === "upcoming";
  const isRace = row.sessionType === "Race";

  return (
    <li className={`py-1.5 pr-4 ${title ? "pl-4" : "pl-14"} ${current ? "bg-zinc-800/40" : ""}`}>
      <div className="flex min-h-7 items-center gap-3">
        <span className={`w-24 shrink-0 text-xs tabular-nums ${dim ? "text-zinc-600" : "text-zinc-500"}`}>{title ? date(row.dateStart) : day(row.dateStart)}</span>
        <span
          className={`min-w-0 flex-1 truncate text-sm ${dim ? "text-zinc-600" : isRace ? "font-semibold text-zinc-100" : "text-zinc-300"} ${state.kind === "cancelled" ? "line-through" : ""}`}
        >
          {title ?? row.sessionName}
        </span>
        <span className="flex shrink-0 items-center gap-2">
          <Action row={row} state={state} current={current} />
        </span>
      </div>
      <RowDetails state={state} />
    </li>
  );
}

interface Meeting {
  key: number;
  name: string;
  round: number | null;
  circuit: string;
  country: string;
  rows: CatalogRow[];
}

/** Rows (in date order) grouped by meeting. */
function byMeeting(rows: CatalogRow[]): Meeting[] {
  const meetings = new Map<number, Meeting>();
  for (const r of rows) {
    let m = meetings.get(r.meetingKey);
    if (!m) meetings.set(r.meetingKey, (m = { key: r.meetingKey, name: r.meetingName, round: r.round, circuit: r.circuit, country: r.country, rows: [] }));
    m.round ??= r.round;
    m.rows.push(r);
  }
  return [...meetings.values()];
}

function Calendar({ year }: { year: number }) {
  const state = useLibrary((s) => s.years[year]);
  const filter = useLibrary((s) => s.filter);
  const loadYear = useLibrary((s) => s.loadYear);
  const jobs = useLibrary((s) => s.jobs);
  const remote = useLibrary((s) => s.remote);
  const entries = useLibrary((s) => s.entries);
  const partial = useLibrary((s) => s.partial);
  const now = useNow(5000);
  const rows = state?.catalog?.rows;
  const meetings = useMemo(() => byMeeting((rows ?? []).filter((r) => filter === "all" || r.sessionType === filter)), [rows, filter]);
  const learned = useMemo(() => loadLearned(), [jobs]);

  if (!rows) {
    if (state?.error) {
      return (
        <div className="px-5 py-6 text-sm">
          <p className="text-red-400">{state.error}</p>
          <button onClick={() => void loadYear(year, { force: true })} className={`${SECONDARY} mt-3`}>
            Try again
          </button>
        </div>
      );
    }
    return <p className="px-5 py-6 text-sm text-zinc-500">Loading the {year} calendar from OpenF1…</p>;
  }
  if (!meetings.length) return <p className="px-5 py-6 text-sm text-zinc-500">No sessions listed for {year} yet.</p>;
  return (
    <>
      {state.error && <p className="px-4 pt-2 text-[11px] text-amber-300">{state.error} Showing the calendar saved earlier.</p>}
      <ul className="pb-2">
        {meetings.map((m) => (
          <li key={m.key}>
            <div className="flex items-baseline gap-3 px-4 pb-0.5 pt-3">
              <span className="w-7 shrink-0 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">{m.round != null ? `R${m.round}` : "–"}</span>
              <span className="text-sm font-bold text-zinc-100">{m.name}</span>
              <span className="min-w-0 truncate text-xs text-zinc-500">
                {m.circuit}
                {m.country ? ` · ${m.country}` : ""}
              </span>
            </div>
            <ul>
              {m.rows.map((r) => (
                <SessionRow key={r.sessionKey} row={r} state={rowState(r, { jobs, remote, entries, partial }, now, learned)} />
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </>
  );
}

function LibraryList() {
  const entries = useLibrary((s) => s.entries);
  const partial = useLibrary((s) => s.partial);
  const jobs = useLibrary((s) => s.jobs);
  const remote = useLibrary((s) => s.remote);
  const years = useLibrary((s) => s.years);
  const setTab = useLibrary((s) => s.setTab);
  const now = useNow(5000);
  const learned = useMemo(() => loadLearned(), [jobs]);

  const rows = useMemo(() => {
    const keys = new Set<number>([
      ...Object.keys(entries).map(Number),
      ...Object.keys(partial).map(Number),
      ...Object.values(jobs)
        .filter((j) => j.phase !== "done" && j.phase !== "cancelled")
        .map((j) => j.info.key),
      ...Object.values(remote)
        .filter((r) => now - r.at < 5000)
        .map((r) => r.key),
    ]);
    return [...keys]
      .map((key) => rowForKey(key, { years, entries, partial, jobs }))
      .filter((r): r is CatalogRow => r != null)
      .sort((a, b) => b.dateStart.localeCompare(a.dateStart));
  }, [entries, partial, jobs, remote, years, now]);

  if (!rows.length) {
    return (
      <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
        <p className="text-sm font-semibold text-zinc-200">Your library is empty</p>
        <p className="max-w-sm text-xs leading-relaxed text-zinc-400">
          Races you download are kept in this browser, ready to replay any time, even offline. Pick one from the calendar to get started.
        </p>
        <button onClick={() => setTab(currentYear())} className={`${PRIMARY} mt-1`}>
          Browse the {currentYear()} calendar
        </button>
      </div>
    );
  }
  return (
    <ul className="py-2">
      {rows.map((r) => (
        <SessionRow
          key={r.sessionKey}
          row={r}
          state={rowState(r, { jobs, remote, entries, partial }, now, learned)}
          title={
            <>
              <span className={r.sessionType === "Race" ? "font-semibold text-zinc-100" : "text-zinc-300"}>
                {r.meetingName} · {r.sessionName}
              </span>
              {r.circuit && <span className="ml-2 text-xs font-normal text-zinc-500">{r.circuit}</span>}
            </>
          }
        />
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------- banners + footer

function Banners() {
  const years = useLibrary((s) => s.years);
  const blocked = useLibrary((s) => s.blocked);
  const otherTab = useLibrary((s) => s.otherTab);
  const now = useNow(15_000);
  const w = liveWindowOf({ years, blocked }, now);
  if (!w && !otherTab) return null;
  return (
    <div className="space-y-1 border-b border-zinc-800 bg-amber-500/10 px-4 py-2 text-[11px] leading-relaxed text-amber-200">
      {w && (
        <p>
          <span className="font-semibold">Live session: {w.label}.</span> OpenF1 blocks free downloads from 30 minutes before a session until 30 minutes after it,
          so downloads wait until about {clockTime(w.until)} and then start by themselves.
        </p>
      )}
      {otherTab && <p>Another tab of this app is downloading. Downloads here start when it's done (one at a time keeps within OpenF1's rate limit).</p>}
    </div>
  );
}

export function Attribution({ className = "" }: { className?: string }) {
  return (
    <p className={`text-[11px] text-zinc-500 ${className}`}>
      Data from{" "}
      <a href="https://openf1.org" target="_blank" rel="noreferrer" className="text-zinc-400 underline decoration-zinc-700 underline-offset-2 hover:text-zinc-200">
        OpenF1
      </a>{" "}
      (
      <a
        href="https://creativecommons.org/licenses/by-nc-sa/4.0/"
        target="_blank"
        rel="noreferrer"
        className="underline decoration-zinc-700 underline-offset-2 hover:text-zinc-300"
      >
        CC BY-NC-SA 4.0
      </a>
      ), downloaded straight into this browser: this site doesn't host or relay any race data. Unofficial, not associated with Formula 1.
    </p>
  );
}

function StorageFooter() {
  const usage = useLibrary((s) => s.usage);
  const count = useLibrary((s) => Object.keys(s.entries).length);
  const refreshUsage = useLibrary((s) => s.refreshUsage);
  const [asking, setAsking] = useState(false);

  const persist = async () => {
    setAsking(true);
    await navigator.storage?.persist?.().catch(() => false);
    await refreshUsage();
    setAsking(false);
  };

  return (
    <div className="space-y-1 border-t border-zinc-800 px-4 py-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-zinc-400">
        <span className="tabular-nums">
          {count} {count === 1 ? "session" : "sessions"} · {usage?.usage != null ? `${size(usage.usage)} stored in this browser` : "stored in this browser"}
        </span>
        {usage?.persisted === true && <span className="text-emerald-400/90" title="The browser won't clear this site's data to free up space">✓ Persistent storage</span>}
        {usage?.persisted === false && (
          <span className="flex items-center gap-2 text-zinc-500">
            <span title="Browsers can clear a site's storage when disk space runs low, unless it's persistent">Not persistent: the browser may clear it when space runs low.</span>
            <button onClick={() => void persist()} disabled={asking} className="rounded px-1 text-zinc-300 underline decoration-zinc-600 underline-offset-2 hover:text-white">
              Keep it
            </button>
          </span>
        )}
      </div>
      <Attribution />
    </div>
  );
}

// ---------------------------------------------------------------- dialog

/**
 * Keeps keyboard focus in the dialog (Tab wraps) and stops key presses from reaching the replay's
 * window-level shortcuts (useKeyboard) behind it. Esc calls onEscape when set.
 */
function useDialogKeys(ref: RefObject<HTMLDivElement | null>, onEscape: (() => void) | null) {
  const escape = useRef(onEscape);
  escape.current = onEscape;
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    ref.current?.focus();
    const onKeyDown = (e: KeyboardEvent) => {
      // Capture phase on window runs first: nothing else sees the key, default actions (Tab, Enter on a button) still happen.
      e.stopPropagation();
      const dialog = ref.current;
      if (e.key === "Escape") {
        if (escape.current) {
          e.preventDefault();
          escape.current();
        }
        return;
      }
      if (e.key !== "Tab" || !dialog) return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>("button:not([disabled]), a[href], [tabindex]:not([tabindex='-1'])")];
      if (!focusable.length) return;
      const at = document.activeElement;
      const outside = at === dialog || !dialog.contains(at);
      if (e.shiftKey && (outside || at === focusable[0])) {
        e.preventDefault();
        focusable.at(-1)!.focus();
      } else if (!e.shiftKey && (outside || at === focusable.at(-1))) {
        e.preventDefault();
        focusable[0].focus();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      previous?.focus();
    };
  }, [ref]);
}

const TAB = "rounded px-2 py-0.5 text-xs font-semibold tabular-nums";
const tabClass = (on: boolean) => `${TAB} ${on ? "bg-zinc-100 text-zinc-900" : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"}`;

/**
 * The library and the OpenF1 calendar: downloaded sessions, and every season's races to download.
 * `firstRun`: full screen and not dismissible (nothing downloaded yet, so nothing to go back to).
 */
export function RacePicker({ firstRun = false }: { firstRun?: boolean }) {
  const tab = useLibrary((s) => s.tab);
  const filter = useLibrary((s) => s.filter);
  const setTab = useLibrary((s) => s.setTab);
  const setFilter = useLibrary((s) => s.setFilter);
  const close = useLibrary((s) => s.closePicker);
  const libraryCount = useLibrary((s) => Object.keys(s.entries).length + s.queue.length);
  const rows = useLibrary((s) => (typeof s.tab === "number" ? s.years[s.tab]?.catalog?.rows : undefined));
  const dialog = useRef<HTMLDivElement>(null);
  useDialogKeys(dialog, firstRun ? null : close);

  useEffect(() => {
    const s = useLibrary.getState();
    // First run: straight to this season's calendar.
    if (firstRun && s.tab === "library" && !Object.keys(s.entries).length && !s.queue.length) s.setTab(currentYear());
    else if (typeof s.tab === "number") void s.loadYear(s.tab);
    void s.refreshUsage();
  }, [firstRun]);

  const types = new Set(rows?.map((r) => r.sessionType));

  const panel = (
    <div
      ref={dialog}
      role="dialog"
      aria-modal="true"
      aria-labelledby="race-picker-title"
      tabIndex={-1}
      className="flex max-h-full w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900 shadow-2xl outline-none"
    >
      <div className="border-b border-zinc-800 px-4 pb-2 pt-3">
        <div className="flex items-center gap-3">
          <h2 id="race-picker-title" className="text-sm font-bold text-zinc-100">
            {firstRun ? "Pick a race to download" : "Races"}
          </h2>
          <span className="flex-1" />
          {!firstRun && (
            <button onClick={close} className={ICON} aria-label="Close (Esc)" title="Close (Esc)">
              ✕
            </button>
          )}
        </div>
        <div className="mt-2 flex items-center gap-1">
          <button onClick={() => setTab("library")} aria-pressed={tab === "library"} className={`${tabClass(tab === "library")} mr-2`}>
            Library{libraryCount ? <span className={tab === "library" ? "text-zinc-500" : "text-zinc-600"}> {libraryCount}</span> : null}
          </button>
          {[...YEARS].reverse().map((y) => (
            <button key={y} onClick={() => setTab(y)} aria-pressed={y === tab} className={tabClass(y === tab)}>
              {y}
            </button>
          ))}
          <span className="flex-1" />
          {typeof tab === "number" &&
            types.size > 1 &&
            FILTERS.map((f) => (
              <button
                key={f.id}
                onClick={() => setFilter(f.id)}
                aria-pressed={f.id === filter}
                className={`rounded px-2 py-0.5 text-[11px] font-semibold ${f.id === filter ? "bg-zinc-700 text-zinc-100" : "text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"}`}
              >
                {f.label}
              </button>
            ))}
        </div>
      </div>
      <Banners />
      <div className="min-h-0 flex-1 overflow-y-auto">{tab === "library" ? <LibraryList /> : <Calendar year={tab} />}</div>
      <StorageFooter />
    </div>
  );

  if (firstRun) {
    return (
      <div className="flex h-full flex-col items-center gap-5 overflow-hidden px-4 py-10">
        <div className="max-w-2xl text-center">
          <h1 className="text-xl font-black tracking-tight text-zinc-100">F1 Race Replay</h1>
          <p className="mt-1 text-sm text-zinc-400">
            Replay any Formula 1 race, sprint or qualifying session since 2023: car positions, telemetry, timing, tyres and race control on one timeline.
          </p>
          <p className="mt-1 text-sm text-zinc-400">
            Pick a session to download it from OpenF1 into this browser (a race takes 2–3 minutes). It's processed here, stays here, and opens when it's ready.
          </p>
        </div>
        <div className="flex min-h-0 w-full flex-1 justify-center">{panel}</div>
      </div>
    );
  }
  return (
    <div
      className="fixed inset-0 z-40 flex items-start justify-center bg-zinc-950/70 px-4 py-[6vh] backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      {panel}
    </div>
  );
}

/** Header button that opens the picker; shows progress while a download runs (here or in another tab). */
export function RacesButton() {
  const openPicker = useLibrary((s) => s.openPicker);
  const job = useLibrary((s) => Object.values(s.jobs).find((j) => isRunning(j.phase)));
  const waiting = useLibrary((s) => s.queue.length);
  const remote = useLibrary((s) => Object.values(s.remote)[0]);
  const progress = job?.progress ?? remote?.progress ?? null;

  return (
    <button
      onClick={() => openPicker()}
      className="flex shrink-0 items-center gap-1.5 rounded border border-zinc-700 px-2 py-0.5 text-xs font-semibold text-zinc-300 hover:border-zinc-500 hover:text-zinc-100"
      title={job ? `Downloading ${job.info.label}${waiting > 1 ? ` (+${waiting - 1} queued)` : ""}` : "Your library, and races to download"}
    >
      Races
      {progress && <span className="tabular-nums text-zinc-400">{Math.round(progress.progress * 100)}%</span>}
      {!progress && waiting > 0 && <span className="h-1.5 w-1.5 rounded-full bg-amber-400" title="Downloads waiting" />}
    </button>
  );
}
