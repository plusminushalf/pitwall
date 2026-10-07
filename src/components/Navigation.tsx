// The way back to Home (or the circuit's page it was opened from) from a session, with the download activity, and the
// note that a download finished while a replay is on screen.

import { useEffect } from "react";
import { Icon } from "../widgetkit/ui/Icon";
import { rowsAt } from "../circuit";
import { isRunning, useLibrary } from "../library";
import { useReplay } from "../store";

/**
 * Header control back to Home, or to the circuit's page a session was opened from (named for it); shows progress
 * while a download runs (here or in another tab).
 */
export function RacesButton() {
  const goHome = useReplay((s) => s.goHome);
  const from = useReplay((s) => (s.view === "replay" ? s.circuit : null));
  const fromName = useLibrary((s) => (from ? (rowsAt(from, Object.values(s.years).map((y) => y.catalog)).at(-1)?.circuit ?? null) : null));
  const job = useLibrary((s) => Object.values(s.jobs).find((j) => isRunning(j.phase)));
  const waiting = useLibrary((s) => s.queue.length);
  const remote = useLibrary((s) => Object.values(s.remote)[0]);
  const progress = job?.progress ?? remote?.progress ?? null;

  return (
    <button
      onClick={(e) => {
        e.currentTarget.blur();
        goHome();
      }}
      className="touch-hit flex shrink-0 items-center gap-1.5 rounded-md bg-zinc-800 py-1 pl-1.5 pr-2.5 text-xs font-semibold text-zinc-100 hover:bg-zinc-700 hover:text-white"
      title={
        job
          ? `${from ? `Back to ${fromName ?? "the circuit"}` : "All races"} · downloading ${job.info.label}${waiting > 1 ? ` (+${waiting - 1} queued)` : ""}`
          : from
            ? `Back to ${fromName ?? "the circuit"}: every session there, and its history`
            : "All races: your library and every season's calendar"
      }
    >
      <Icon name="chevron-left" size={14} className="[&_path]:[stroke-width:2]" />
      <span className="max-w-32 truncate">{from ? (fromName ?? "Circuit") : "Races"}</span>
      {progress && <span className="tabular-nums font-normal text-zinc-400">{Math.round(progress.progress * 100)}%</span>}
      {!progress && waiting > 0 && <span className="h-1.5 w-1.5 rounded-full bg-amber-400" title="Downloads waiting" />}
    </button>
  );
}

const TOAST_MS = 15_000;

/** "<Race> is ready · Watch", for a download that finished while watching something else. */
export function ReadyToast() {
  const toast = useLibrary((s) => s.toast);
  const dismiss = useLibrary((s) => s.dismissToast);
  const watchNow = useLibrary((s) => s.watchNow);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(dismiss, TOAST_MS);
    return () => clearTimeout(id);
  }, [toast, dismiss]);

  if (!toast) return null;
  return (
    // On a phone: across the screen, under its two-row header.
    <div
      role="status"
      className="fixed right-4 top-16 z-40 flex items-center gap-3 rounded-lg border border-zinc-700 bg-zinc-900/95 py-2 pl-3 pr-2 text-xs shadow-2xl backdrop-blur max-md:left-3 max-md:right-3 max-md:top-[calc(5.5rem_+_env(safe-area-inset-top))]"
    >
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400" />
      <span className="min-w-0 flex-1 text-zinc-200">
        <span className="font-semibold">{toast.label}</span> is ready
      </span>
      <button
        onClick={(e) => {
          e.currentTarget.blur();
          watchNow(toast.key);
        }}
        className="touch-hit shrink-0 rounded bg-zinc-100 px-2 py-0.5 font-semibold text-zinc-900 hover:bg-white"
      >
        Watch
      </button>
      <button onClick={dismiss} className="touch-hit flex h-5 w-5 shrink-0 items-center justify-center rounded text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100" aria-label="Dismiss">
        <Icon name="close" size={12} />
      </button>
    </div>
  );
}
