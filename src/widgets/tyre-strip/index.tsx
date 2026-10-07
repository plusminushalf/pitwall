import { COMPOUND, defineWidget, Label, TyreBadge, useDriver, useLapWindow, useLaps, useSelectedDriver, useSessionInfo, useStints, useTime, useTotalLaps, type DriverSetting } from "widget-kit";

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

/** The driver's stints so far along the race distance (practice: their laps so far), with a marker at where they are now. */
function TyreStrip() {
  const n = useSelectedDriver();
  const s = useDriver(n, (d) => ({ status: d.status, compound: d.compound, tyreAge: d.tyreAge, pitStops: d.pitStops }));
  const stints = useStints(n);
  const totalLaps = useTotalLaps();
  const totalLapsEstimated = useSessionInfo((i) => i.totalLapsEstimated);
  const practice = useSessionInfo((i) => i.kind === "practice");
  const running = s?.status === "RUNNING" || s?.status === "PIT";
  const lapProgress = useLapProgress(n, running);
  // Practice has no race distance: the strip is the driver's own laps so far.
  const total = practice ? Math.max(Math.ceil(lapProgress), 1) : Math.max(totalLaps, 1);
  const progress = Math.min(lapProgress, total);
  // Zoomed on the timeline: the strip spans the window's laps.
  const win = useLapWindow(total);
  const from = win.from - 1;
  const span = win.to - from;
  if (!s) return null;
  const pct = (laps: number) => `${((laps - from) / span) * 100}%`;

  return (
    <div className="h-full px-3 py-2 text-sm">
      <div className="mb-1.5 flex items-center justify-between">
        <Label>
          Tyres{" "}
          <span className="font-normal normal-case tracking-normal">
            ·{" "}
            {practice
              ? `${stints.length} ${stints.length === 1 ? "set" : "sets"}`
              : win.zoomed
                ? `laps ${win.from}–${win.to}`
                : `${totalLapsEstimated ? "~" : ""}${total} laps`}
          </span>
        </Label>
        <span className="flex items-center gap-2 text-[11px] text-zinc-400">
          {!practice && (
            <span className="tabular-nums">
              {s.pitStops} {s.pitStops === 1 ? "stop" : "stops"}
            </span>
          )}
          <TyreBadge compound={s.compound} age={s.tyreAge} size={16} />
        </span>
      </div>
      <div className="relative h-3.5">
        <div className="absolute inset-0 overflow-hidden rounded-sm bg-zinc-900">
          {stints.map((st, i) => {
            const start = st.lapStart - 1;
            const lastLap = st.open ? null : Math.min(st.lapEnd, stints[i + 1].lapStart - 1);
            const end = Math.max(lastLap ?? progress, start);
            // Cut to the window, so its letter sits in what's shown.
            const left = Math.max(start, from);
            const width = Math.min(end, win.to) - left;
            if (width <= 0) return null;
            const gap = !st.open && end <= win.to;
            const c = COMPOUND[st.compound] ?? COMPOUND.UNKNOWN;
            return (
              <div
                key={st.stint}
                className="absolute inset-y-0 flex items-center justify-center overflow-hidden text-[9px] font-bold leading-none text-black/75"
                style={{ left: pct(left), width: `calc(${(width / span) * 100}%${gap ? " - 2px" : ""})`, background: c.color }}
                title={`${st.compound.toLowerCase()}, ${lastLap != null ? `laps ${st.lapStart}–${lastLap}` : `from lap ${st.lapStart}`}`}
              >
                {width / span >= 0.05 ? c.letter : null}
              </div>
            );
          })}
        </div>
        {progress >= from && progress <= win.to && <div className="absolute -inset-y-0.5 w-0.5 -translate-x-1/2 rounded-full bg-white" style={{ left: pct(progress) }} />}
      </div>
    </div>
  );
}

export default defineWidget({
  id: "tyre-strip",
  name: "Tyres",
  group: "driver",
  description: "The driver's tyre stints so far along the race distance, with their pit stops and current tyre.",
  version: "1.0.0",
  // py-2, the title line (16 px, the tyre badge) and the 14 px strip 6 px below it.
  height: 8 + 16 + 6 + 14 + 8,
  width: { min: 12, default: 21, max: 60 },
  sessions: ["race", "practice"],
  settings: { driver: "follow-selection" as DriverSetting },
  Component: TyreStrip,
});
