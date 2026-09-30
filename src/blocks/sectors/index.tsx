import { defineBlock, lapTime, useBestSectors, useDriver, useLaps, useSelectedDriver, type DriverSetting, type Lap } from "block-kit";

const LABEL = "text-[10px] font-semibold uppercase tracking-wider text-zinc-500";
const EPS = 1e-6;
/** A sector's time (a 10 px label and a 12 px time on one baseline: 16.28 px, measured) and its mini-sector bar. */
const CELL_H = 16.28 + 4 + 4;

// Mini-sector status codes: 2048 yellow, 2049 green, 2051 purple, 2064 pit lane.
const SEGMENT_COLOR: Record<number, string> = {
  2048: "#eab308",
  2049: "#10b981",
  2051: "#d946ef",
  2064: "#3b82f6",
};

/** The driver's fastest time in each sector over laps finished by the end of `upTo`. */
function personalBestSectors(laps: readonly Lap[], upTo: Lap | null): number[] {
  const best = [Infinity, Infinity, Infinity];
  if (!upTo || upTo.end == null) return best;
  for (const l of laps) {
    if (l.end == null || l.end > upTo.end) continue;
    for (let k = 0; k < 3; k++) {
      const v = l.sectors[k];
      if (v != null && v < best[k]) best[k] = v;
    }
  }
  return best;
}

function SectorCell({ index, lap, personal, overall }: { index: number; lap: Lap | null; personal: number; overall: number }) {
  const v = lap?.sectors[index] ?? null;
  const color =
    v == null ? "text-zinc-600" : v <= overall + EPS ? "text-fuchsia-400" : v <= personal + EPS ? "text-emerald-400" : "text-yellow-400";
  const segments = lap?.segments[index] ?? [];
  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-1">
        <span className={LABEL}>S{index + 1}</span>
        <span className={`text-xs font-semibold tabular-nums ${color}`}>{lapTime(v)}</span>
      </div>
      <div className="mt-1 flex h-1 gap-px">
        {segments.length > 0 ? (
          segments.map((c, i) => <span key={i} className="flex-1 rounded-[1px]" style={{ background: (c != null && SEGMENT_COLOR[c]) || "#3f3f46" }} />)
        ) : (
          <span className="flex-1 rounded-[1px] bg-zinc-800" />
        )}
      </div>
    </div>
  );
}

/** The last lap's sectors and mini-sectors: purple for the best by anyone so far, green for a personal best. */
function Sectors() {
  const n = useSelectedDriver();
  const last = useDriver(n, (d) => d.lastLap) ?? null;
  // Just the three personal bests, not the laps: a new lap re-renders only if it changes them.
  const personal = useLaps(n, (laps) => personalBestSectors(laps, last));
  const overall = useBestSectors();
  return (
    <div className="grid h-full grid-cols-3 content-start gap-3 px-3 py-2 text-sm">
      {[0, 1, 2].map((k) => (
        <SectorCell key={k} index={k} lap={last} personal={personal[k]} overall={overall[k] ?? Infinity} />
      ))}
    </div>
  );
}

export default defineBlock({
  id: "sectors",
  name: "Sectors",
  description: "The driver's last lap by sector and mini-sector: purple for the fastest, green for a personal best.",
  version: "1.0.0",
  height: 8 + CELL_H + 8,
  width: { min: 12, default: 21, max: 40 },
  sessions: ["race"],
  settings: { driver: "follow-selection" as DriverSetting },
  Component: Sectors,
});
