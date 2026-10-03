// Shared by Home (its Continue rows, jump results and season sheet) and the shared-link prompt: formatting, a
// session's live state in the library, its buttons (Watch, which downloads a session as it plays / Update / Cancel /
// Delete) and download progress. Styles follow the replay screen: grey controls, one white button per page, labels
// in zinc-400 (zinc-500 is under 4.5:1 on the page's near-black).

import { useEffect, useState, type ReactNode } from "react";
import type { CatalogRow } from "../../ingest/catalog";
import { liveWindowOf, rowState, useLibrary, type Job, type RemoteJob, type RowState } from "../../library";
import { useVault } from "../vault/useVault";
import { useReplay } from "../../store";

export const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-300";
const BUTTON = `whitespace-nowrap rounded-md px-2.5 py-1 text-xs font-semibold transition-colors disabled:opacity-50 ${FOCUS}`;
/** The page's one filled button: whatever can be done right now. */
export const PRIMARY = `${BUTTON} bg-zinc-100 text-zinc-950 hover:bg-white`;
export const SECONDARY = `${BUTTON} bg-zinc-800 text-zinc-100 hover:bg-zinc-700 hover:text-white`;
const DANGER = `${BUTTON} bg-red-600 text-white hover:bg-red-500`;
/** Column headers and small labels, as on the replay screen. */
export const LABEL = "text-[11px] font-semibold uppercase tracking-wider text-zinc-400";
const ICON = `flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 ${FOCUS}`;

/** Up-front estimate: "~45s", "~1.5 min", "~12 min". */
export const approx = (s: number) =>
  s < 60 ? `~${Math.max(1, Math.round(s))}s` : s < 600 ? `~${Math.round(s / 30) / 2} min` : `~${Math.round(s / 60)} min`;
/** Countdown: "~45s left", "~2.5 min left". */
export const left = (s: number) => (s < 90 ? `~${Math.max(1, Math.ceil(s))}s left` : `${approx(s)} left`);
export const mb = (bytes: number) => {
  const v = bytes / 1e6;
  return v < 10 ? v.toFixed(1) : String(Math.round(v));
};
export const size = (bytes: number) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : `${mb(bytes)} MB`);
export const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
export const clockTime = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
export const estimateText = (e: { seconds: number; mb: number }) => `${approx(e.seconds)} · ~${e.mb < 10 ? e.mb.toFixed(1) : Math.round(e.mb)} MB`;
/** "Sat 3 Oct, 09:00" (local time). */
export const sessionTime = (iso: string) => new Date(iso).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
/** "Sat 09:00" (local time). */
export const dayTime = (iso: string) => new Date(iso).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" });
/** "Azerbaijan GP". */
export const shortGp = (name: string) => name.replace(/ Grand Prix$/, " GP");
/** "24–26 Sep", "30 Nov – 1 Dec". */
export function dateRange(from: string, to: string) {
  const a = new Date(from);
  const b = new Date(to);
  const month = (d: Date) => d.toLocaleDateString(undefined, { month: "short" });
  if (a.toDateString() === b.toDateString()) return `${a.getDate()} ${month(a)}`;
  return a.getMonth() === b.getMonth() ? `${a.getDate()}–${b.getDate()} ${month(b)}` : `${a.getDate()} ${month(a)} – ${b.getDate()} ${month(b)}`;
}

/**
 * Dev server only: `?now=2026-10-03T08:30Z` (or ms since epoch) runs Home's clock from that moment, to check its
 * countdowns and live states. Read once when the page loads; the clock keeps ticking from there.
 */
const NOW_OFFSET = (() => {
  if (!import.meta.env.DEV || typeof location === "undefined") return 0;
  const v = new URLSearchParams(location.search).get("now");
  const at = v == null ? NaN : /^\d+$/.test(v) ? Number(v) : Date.parse(v);
  return Number.isNaN(at) ? 0 : at - Date.now();
})();

/** The time Home works with (Date.now(), unless overridden in dev with `?now=`). */
export const appNow = () => Date.now() + NOW_OFFSET;

/** Re-render every `ms` (countdowns, live windows). */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(appNow);
  useEffect(() => {
    const id = setInterval(() => setNow(appNow()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

/**
 * Until when OpenF1 blocks this browser's downloads (30 minutes either side of a live session, free tier only), or
 * null: not now, or signed in to an OpenF1 account, which isn't blocked.
 */
export function useDownloadBlock(): number | null {
  const years = useLibrary((s) => s.years);
  const blocked = useLibrary((s) => s.blocked);
  const vault = useVault();
  const now = useNow(15_000);
  const signedIn = vault.phase === "ready" && vault.status?.state === "connected";
  return signedIn ? null : (liveWindowOf({ years, blocked }, now)?.until ?? null);
}

/** "Downloads wait until about 10:30: …". */
export const waitText = (until: number) =>
  `Downloads wait until about ${clockTime(until)}: OpenF1 blocks free downloads from 30 minutes before a session until 30 minutes after it.`;

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
  // Being watched while it downloads: it's open already.
  const streaming = useReplay((s) => s.stream != null && s.stream.key === (job?.info.key ?? remote?.key));
  const otherTab = useLibrary((s) => s.otherTab);
  const now = useNow(1000);
  const p = job?.progress ?? remote?.progress ?? null;
  const key = job?.info.key ?? remote?.key;

  if (job && job.phase === "queued") {
    return otherTab ? <p className="mt-1 text-xs text-zinc-400">Another tab is downloading; this starts when it's done.</p> : null;
  }
  if (job && job.phase === "paused") {
    const wait = job.resumeAt != null ? Math.max(0, job.resumeAt - now) : null;
    return (
      <p className="mt-1 text-xs text-amber-300">
        {job.notice ?? "Paused"}
        {wait != null && (wait > 90_000 ? ` Starts by itself at ${clockTime(job.resumeAt!)}.` : ` Starts by itself in ${Math.ceil(wait / 1000)}s.`)}
      </p>
    );
  }
  if (!p) return null;
  const pct = Math.round(p.progress * 100);
  const details = [
    remote ? "In another tab" : null,
    p.phase === "processing" ? "Preparing the replay" : null,
    p.phase === "downloading" ? `${p.cachedFiles} of ${p.expectedFiles} files` : null,
    p.phase === "downloading" && p.totalBytes > 0 ? `${mb(p.cachedBytes)} of ~${mb(p.totalBytes)} MB` : null,
    p.phase === "downloading" && p.fast != null ? (p.fast ? "fast (signed in)" : "free tier") : null,
  ].filter(Boolean);
  const watching = key != null && watchKey === key;

  return (
    <div className="mt-1.5">
      <div className="h-1 overflow-hidden rounded-full bg-zinc-800" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Download progress">
        <div
          className={`h-full origin-left bg-zinc-300 transition-transform duration-700 ease-out ${p.phase === "processing" ? "animate-pulse" : ""}`}
          style={{ transform: `scaleX(${pct / 100})` }}
        />
      </div>
      <div className="mt-1 flex items-center gap-3 text-xs">
        <span className="min-w-0 flex-1 truncate tabular-nums text-zinc-400" title={p.step || undefined}>
          {details.join(" · ")}
        </span>
        {job && key != null && !streaming && (
          <button
            onClick={() => setWatch(watching ? null : key)}
            aria-pressed={watching}
            className={`flex shrink-0 items-center gap-1 rounded px-1 hover:bg-zinc-800 ${FOCUS} ${watching ? "text-zinc-100" : "text-zinc-400 hover:text-zinc-100"}`}
            title={watching ? "Don't switch to this session when it's ready" : "Switch to this session when it's ready"}
          >
            {watching && <Glyph name="check" />}
            {watching ? "Opens when ready" : "Open when ready"}
          </button>
        )}
      </div>
      {p.notice && <p className="mt-0.5 text-xs text-amber-300">{p.notice}</p>}
    </div>
  );
}

const muted = (text: ReactNode) => <span className="whitespace-nowrap text-xs text-zinc-400">{text}</span>;

// ---------------------------------------------------------------- glyphs

const GLYPHS = {
  play: "M5 3v10l8-5z",
  playOutline: "M5 3.5v9l7-4.5z",
  wait: "M8 4.5V8l2.5 1.5M14 8A6 6 0 1 1 2 8a6 6 0 0 1 12 0",
  retry: "M13 8a5 5 0 1 1-1.5-3.6M13 2.5v2.5h-2.5",
  trash: "M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4M6.8 6.5v4.5M9.2 6.5v4.5",
  check: "M3 8.5l3.2 3L13 4.5",
  search: "M7 12.5a5.5 5.5 0 1 1 0-11 5.5 5.5 0 0 1 0 11ZM11 11l3.5 3.5",
};

/** The home screen's icons: 16-unit paths, 1.5 stroke (the play triangle filled). */
export function Glyph({ name, className = "h-3 w-3" }: { name: keyof typeof GLYPHS; className?: string }) {
  const solid = name === "play";
  return (
    <svg viewBox="0 0 16 16" className={`shrink-0 ${className}`} aria-hidden fill={solid ? "currentColor" : "none"} stroke="currentColor" strokeWidth={solid ? 0 : 1.5}>
      <path d={GLYPHS[name]} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function TrashButton({ sessionKey, title, className = "", tabIndex }: { sessionKey: number; title: string; className?: string; tabIndex?: number }) {
  const askDelete = useLibrary((s) => s.askDelete);
  return (
    <button tabIndex={tabIndex} onClick={() => askDelete(sessionKey)} className={`${ICON} ${className}`} aria-label={title} title={title}>
      <Glyph name="trash" className="h-3.5 w-3.5" />
    </button>
  );
}

/** Stored bytes of a session that can be deleted (downloaded, or partly), else null. */
export const storedBytes = (s: RowState) =>
  s.kind === "ready" || s.kind === "stale" ? s.entry.processedBytes + s.entry.rawBytes : s.kind === "partial" ? s.cache.cachedBytes : s.kind === "job" && s.job.phase === "failed" && s.cache ? s.cache.cachedBytes : null;

/** What opening a session in this state does (Enter on a jump result, a row's button), or null when it can't be opened. */
export function openAction(row: CatalogRow, state: RowState): (() => void) | null {
  const s = useLibrary.getState();
  switch (state.kind) {
    case "ready":
      return () => s.watchNow(row.sessionKey);
    case "stale":
      return () => s.reprocess(state.entry);
    case "available":
    case "partial":
      return () => s.stream(row);
    case "job":
      // A download can be watched as it comes in; an update (re-processing) can't until it's done.
      return state.job.phase === "failed" || state.job.info.mode === "download" ? () => s.stream(row) : null;
    default:
      return null;
  }
}

export { DANGER };

/**
 * The buttons for a session in its current state. `compact`: no sizes or estimates beside them (in tooltips
 * instead); `quiet`: outlined buttons only (Home's library, below its one filled button on the latest race).
 */
export function Action({ row, state, compact = false, quiet = false }: { row: CatalogRow; state: RowState; compact?: boolean; quiet?: boolean }) {
  const stream = useLibrary((s) => s.stream);
  const reprocess = useLibrary((s) => s.reprocess);
  const cancel = useLibrary((s) => s.cancel);
  const watchNow = useLibrary((s) => s.watchNow);
  const confirming = useLibrary((s) => s.confirmDelete === row.sessionKey);
  const askDelete = useLibrary((s) => s.askDelete);
  const remove = useLibrary((s) => s.remove);
  // Left for Home: Watch picks it up where it was.
  const loaded = useReplay((s) => s.mode === "replay" && (s.session?.meta.sessionKey === row.sessionKey || s.stream?.key === row.sessionKey));
  const key = row.sessionKey;
  const primary = quiet ? SECONDARY : PRIMARY;
  const watch = (title: string) => (
    <button onClick={() => stream(row)} className={primary} title={title}>
      {loaded ? "Resume" : "Watch"}
    </button>
  );

  if (confirming) {
    const bytes = state.kind === "ready" || state.kind === "stale" ? state.entry.processedBytes + state.entry.rawBytes : state.kind === "partial" ? state.cache.cachedBytes : 0;
    return (
      <>
        <span className="whitespace-nowrap text-xs text-zinc-300">Delete{bytes ? ` ${size(bytes)}` : ""}?</span>
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
    case "ready": {
      const bytes = size(state.entry.processedBytes + state.entry.rawBytes);
      return (
        <>
          {!compact && muted(bytes)}
          <button onClick={() => watchNow(key)} className={primary} title={compact ? `Stored in this browser (${bytes})` : undefined}>
            {loaded ? "Resume" : "Watch"}
          </button>
          <TrashButton sessionKey={key} title="Delete from this browser" />
        </>
      );
    }
    case "stale":
      return (
        <>
          {!compact && muted("Needs an update")}
          <button
            onClick={() => reprocess(state.entry)}
            className={primary}
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
            <button onClick={() => stream(row)} className={SECONDARY} title={cached ? "Watch it; the download carries on from what's stored" : "Try again"}>
              Retry
            </button>
            {cached && <TrashButton sessionKey={key} title="Discard the partial download" />}
          </>
        );
      }
      const watchable = job.info.mode === "download";
      if (job.phase === "queued" || job.phase === "paused") {
        return (
          <>
            {muted(job.phase === "paused" ? "Waiting" : "Queued")}
            {watchable && watch("Watch it now: its download goes first")}
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
          {watchable && watch("Watch it while it downloads")}
          <button onClick={() => cancel(key)} className={SECONDARY} title="Stop; what's downloaded so far is kept">
            Cancel
          </button>
        </>
      );
    }
    case "partial":
      return (
        <>
          {!compact && muted(`${approx(state.estimate.seconds)} left to download`)}
          {watch(`Watch it; the rest downloads as you watch (${approx(state.estimate.seconds)} left)`)}
          <TrashButton sessionKey={key} title="Discard the partial download" />
        </>
      );
    case "available":
      return (
        <>
          {!compact && muted(estimateText(state.estimate))}
          {watch(`Plays in a few seconds; downloads into this browser as you watch (${estimateText(state.estimate)})`)}
        </>
      );
  }
}

/** Progress, pause reasons and errors under a session. */
export function RowDetails({ state }: { state: RowState }) {
  if (state.kind === "remote") return <JobProgress remote={state.job} />;
  if (state.kind !== "job") return null;
  const { job } = state;
  if (job.phase === "failed") {
    return (
      <p className="mt-1 text-xs text-red-400">
        {job.error ?? "Download failed"}
        {state.cache && job.errorKind !== "raw-missing" && <span className="text-zinc-400"> · Downloaded files are kept; Retry continues from them.</span>}
      </p>
    );
  }
  return <JobProgress job={job} />;
}

export function Attribution({ className = "" }: { className?: string }) {
  return (
    <p className={`max-w-[75ch] text-xs leading-relaxed text-zinc-400 ${className}`}>
      Data from{" "}
      <a href="https://openf1.org" target="_blank" rel="noreferrer" className={`rounded-sm text-zinc-300 underline decoration-zinc-600 underline-offset-2 hover:text-zinc-100 ${FOCUS}`}>
        OpenF1
      </a>{" "}
      (
      <a
        href="https://creativecommons.org/licenses/by-nc-sa/4.0/"
        target="_blank"
        rel="noreferrer"
        className={`rounded-sm underline decoration-zinc-600 underline-offset-2 hover:text-zinc-200 ${FOCUS}`}
      >
        CC BY-NC-SA 4.0
      </a>
      ), downloaded into this browser: this site doesn't host or keep any race data (during live sessions, signed-in requests pass through its account vault). Unofficial,
      not associated with Formula 1.
    </p>
  );
}

