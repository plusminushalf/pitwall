import { COMPOUND, defineBlock, TyreBadge, useDriver, useLaps, useSelectedDriver, useSessionInfo, useStints, useTime, useTotalLaps, type DriverSetting } from "block-kit";

const LABEL = "text-[10px] font-semibold uppercase tracking-wider text-zinc-500";

/**
 * Laps completed by t, plus an estimate of the lap in progress: time since the last lap ended over that
 * lap's time (the lap's own end hasn't happened yet). Nothing is estimated on lap 1.
 */
function useLapProgress(n: number | null, running: boolean): number {
  const last = useLaps(n, (laps) => {
    const l = laps.at(-1);
    return l ? { lap: l.lap, end: l.end, duration: l.duration } : null;
  });
  // In steps of 1/200 lap (well under a pixel): the strip re-renders when the marker moves, not every tick.
  const frac = useTime((t) => {
    const lapMs = last?.duration != null ? last.duration * 1000 : null;
    if (!running || last?.end == null || !lapMs) return 0;
    return Math.round(Math.min(Math.max((t - last.end) / lapMs, 0), 0.99) * 200) / 200;
  });
  return last ? last.lap + frac : 0;
}

/** The driver's stints so far along the race distance, with a marker at where they are now. */
function TyreStrip() {
  const n = useSelectedDriver();
  const s = useDriver(n, (d) => ({ status: d.status, compound: d.compound, tyreAge: d.tyreAge, pitStops: d.pitStops }));
  const stints = useStints(n);
  const totalLaps = useTotalLaps();
  const totalLapsEstimated = useSessionInfo((i) => i.totalLapsEstimated);
  const running = s?.status === "RUNNING" || s?.status === "PIT";
  const total = Math.max(totalLaps, 1);
  const progress = Math.min(useLapProgress(n, running), total);
  if (!s) return null;
  const pct = (laps: number) => `${(Math.max(laps, 0) / total) * 100}%`;

  return (
    <div className="h-full px-3 py-2 text-sm">
      <div className="mb-1.5 flex items-center justify-between">
        <span className={LABEL}>
          Tyres <span className="font-normal normal-case tracking-normal text-zinc-600">· {totalLapsEstimated ? "~" : ""}{total} laps</span>
        </span>
        <span className="flex items-center gap-2 text-[11px] text-zinc-400">
          <span className="tabular-nums">
            {s.pitStops} {s.pitStops === 1 ? "stop" : "stops"}
          </span>
          <TyreBadge compound={s.compound} age={s.tyreAge} size={16} />
        </span>
      </div>
      <div className="relative h-3.5">
        <div className="absolute inset-0 overflow-hidden rounded-sm bg-zinc-900">
          {stints.map((st, i) => {
            const from = st.lapStart - 1;
            const lastLap = st.open ? null : Math.min(st.lapEnd, stints[i + 1].lapStart - 1);
            const width = Math.max((lastLap ?? progress) - from, 0);
            const c = COMPOUND[st.compound] ?? COMPOUND.UNKNOWN;
            return (
              <div
                key={st.stint}
                className="absolute inset-y-0 flex items-center justify-center overflow-hidden text-[9px] font-bold leading-none text-black/75"
                style={{ left: pct(from), width: st.open ? pct(width) : `calc(${pct(width)} - 2px)`, background: c.color }}
                title={`${st.compound.toLowerCase()}, ${lastLap != null ? `laps ${st.lapStart}–${lastLap}` : `from lap ${st.lapStart}`}`}
              >
                {width / total >= 0.05 ? c.letter : null}
              </div>
            );
          })}
        </div>
        <div className="absolute -inset-y-0.5 w-0.5 -translate-x-1/2 rounded-full bg-white" style={{ left: pct(progress) }} />
      </div>
    </div>
  );
}

export default defineBlock({
  id: "tyre-strip",
  name: "Tyres",
  version: "1.0.0",
  // py-2, the title line (16 px, the tyre badge) and the 14 px strip 6 px below it.
  height: 8 + 16 + 6 + 14 + 8,
  width: { min: 12, default: 21, max: 60 },
  sessions: ["race"],
  settings: { driver: "follow-selection" as DriverSetting },
  Component: TyreStrip,
});
