import type { ReactNode } from "react";
import { defineBlock, lapTime, useDriver, useFastestLap, useSelectedDriver, useSessionInfo, useTotalLaps, type DriverSetting, type Lap } from "block-kit";

const LABEL = "text-[10px] font-semibold uppercase tracking-wider text-zinc-500";
/** A line of 10 px text in a text-sm block (line height 20/14). */
const LINE_10 = (10 * 20) / 14;

function Stat({ label, value, className = "text-zinc-200" }: { label: string; value: ReactNode; className?: string }) {
  return (
    <div className="min-w-0">
      <div className={LABEL}>{label}</div>
      <div className={`truncate text-base font-semibold tabular-nums ${className}`}>{value}</div>
    </div>
  );
}

function LapTimes() {
  const s = useDriver(useSelectedDriver(), (d) => ({ lap: d.lap, lastLap: d.lastLap, bestLap: d.bestLap }));
  const fl = useFastestLap();
  const totalLaps = useTotalLaps();
  const totalLapsEstimated = useSessionInfo((i) => i.totalLapsEstimated);
  if (!s) return null;
  const last = s.lastLap;
  const best = s.bestLap;
  const isFastest = (l: Lap | null) => l != null && fl != null && fl.driver === l.driver && fl.lap === l.lap;
  const lastColor = !last ? "text-zinc-600" : isFastest(last) ? "text-fuchsia-400" : best === last ? "text-emerald-400" : "text-zinc-200";
  const bestColor = !best ? "text-zinc-600" : isFastest(best) ? "text-fuchsia-400" : "text-zinc-200";

  return (
    <div className="h-full px-3 pt-2 text-sm">
      <div className="grid grid-cols-[64px_minmax(0,1fr)_minmax(0,1fr)] gap-2">
        <Stat
          label="Lap"
          value={
            <>
              {s.lap > 0 ? s.lap : "–"}
              <span className="text-xs font-normal text-zinc-500" title={totalLapsEstimated ? "Estimated race distance" : undefined}>
                /{totalLapsEstimated ? "~" : ""}
                {totalLaps}
              </span>
            </>
          }
        />
        <Stat label={last ? `Last · L${last.lap}` : "Last"} value={lapTime(last?.duration)} className={lastColor} />
        <Stat label={best ? `Best · L${best.lap}` : "Best"} value={lapTime(best?.duration)} className={bestColor} />
      </div>
    </div>
  );
}

export default defineBlock({
  id: "lap-times",
  name: "Lap times",
  description: "The lap the driver is on, and their last and best lap times.",
  version: "1.0.0",
  // pt-2, a label line and a 24 px time (the sectors block under it has the bottom padding).
  height: 8 + LINE_10 + 24,
  width: { min: 12, default: 21, max: 40 },
  sessions: ["race"],
  settings: { driver: "follow-selection" as DriverSetting },
  Component: LapTimes,
});
