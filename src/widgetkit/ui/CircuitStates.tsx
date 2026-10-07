// What the circuit widgets show besides their races (DESIGN.md, Circuit widgets): placeholders shaped like what's
// loading, the results hidden behind a Show button (spoilers), and why something didn't load, with Try again. The
// widget's own header stays above them throughout, so nothing jumps when the races come in.

import type { CSSProperties, ReactNode } from "react";
import type { CircuitRaces } from "../circuit";

/** A placeholder for something still loading: a grey block, pulsing unless the user asked for less motion. */
export function Skeleton({ className = "", style }: { className?: string; style?: CSSProperties }) {
  return <span aria-hidden className={`block rounded-sm bg-zinc-800 motion-safe:animate-pulse ${className}`} style={style} />;
}

const BUTTON = "rounded-md bg-zinc-800 px-2.5 py-1 text-xs font-semibold text-zinc-100 hover:bg-zinc-700 hover:text-white";

/** Loads again what didn't load. */
export function RetryButton({ onClick, className = "" }: { onClick: () => void; className?: string }) {
  return (
    <button type="button" onClick={onClick} className={`${BUTTON} ${className}`}>
      Try again
    </button>
  );
}

/**
 * The widget's body when it isn't showing races: results hidden (`what` names them: "Safety cars"), the calendar
 * that says which races there are didn't load, or there are none. Null when the widget lays out its races (loaded or
 * loading); `loading` is what it shows while the calendar itself loads.
 */
export function circuitNotice(data: CircuitRaces, what: string, loading: ReactNode): ReactNode | null {
  const at = data.circuit ? ` at ${data.circuit}` : "";
  if (data.hidden) {
    return (
      <div className="flex flex-1 flex-col items-start justify-center gap-2 text-xs text-zinc-300">
        <p className="max-w-[48ch]">
          {what}
          {at} give away how races ended, so they're hidden.
        </p>
        <button type="button" onClick={data.reveal} className={BUTTON}>
          Show
        </button>
      </div>
    );
  }
  if (data.total > 0) return null;
  if (data.calendarError && data.ready) {
    return (
      <div className="flex flex-1 flex-col items-start justify-center gap-2 text-xs">
        <p className="text-red-400">Couldn't load the calendar from OpenF1, so the earlier races{at} aren't known yet.</p>
        <RetryButton onClick={data.retry} />
      </div>
    );
  }
  if (!data.ready) return <>{loading}</>;
  return <p className="flex flex-1 items-center text-xs text-zinc-400">No earlier races{at} in OpenF1's data (it starts in 2023).</p>;
}

/** The header's right: how far the races have loaded, which didn't (with Try again), or else `done`. */
export function CircuitProgress({ data, done }: { data: CircuitRaces; done: ReactNode }) {
  const failed = data.entries.filter((e) => e.error).length;
  if (data.hidden || data.total === 0) return null;
  if (data.pending > 0)
    return (
      <span className="tabular-nums text-zinc-400" aria-live="polite">
        Loading {data.total - data.pending} of {data.total}
      </span>
    );
  if (failed > 0)
    return (
      <span className="flex items-center gap-2">
        <span className="tabular-nums text-red-400">{failed === data.total ? "Didn't load" : `${failed} didn't load`}</span>
        <RetryButton onClick={data.retry} className="!px-2 !py-0.5" />
      </span>
    );
  return <>{done}</>;
}
