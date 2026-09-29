import { useEffect, useMemo, useRef, type ReactNode, type RefObject } from "react";
import type { JobView, RaceRow } from "../data/ingestTypes";
import { currentYear, FIRST_YEAR, isActive, useDownloads, type RaceFilter } from "../downloads";
import { useReplay } from "../store";

const YEARS = Array.from({ length: currentYear() - FIRST_YEAR + 1 }, (_, i) => FIRST_YEAR + i);

const FILTERS: { id: RaceFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "Race", label: "Races" },
  { id: "Qualifying", label: "Qualifying" },
];

const BUTTON = "whitespace-nowrap rounded px-2.5 py-1 text-xs font-semibold transition-colors";
const PRIMARY = `${BUTTON} bg-zinc-100 text-zinc-900 hover:bg-white`;
const SECONDARY = `${BUTTON} border border-zinc-700 text-zinc-200 hover:border-zinc-500 hover:text-white`;

/** Up-front estimate: "~45s", "~1.5 min", "~12 min". */
const approx = (s: number) =>
  s < 60 ? `~${Math.max(1, Math.round(s))}s` : s < 600 ? `~${Math.round(s / 30) / 2} min` : `~${Math.round(s / 60)} min`;
/** Countdown: "~45s left", "~2.5 min left". */
const left = (s: number) => (s < 90 ? `~${Math.max(1, Math.ceil(s))}s left` : `${approx(s)} left`);
const mb = (bytes: number) => {
  const v = bytes / 1e6;
  return v < 10 ? v.toFixed(1) : String(Math.round(v));
};
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });

interface Meeting {
  key: number;
  name: string;
  round: number | null;
  circuit: string;
  country: string;
  rows: RaceRow[];
}

/** Rows (in date order) grouped by meeting. */
function byMeeting(rows: RaceRow[]): Meeting[] {
  const meetings = new Map<number, Meeting>();
  for (const r of rows) {
    let m = meetings.get(r.meetingKey);
    if (!m) meetings.set(r.meetingKey, (m = { key: r.meetingKey, name: r.meetingName, round: r.round, circuit: r.circuit, country: r.country, rows: [] }));
    m.round ??= r.round;
    m.rows.push(r);
  }
  return [...meetings.values()];
}

function JobProgress({ job }: { job: JobView }) {
  const watchKey = useDownloads((s) => s.watchKey);
  const setWatch = useDownloads((s) => s.setWatch);
  const watching = watchKey === job.key;
  const pct = Math.round(job.progress * 100);
  const details = [
    job.step,
    job.phase === "queued" ? null : `${job.cachedFiles}/${job.expectedFiles} files`,
    job.phase === "queued" ? null : `${mb(job.cachedBytes)} / ~${mb(job.totalBytes)} MB`,
  ].filter(Boolean);

  return (
    <div className="mt-1.5">
      {job.phase !== "queued" && (
        <div className="h-1.5 overflow-hidden rounded bg-zinc-800" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={`${job.label} download`}>
          <div className={`h-full bg-zinc-200 transition-all duration-700 ${job.phase === "processing" ? "animate-pulse" : ""}`} style={{ width: `${pct}%` }} />
        </div>
      )}
      <div className="mt-1 flex items-center gap-3 text-[11px]">
        <span className="min-w-0 flex-1 truncate tabular-nums text-zinc-400">{details.join(" · ")}</span>
        <button
          onClick={() => setWatch(watching ? null : job.key)}
          className={`shrink-0 rounded px-1 hover:bg-zinc-800 ${watching ? "text-zinc-200" : "text-zinc-500 hover:text-zinc-200"}`}
          title={watching ? "Don't switch to this session when it's ready" : "Switch to this session when it's ready"}
        >
          {watching ? "✓ Opens when ready" : "Open when ready"}
        </button>
      </div>
      {job.retryNotice && <p className="mt-0.5 text-[11px] text-amber-300">{job.retryNotice}</p>}
    </div>
  );
}

function Action({ row, job, current }: { row: RaceRow; job: JobView | undefined; current: boolean }) {
  const download = useDownloads((s) => s.download);
  const cancel = useDownloads((s) => s.cancel);
  const watch = useDownloads((s) => s.watch);
  const key = row.sessionKey;
  const muted = (text: ReactNode) => <span className="whitespace-nowrap text-xs text-zinc-500">{text}</span>;

  if (job && isActive(job.phase)) {
    if (job.phase === "queued") {
      return (
        <>
          {muted(`Queued${job.queuePosition && job.queuePosition > 1 ? ` (#${job.queuePosition})` : ""}`)}
          <button onClick={() => cancel(key)} className={SECONDARY}>
            Cancel
          </button>
        </>
      );
    }
    return (
      <>
        <span className="whitespace-nowrap text-xs tabular-nums text-zinc-300">
          {Math.round(job.progress * 100)}%{job.etaSeconds != null ? ` · ${left(job.etaSeconds)}` : ""}
        </span>
        <button onClick={() => cancel(key)} className={SECONDARY} title="Pause; downloaded files are kept">
          Pause
        </button>
      </>
    );
  }
  if (row.status === "ready" || job?.phase === "done") {
    return current ? (
      muted("Watching")
    ) : (
      <button onClick={() => watch(key)} className={PRIMARY}>
        Watch
      </button>
    );
  }
  if (row.status === "not-run") return muted("Upcoming");
  if (row.status === "cancelled") return muted("Cancelled");

  // A paused / failed job knows the latest file count; the listing may predate it.
  const cached = job && job.cachedFiles > 0 ? job : row.status === "partial" ? row : null;
  const estimate = row.estimate ? `${approx(row.estimate.seconds)} · ~${row.estimate.mb < 10 ? row.estimate.mb.toFixed(1) : Math.round(row.estimate.mb)} MB` : null;
  return (
    <>
      {estimate && muted(estimate)}
      <button
        onClick={() => download(key, { watch: true })}
        className={cached ? SECONDARY : PRIMARY}
        title={cached ? "Continue from the files already downloaded" : "Download from OpenF1 and process locally"}
      >
        {cached ? `Resume · ${cached.cachedFiles}/${cached.expectedFiles} files` : "Download"}
      </button>
    </>
  );
}

function SessionRow({ row, job }: { row: RaceRow; job: JobView | undefined }) {
  const current = useReplay((s) => s.session?.meta.sessionKey === row.sessionKey);
  const error = useDownloads((s) => s.actionErrors[row.sessionKey]);
  const isRace = row.sessionType === "Race";
  const dim = row.status === "cancelled" || row.status === "not-run";

  return (
    <li className={`py-1.5 pl-14 pr-4 ${current ? "bg-zinc-800/40" : ""}`}>
      <div className="flex min-h-7 items-center gap-3">
        <span className={`w-24 shrink-0 text-xs tabular-nums ${dim ? "text-zinc-600" : "text-zinc-500"}`}>{day(row.dateStart)}</span>
        <span className={`min-w-0 flex-1 truncate text-sm ${dim ? "text-zinc-600" : isRace ? "font-semibold text-zinc-100" : "text-zinc-300"} ${row.status === "cancelled" ? "line-through" : ""}`}>
          {row.sessionName}
        </span>
        <span className="flex shrink-0 items-center gap-3">
          <Action row={row} job={job} current={current} />
        </span>
      </div>
      {job && isActive(job.phase) && <JobProgress job={job} />}
      {job?.phase === "failed" && (
        <p className="mt-1 text-[11px] text-red-400">
          {job.error ?? "Download failed"} <span className="text-zinc-500">· Downloaded files are kept; Resume continues from them.</span>
        </p>
      )}
      {error && <p className="mt-1 text-[11px] text-red-400">{error}</p>}
    </li>
  );
}

function Unavailable() {
  const code = "rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-[12px] text-zinc-200";
  return (
    <div className="space-y-3 px-5 py-6 text-sm text-zinc-400">
      <p className="text-zinc-200">The race downloader runs inside the dev server, which isn't serving it here.</p>
      <p>
        Start the app with <code className={code}>bun run dev</code> and open it from there, or download races from a terminal:
      </p>
      <pre className="overflow-x-auto rounded border border-zinc-800 bg-zinc-950 p-3 font-mono text-[12px] leading-relaxed text-zinc-300">
        {`bun run races ${currentYear()}      # list races and their session keys\nbun run ingest <session_key>   # download + process one`}
      </pre>
      <p>Then reload this page.</p>
    </div>
  );
}

function TierBadge() {
  const tier = useDownloads((s) => s.tier);
  if (!tier) return null;
  return tier === "sponsor" ? (
    <span className="whitespace-nowrap rounded bg-emerald-500/15 px-1.5 py-0.5 text-[11px] font-semibold text-emerald-300" title="OpenF1 credentials are set on the dev server">
      Sponsor tier: faster downloads
    </span>
  ) : (
    <span
      className="whitespace-nowrap rounded bg-zinc-800 px-1.5 py-0.5 text-[11px] font-semibold text-zinc-400"
      title="Set OPENF1_USERNAME and OPENF1_PASSWORD in .env for OpenF1's sponsor tier (twice the request rate)"
    >
      Free tier
    </span>
  );
}

function RaceList() {
  const year = useDownloads((s) => s.year);
  const state = useDownloads((s) => (s.year != null ? s.years[s.year] : undefined));
  const jobs = useDownloads((s) => s.jobs);
  const filter = useDownloads((s) => s.filter);
  const loadYear = useDownloads((s) => s.loadYear);
  const rows = state?.rows;
  const meetings = useMemo(() => byMeeting((rows ?? []).filter((r) => filter === "all" || r.sessionType === filter)), [rows, filter]);

  if (!rows) {
    if (state?.error) {
      return (
        <div className="px-5 py-6 text-sm">
          <p className="text-red-400">{state.error}</p>
          <button onClick={() => year != null && loadYear(year)} className={`${SECONDARY} mt-3`}>
            Retry
          </button>
        </div>
      );
    }
    return <p className="px-5 py-6 text-sm text-zinc-500">Loading the {year ?? ""} calendar from OpenF1…</p>;
  }
  if (!meetings.length) return <p className="px-5 py-6 text-sm text-zinc-500">No sessions listed for {year} yet.</p>;
  return (
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
              <SessionRow key={r.sessionKey} row={r} job={jobs[r.sessionKey]} />
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}

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

/**
 * Pick a race to watch or download: year tabs, one row per session with its download status.
 * `firstRun`: full screen and not dismissible (nothing downloaded yet, so nothing to go back to).
 */
export function RacePicker({ firstRun = false }: { firstRun?: boolean }) {
  const available = useDownloads((s) => s.available);
  const year = useDownloads((s) => s.year);
  const rows = useDownloads((s) => (s.year != null ? s.years[s.year]?.rows : undefined));
  const filter = useDownloads((s) => s.filter);
  const setYear = useDownloads((s) => s.setYear);
  const setFilter = useDownloads((s) => s.setFilter);
  const close = useDownloads((s) => s.closePicker);
  const dialog = useRef<HTMLDivElement>(null);
  useDialogKeys(dialog, firstRun ? null : close);

  useEffect(() => {
    void useDownloads.getState().refresh();
  }, []);

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
            {firstRun ? "Download a race to get started" : "Races"}
          </h2>
          <span className="flex-1" />
          <TierBadge />
          {!firstRun && (
            <button onClick={close} className="flex h-6 w-6 items-center justify-center rounded text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100" aria-label="Close (Esc)" title="Close (Esc)">
              ✕
            </button>
          )}
        </div>
        {available !== false && (
          <div className="mt-2 flex items-center gap-1">
            {YEARS.map((y) => (
              <button
                key={y}
                onClick={() => setYear(y)}
                aria-pressed={y === year}
                className={`rounded px-2 py-0.5 text-xs font-semibold tabular-nums ${y === year ? "bg-zinc-100 text-zinc-900" : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"}`}
              >
                {y}
              </button>
            ))}
            <span className="flex-1" />
            {types.size > 1 &&
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
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">{available === false ? <Unavailable /> : <RaceList />}</div>
      {available !== false && (
        <p className="border-t border-zinc-800 px-4 py-2 text-[11px] text-zinc-500">
          Downloads are cached in <span className="font-mono">data/raw/</span>, so a paused or failed download picks up where it stopped. A race is ~13 MB
          to download and ~20 MB once processed.
        </p>
      )}
    </div>
  );

  if (firstRun) {
    return (
      <div className="flex h-full flex-col items-center gap-5 overflow-hidden px-4 py-10">
        <div className="max-w-2xl text-center">
          <h1 className="text-xl font-black tracking-tight text-zinc-100">F1 Race Replay</h1>
          <p className="mt-1 text-sm text-zinc-400">
            Race data isn't bundled (F1 timing data can't be redistributed). Pick a session to download it from OpenF1; it's processed on this machine and
            opens when it's ready.
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

/** Header button that opens the picker; shows progress while a download runs. */
export function RacesButton() {
  const openPicker = useDownloads((s) => s.openPicker);
  const jobs = useDownloads((s) => s.jobs);
  // Pick up downloads already running on the dev server (e.g. after a page reload).
  useEffect(() => {
    void useDownloads.getState().refreshJobs();
  }, []);
  const running = Object.values(jobs).filter((j) => j.phase === "downloading" || j.phase === "processing");
  const queued = Object.values(jobs).filter((j) => j.phase === "queued").length;
  const job = running[0];

  return (
    <button
      onClick={openPicker}
      className="flex shrink-0 items-center gap-1.5 rounded border border-zinc-700 px-2 py-0.5 text-xs font-semibold text-zinc-300 hover:border-zinc-500 hover:text-zinc-100"
      title={job ? `Downloading ${job.label}${queued ? ` (+${queued} queued)` : ""}` : "Watch or download races"}
    >
      Races
      {job && <span className="tabular-nums text-zinc-400">{Math.round(job.progress * 100)}%</span>}
    </button>
  );
}
