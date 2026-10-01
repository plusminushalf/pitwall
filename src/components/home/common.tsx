// Shared by Home, its library and calendar, and the shared-link prompt: formatting, a session's live state in
// the library, its buttons (Watch, which downloads a session as it plays / Update / Cancel / Delete) and download
// progress.

import { useEffect, useState, type ReactNode } from "react";
import type { CatalogRow } from "../../ingest/catalog";
import { rowState, useLibrary, type Job, type RemoteJob, type RowState } from "../../library";
import { useReplay } from "../../store";

const BUTTON = "whitespace-nowrap rounded px-2.5 py-1 text-xs font-semibold transition-colors disabled:opacity-50";
export const PRIMARY = `${BUTTON} bg-zinc-100 text-zinc-900 hover:bg-white`;
export const SECONDARY = `${BUTTON} border border-zinc-700 text-zinc-200 hover:border-zinc-500 hover:text-white`;
const DANGER = `${BUTTON} bg-red-600 text-white hover:bg-red-500`;
export const LABEL = "text-[10px] font-semibold uppercase tracking-wider text-zinc-500";
const ICON = "flex h-6 w-6 shrink-0 items-center justify-center rounded text-zinc-500 hover:bg-zinc-800 hover:text-zinc-100";

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
export const date = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
export const clockTime = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
export const estimateText = (e: { seconds: number; mb: number }) => `${approx(e.seconds)} · ~${e.mb < 10 ? e.mb.toFixed(1) : Math.round(e.mb)} MB`;

/** Calendar days from `now` to `iso` (local time): "today", "tomorrow", "in 5 days". */
export function relativeDay(iso: string, now: number) {
  const days = Math.round((new Date(iso).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / 86_400_000);
  return days <= 0 ? "today" : days === 1 ? "tomorrow" : `in ${days} days`;
}

/** Session type colours: races red, sprints orange, (sprint) qualifying violet. */
export const sessionDot = (r: Pick<CatalogRow, "sessionName" | "sessionType">) =>
  r.sessionType === "Qualifying" ? "bg-violet-400" : r.sessionName === "Race" ? "bg-red-500" : "bg-orange-400";

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
    p.phase === "downloading" && p.fast != null ? (p.fast ? "fast (signed in)" : "free tier") : null,
  ].filter(Boolean);
  const watching = key != null && watchKey === key;

  return (
    <div className="mt-1.5">
      <div className="h-1.5 overflow-hidden rounded bg-zinc-800" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Download progress">
        <div className={`h-full bg-zinc-200 transition-all duration-700 ${p.phase === "processing" ? "animate-pulse" : ""}`} style={{ width: `${pct}%` }} />
      </div>
      <div className="mt-1 flex items-center gap-3 text-[11px]">
        <span className="min-w-0 flex-1 truncate tabular-nums text-zinc-400">{details.join(" · ")}</span>
        {job && key != null && !streaming && (
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
      {loaded ? "Continue" : "Watch"}
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
            {loaded ? "Continue" : "Watch"}
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
      <p className="mt-1 text-[11px] text-red-400">
        {job.error ?? "Download failed"}
        {state.cache && job.errorKind !== "raw-missing" && <span className="text-zinc-500"> · Downloaded files are kept; Retry continues from them.</span>}
      </p>
    );
  }
  return <JobProgress job={job} />;
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

/** Covers a card (or row) with one button, so a click anywhere on it watches the session; its own controls sit above (`relative z-10`). */
export function CardButton({ label, onClick }: { label: string; onClick: () => void }) {
  return <button onClick={onClick} aria-label={label} title={label} className="absolute inset-0 z-0 rounded-[inherit] focus-visible:outline-2 focus-visible:outline-zinc-400" />;
}
