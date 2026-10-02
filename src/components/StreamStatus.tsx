// A race watched while it downloads (useReplay's `stream`): the screen before its first update is in, the note over
// the replay while playback waits for the part being watched, and the timeline's indicator of the download.

import { useMemo } from "react";
import { useLibrary, rowForKey, labelOf } from "../library";
import { STREAM_EDGE_MS, streamed, useReplay } from "../store";
import { TIER_PACE } from "../ingest/eta";
import { telemetryAt } from "../ingest/runner";
import { clockTime, SECONDARY } from "./home/common";

/** The download behind the stream, and what it's doing (from the library's job). */
function useStreamJob() {
  const key = useReplay((s) => s.stream?.key ?? null);
  const job = useLibrary((s) => (key != null ? s.jobs[key] : undefined));
  const remote = useLibrary((s) => (key != null ? s.remote[key] : undefined));
  const otherTab = useLibrary((s) => s.otherTab);
  return { key, job, remote, otherTab };
}

/** Why the download isn't moving, if it isn't: waiting for another tab, OpenF1's live lockout, a retry. */
function waitingText(job: ReturnType<typeof useStreamJob>["job"], otherTab: boolean, remote: boolean): string | null {
  if (remote) return "Downloading in another tab of this app; it opens here when that's done.";
  if (!job) return null;
  if (job.phase === "queued" && otherTab) return "Another tab of this app is downloading; this starts when it's done.";
  if (job.phase === "paused") {
    const at = job.resumeAt != null && job.resumeAt - Date.now() > 90_000 ? ` Starts by itself at ${clockTime(job.resumeAt)}.` : " Starts again by itself in a moment.";
    return `${job.notice ?? "Paused."}${at}`;
  }
  return null;
}

const Spinner = () => <span className="inline-block h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-zinc-600 border-t-zinc-100" aria-hidden />;

/** Before the first update: the race's name, what's coming in, and a way back. */
export function StreamLoading() {
  const { key, job, remote, otherTab } = useStreamJob();
  // (rowForKey builds a row when the calendar doesn't have it: not a selector.)
  const years = useLibrary((s) => s.years);
  const entries = useLibrary((s) => s.entries);
  const partial = useLibrary((s) => s.partial);
  const jobs = useLibrary((s) => s.jobs);
  const row = useMemo(() => (key != null ? rowForKey(key, { years, entries, partial, jobs }) : null), [key, years, entries, partial, jobs]);
  const retry = useLibrary((s) => s.stream);
  const goHome = useReplay((s) => s.goHome);
  const p = job?.progress ?? null;
  const quali = row?.sessionType === "Qualifying";
  // Qualifying opens once it's downloaded (its lap comparison needs every lap), and so does a download begun before
  // slices (per driver); a race as soon as it can start.
  const later = quali || p?.streams === false;
  const waiting = waitingText(job, otherTab, remote != null);
  const failed = job?.phase === "failed";
  const frac = later ? (p?.progress ?? 0) : (p?.startup ?? 0);

  return (
    <div className="flex h-full items-center justify-center px-4">
      <div className="w-full max-w-md">
        <h1 className="text-lg font-black tracking-tight text-zinc-100">{row ? `${row.year} ${labelOf(row)}` : `Session ${key}`}</h1>
        <p className="text-xs text-zinc-400">{later ? "Downloading" : "Starting the replay"}</p>
        {failed ? (
          <p className="mt-3 text-sm text-red-400">{job?.error ?? "The download failed."}</p>
        ) : waiting ? (
          <p className="mt-3 text-sm text-amber-300">{waiting}</p>
        ) : (
          <>
            <div className="mt-4 h-1.5 overflow-hidden rounded bg-zinc-800" role="progressbar" aria-valuenow={Math.round(frac * 100)} aria-valuemin={0} aria-valuemax={100}>
              <div className="h-full bg-zinc-200 transition-all duration-500" style={{ width: `${Math.max(4, frac * 100)}%` }} />
            </div>
            <p className="mt-2 flex items-center gap-2 text-xs text-zinc-400">
              <Spinner />
              <span className="truncate">{p?.notice ?? p?.step ?? "Starting"}</span>
            </p>
            <p className="mt-3 text-xs leading-relaxed text-zinc-400">
              {quali
                ? "Qualifying opens once it's downloaded: the lap comparison needs every lap."
                : later
                  ? "Its download began before races could play while they download: it opens once it's done."
                  : "It plays in a few seconds and downloads the rest as you watch, into this browser: next time it opens instantly."}
            </p>
          </>
        )}
        <div className="mt-5 flex items-center gap-2">
          <button onClick={goHome} className={SECONDARY}>
            ← All races
          </button>
          {failed && row && (
            <button onClick={() => retry(row)} className={SECONDARY}>
              Try again
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** Over the blocks while playback waits for the part being watched to come in, and how much of it is in. */
export function StreamBuffering() {
  // Where playback waits (ms since t0), while it does.
  const at = useReplay((s) => {
    const { stream, session, t } = s;
    if (!stream || !session || session.meta.sessionKey !== stream.key) return null;
    return streamed(stream.spans, t, session.meta.duration) ? null : t;
  });
  const spans = useReplay((s) => s.stream?.spans);
  const t0 = useReplay((s) => s.session?.meta.t0);
  const { key, job, remote, otherTab } = useStreamJob();
  const resume = useLibrary((s) => s.stream);
  const rows = useLibrary((s) => s.years);
  if (at == null) return null;
  // Stopped (cancelled, or failed for good): it only comes in again when asked.
  const stopped = job?.phase === "failed" || job?.phase === "cancelled";
  const p = stopped ? null : job?.progress;
  // What it waits for: the telemetry at the playhead and just past it (playback stops short of the edge of what's in).
  const here =
    p && spans && t0
      ? telemetryAt(
          p.slices,
          [at, at + STREAM_EDGE_MS].filter((t) => !spans.some(([a, b]) => a <= t && t < b)).map((t) => Date.parse(t0) + t),
        )
      : null;
  // Nothing of it asked for yet: the free tier's minute of requests is used up.
  const now = Date.now();
  const slotS = here?.progress === 0 && p?.slotAt != null && p.slotAt > now ? Math.ceil((p.slotAt - now) / 1000) : null;
  const note =
    job?.phase === "failed"
      ? (job.error ?? "The download failed.")
      : job?.phase === "cancelled"
        ? "The download was stopped."
        : (waitingText(job, otherTab, remote != null) ??
          p?.notice ??
          (slotS != null
            ? `Loading this part in ${slotS} s (free tier: ${TIER_PACE.free.perMinute} requests a minute)`
            : here?.slowS != null
              ? `Still loading: OpenF1 is slow to answer (${here.slowS} s)`
              : null));
  const bar = here != null && slotS == null ? here.progress : null;
  const row = stopped && key != null ? rowForKey(key, { years: rows, entries: {}, partial: {}, jobs: { [key]: job } }) : null;
  // Dims the blocks: what they show is from before the part that's coming.
  return (
    <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-zinc-950/60">
      <div className="flex max-w-md items-center gap-2 rounded-full border border-zinc-700 bg-zinc-900/95 px-3 py-1.5 text-xs text-zinc-200 shadow-xl">
        {stopped ? <span className="text-red-400">!</span> : <Spinner />}
        <span className="truncate">{note ?? "Loading this part of the race…"}</span>
        {bar != null && (
          <>
            <span
              className="h-1 w-14 shrink-0 overflow-hidden rounded-full bg-zinc-700"
              role="progressbar"
              aria-label="This part of the race"
              aria-valuenow={Math.floor(bar * 100)}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <span className="block h-full rounded-full bg-zinc-200 transition-[width] duration-500 ease-linear" style={{ width: `${bar * 100}%` }} />
            </span>
            <span className="w-8 shrink-0 text-right tabular-nums text-zinc-400">{Math.floor(bar * 100)}%</span>
          </>
        )}
        {row && (
          <button onClick={() => resume(row)} className="pointer-events-auto shrink-0 rounded px-1.5 font-semibold text-zinc-100 hover:bg-zinc-800">
            Resume
          </button>
        )}
      </div>
    </div>
  );
}

/** By the timeline's clock: how much of the race is downloaded, while it is. */
export function StreamBadge() {
  const streaming = useReplay((s) => s.stream != null && s.session?.meta.sessionKey === s.stream.key);
  const { job } = useStreamJob();
  if (!streaming) return null;
  const frac = job?.progress?.telemetry ?? job?.progress?.progress ?? null;
  const processing = job?.progress?.phase === "processing";
  const stopped = job == null || job.phase === "failed" || job.phase === "cancelled";
  return (
    <span
      className="shrink-0 whitespace-nowrap text-[11px] tabular-nums text-zinc-400"
      title={stopped ? "The download stopped: Watch on the home page carries on from what's stored" : "Downloading into this browser as you watch: next time this race opens instantly"}
    >
      {stopped ? "↓ stopped" : processing ? "Saving…" : frac != null ? `↓ ${Math.floor(frac * 100)}%` : "↓"}
    </span>
  );
}
