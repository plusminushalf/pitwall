import type { ReactNode } from "react";
import { defineBlock, lapTime, Stat, useDriver, useFastestLap, useSelectedDriver, useSessionInfo, useTotalLaps, type DriverSetting, type Lap } from "block-kit";

/** A line of the 11 px label in a text-sm block (line height 20/14). */
const LINE_11 = (11 * 20) / 14;

function Time({ label, value, className = "text-zinc-200" }: { label: string; value: ReactNode; className?: string }) {
  return (
    <Stat label={label}>
      <span className={`truncate text-base font-semibold tabular-nums ${className}`}>{value}</span>
    </Stat>
  );
}

function LapTimes() {
  const s = useDriver(useSelectedDriver(), (d) => ({ lap: d.lap, lastLap: d.lastLap, bestLap: d.bestLap }));
  const fl = useFastestLap();
  const totalLaps = useTotalLaps();
  const totalLapsEstimated = useSessionInfo((i) => i.totalLapsEstimated);
  // Practice has no race distance.
  const practice = useSessionInfo((i) => i.kind === "practice");
  if (!s) return null;
  const last = s.lastLap;
  const best = s.bestLap;
  const isFastest = (l: Lap | null) => l != null && fl != null && fl.driver === l.driver && fl.lap === l.lap;
  const lastColor = !last ? "text-zinc-600" : isFastest(last) ? "text-fuchsia-400" : best === last ? "text-emerald-400" : "text-zinc-200";
  const bestColor = !best ? "text-zinc-600" : isFastest(best) ? "text-fuchsia-400" : "text-zinc-200";

  return (
    <div className="h-full px-3 pt-2 text-sm">
      <div className="grid grid-cols-[64px_minmax(0,1fr)_minmax(0,1fr)] gap-2">
        <Time
          label="Lap"
          value={
            <>
              {s.lap > 0 ? s.lap : "–"}
              {!practice && (
                <span className="text-xs font-normal text-zinc-400" title={totalLapsEstimated ? "Estimated race distance" : undefined}>
                  /{totalLapsEstimated ? "~" : ""}
                  {totalLaps}
                </span>
              )}
            </>
          }
        />
        <Time label={last ? `Last · L${last.lap}` : "Last"} value={lapTime(last?.duration)} className={lastColor} />
        <Time label={best ? `Best · L${best.lap}` : "Best"} value={lapTime(best?.duration)} className={bestColor} />
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
  height: 8 + LINE_11 + 24,
  width: { min: 12, default: 21, max: 40 },
  sessions: ["race", "practice"],
  settings: { driver: "follow-selection" as DriverSetting },
  Component: LapTimes,
});
