// What the circuit widgets show besides their races (DESIGN.md, Circuit widgets): placeholders shaped like what's
// loading, and why something didn't load, with Try again. The
// widget's own header stays above them throughout, so nothing jumps when the races come in.

import type { CSSProperties, ReactNode } from "react";
import type { CircuitRaceEntry, CircuitRaces } from "../circuit";
import type { PastRace } from "../../history/pastRaces";

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
 * The widget's body when it isn't showing races: the calendar that says which races there are didn't load, or there
 * are none. Null when the widget lays out its races (loaded or
 * loading); `loading` is what it shows while the calendar itself loads.
 */
export function circuitNotice(data: CircuitRaces, loading: ReactNode): ReactNode | null {
  const at = data.circuit ? ` at ${data.circuit}` : "";
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
  if (data.total === 0) return null;
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

/** Placeholder rows shaped like CircuitYearRows', while the calendar loads. */
const skeletonRows = (
  <div className="mt-1 flex flex-col gap-2.5 pt-1">
    {[0, 1, 2].map((i) => (
      <div key={i} className="grid grid-cols-[2.5rem_minmax(0,1fr)_4.5rem] items-center gap-x-2">
        <Skeleton className="h-3 w-8" />
        <Skeleton className="h-3" />
        <Skeleton className="ml-auto h-3 w-12" />
      </div>
    ))}
  </div>
);

/**
 * A circuit widget's frame: its title (with the circuit's name) and how the races are loading over the body, or in
 * place of the body what circuitNotice() says. `done` is the header's right once every race is in.
 */
export function CircuitFrame({ title, data, done, children }: { title: string; data: CircuitRaces; done: ReactNode; children: ReactNode }) {
  const notice = circuitNotice(data, skeletonRows);
  return (
    <div className="flex h-full flex-col px-3 py-2 text-xs">
      <div className="flex h-5 shrink-0 items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
          {title}
          {data.circuit ? ` at ${data.circuit}` : ""}
        </span>
        <span className="flex-1" />
        <CircuitProgress data={data} done={done} />
      </div>
      {notice ?? children}
    </div>
  );
}

/**
 * One row per earlier race, newest first: its year, `plot` (the race drawn across the row) and `value` (a figure at
 * the end), a placeholder while it loads and why it didn't load if it didn't. `axis` goes under the plots, with
 * `unit` ("lap", "s") at its end. The figures are never cut short ("1 SC · 1 VSC"): their column takes the widest.
 */
export function CircuitYearRows({
  entries,
  plot,
  value,
  axis,
  unit,
}: {
  entries: readonly CircuitRaceEntry[];
  plot: (race: PastRace) => ReactNode;
  value: (race: PastRace) => ReactNode;
  axis?: ReactNode;
  unit?: string;
}) {
  return (
    <div className="mt-1 grid grid-cols-[2.5rem_minmax(0,1fr)_minmax(4.5rem,max-content)] items-center gap-x-2">
      {entries.map((e) => (
        <div key={e.sessionKey} className="contents">
          <span className="tabular-nums leading-[22px] text-zinc-300" title={e.meetingName}>
            {e.year}
          </span>
          {e.race ? (
            plot(e.race)
          ) : e.loading ? (
            <Skeleton className="h-3" />
          ) : (
            <span className="truncate text-red-400" title={e.error ?? undefined}>
              {e.error}
            </span>
          )}
          <span className="whitespace-nowrap text-right tabular-nums text-zinc-100">{e.race ? value(e.race) : e.loading ? <Skeleton className="ml-auto h-3 w-12" /> : "—"}</span>
        </div>
      ))}
      {axis && (
        <>
          <span />
          {axis}
          <span className="text-right text-[10px] text-zinc-400">{unit}</span>
        </>
      )}
    </div>
  );
}

/** Tick labels under a row's plot: `ticks` placed by `x` (0–1). */
export function CircuitAxis({ ticks, x }: { ticks: readonly { value: number; text: string }[]; x: (v: number) => number }) {
  return (
    <div className="relative h-4 text-[10px] tabular-nums text-zinc-400" aria-hidden>
      {ticks.map((t) => (
        <span key={t.value} className="absolute -translate-x-1/2 whitespace-nowrap" style={{ left: `${x(t.value) * 100}%` }}>
          {t.text}
        </span>
      ))}
    </div>
  );
}
