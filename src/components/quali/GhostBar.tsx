import { useRef } from "react";
import { deltaAt, distanceAtTime } from "../../engine/compare";
import type { CompareEntry } from "../../hooks/useCompare";
import { GHOST_SPEEDS, useQuali } from "../../qualiStore";
import { useReplay } from "../../store";
import { Swatch } from "./CompareCharts";
import { formatGap } from "./CompareMap";

const clockText = (ms: number) => {
  const s = Math.max(0, ms) / 1000;
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, "0")}`;
};

/** Ghost replay controls: the compared laps start together at the line; play, scrub, speed. */
export function GhostBar({ entries, maxDuration }: { entries: CompareEntry[]; maxDuration: number }) {
  const t = useQuali((s) => s.ghostT);
  const speed = useQuali((s) => s.ghostSpeed);
  const { seekGhost, setGhostSpeed } = useQuali.getState();
  const playing = useReplay((s) => s.playing);
  const barRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const withTrace = entries.filter((e) => e.trace);
  const ref = withTrace[0]?.trace ?? null;
  const span = Math.max(1, maxDuration);
  const pct = (ms: number) => `${(Math.min(Math.max(ms, 0), span) / span) * 100}%`;
  const timeAt = (clientX: number) => {
    const r = barRef.current!.getBoundingClientRect();
    return (Math.min(Math.max((clientX - r.left) / r.width, 0), 1) * span);
  };
  const refLap = withTrace[0]?.lap;
  const sectorTicks = refLap?.sectors[0] != null ? [refLap.sectors[0], refLap.sectors[1] != null ? refLap.sectors[0] + refLap.sectors[1] : null] : [];

  return (
    <div className="flex items-center gap-4 border-t border-zinc-800 bg-zinc-950 px-4 py-2.5">
      <div className="flex items-center gap-1">
        <button onClick={() => seekGhost(0)} className="rounded px-2 py-1 text-zinc-400 hover:bg-zinc-800 hover:text-white" title="Back to the line (Home)">
          ⏮
        </button>
        <button
          onClick={() => useReplay.getState().togglePlay()}
          disabled={!withTrace.length}
          className={`flex h-9 w-9 items-center justify-center rounded-full text-lg transition disabled:opacity-40 ${playing ? "bg-emerald-400 text-zinc-950 ring-4 ring-emerald-400/25" : "bg-zinc-100 text-zinc-900 hover:bg-white"}`}
          title="Play / pause the ghost laps (P, or hold space)"
          aria-label={playing ? "Pause" : "Play"}
        >
          {playing ? "⏸" : "▶"}
        </button>
      </div>
      <div className="flex overflow-hidden rounded border border-zinc-800 text-xs">
        {GHOST_SPEEDS.map((s) => (
          <button key={s} onClick={() => setGhostSpeed(s)} className={`px-2 py-1 tabular-nums ${s === speed ? "bg-zinc-100 font-bold text-zinc-900" : "text-zinc-400 hover:bg-zinc-800"}`}>
            {s < 1 ? `${s}` : s}×
          </button>
        ))}
      </div>

      <div
        ref={barRef}
        className="relative h-9 flex-1 cursor-pointer select-none"
        onPointerDown={(e) => {
          dragging.current = true;
          e.currentTarget.setPointerCapture(e.pointerId);
          seekGhost(timeAt(e.clientX));
        }}
        onPointerMove={(e) => dragging.current && seekGhost(timeAt(e.clientX))}
        onPointerUp={() => (dragging.current = false)}
        onPointerCancel={() => (dragging.current = false)}
        role="slider"
        aria-label="Ghost lap time"
        aria-valuemin={0}
        aria-valuemax={Math.round(span)}
        aria-valuenow={Math.round(t)}
      >
        <div className="absolute inset-x-0 top-4 h-1.5 overflow-hidden rounded bg-zinc-800">
          <div className="absolute inset-y-0 left-0 bg-zinc-500" style={{ width: pct(t) }} />
        </div>
        {sectorTicks.map((s, i) =>
          s == null ? null : (
            <div key={i} className="absolute top-3 h-3.5 w-px bg-zinc-500" style={{ left: pct(s * 1000) }}>
              <span className="absolute left-1 top-3 text-[9px] text-zinc-500">S{i + 2}</span>
            </div>
          ),
        )}
        {withTrace.map((e) => (
          <div key={e.driver} className="absolute top-2 h-5 w-0.5 -translate-x-1/2 rounded" style={{ left: pct(e.trace!.duration), background: e.style.color }} title={`${e.info.acronym} finishes the lap`} />
        ))}
        <div className="pointer-events-none absolute top-2.5 h-4 w-1 -translate-x-1/2 rounded bg-white shadow" style={{ left: pct(t) }} />
      </div>

      <div className="w-16 text-right text-sm tabular-nums text-zinc-200">{clockText(t)}</div>
      <div className="flex min-w-40 items-center gap-2 text-[11px] tabular-nums">
        {withTrace.slice(1).map((e) => {
          const lap = e.trace!;
          const gap = !ref || t <= 0 ? null : t >= lap.duration ? (lap.duration - ref.duration) / 1000 : deltaAt(ref, lap, distanceAtTime(lap, t));
          return (
            <span key={e.driver} className="flex items-center gap-1" title={`${e.info.acronym}'s gap to ${withTrace[0].info.acronym} at this point of the lap`}>
              <Swatch color={e.style.color} dashed={e.style.dash.length > 0} width={10} />
              <span className="font-bold text-zinc-200">{e.info.acronym}</span>
              <span className={gap == null ? "text-zinc-600" : gap > 0 ? "text-red-300" : "text-emerald-300"}>{gap == null ? "—" : formatGap(gap)}</span>
            </span>
          );
        })}
      </div>
    </div>
  );
}
