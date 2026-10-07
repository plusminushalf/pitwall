import { CircuitAxis, CircuitFrame, CircuitYearRows, defineWidget, median, useCircuitRaces, type PastPit, type PastRace } from "widget-kit";

const MAX_ROWS = 4;
/** A stop under green, and under a safety car, VSC or red flag: amber, the replay's colour for a safety car. */
const GREEN = "#9f9fa9";
const NEUTRAL = "#fbbf24";

const timed = (race: PastRace) => race.pits.filter((p): p is PastPit & { lane: number } => p.lane != null);
const greenMedian = (race: PastRace) => median(timed(race).filter((p) => !p.neutral).map((p) => p.lane));

/**
 * Each earlier race's pit stops as dots on one axis of time in the pit lane (what a stop costs there, before the
 * stationary time is told apart), the median under green marked, the ones under a safety car in amber.
 */
function PitHistory() {
  const data = useCircuitRaces();
  const entries = data.entries.slice(0, MAX_ROWS);
  const shown = entries.flatMap((e) => (e.race ? timed(e.race) : []));
  // Far-off stops (a long repair) would squash the rest: the axis ends at 1.6× the median, and they sit at its end.
  const mid = median(shown.map((p) => p.lane));
  const lo = Math.floor(Math.min(...shown.map((p) => p.lane)) - 0.5);
  const hi = Math.ceil(Math.min(Math.max(...shown.map((p) => p.lane)), mid * 1.6) + 0.5);
  const span = Math.max(hi - lo, 1);
  const x = (s: number) => Math.min(1, Math.max(0, (s - lo) / span));
  const step = span > 16 ? 4 : span > 8 ? 2 : 1;
  const ticks = shown.length ? Array.from({ length: Math.floor(span / step) + 1 }, (_, i) => lo + i * step).map((v) => ({ value: v, text: `${v}` })) : [];
  const quickest = data.races
    .flatMap((r) => r.pits.filter((p) => p.stationary != null).map((p) => ({ race: r, p })))
    .sort((a, b) => a.p.stationary! - b.p.stationary!)[0];
  const code = (r: PastRace, n: number) => r.drivers.find((d) => d.number === n)?.code ?? `#${n}`;
  return (
    <CircuitFrame
      title="Pit lane"
      what="Pit stops"
      data={data}
      done={
        quickest && (
          <span className="tabular-nums text-zinc-300" title="The shortest time stationary of these races (timed from 2024)">
            Quickest stop {quickest.p.stationary!.toFixed(1)} s · {code(quickest.race, quickest.p.driver)} {quickest.race.year}
          </span>
        )
      }
    >
      <CircuitYearRows
        entries={entries}
        plot={(race) => {
          const stops = timed(race);
          if (!stops.length) return <span className="text-zinc-400">No pit times</span>;
          const m = greenMedian(race);
          return (
            <div className="relative h-4">
              <div className="absolute inset-x-0 top-1/2 h-px bg-zinc-800" />
              {Number.isFinite(m) && <div className="absolute top-0 h-4 w-0.5 -translate-x-1/2 rounded-full bg-zinc-50" style={{ left: `${x(m) * 100}%` }} title={`Median under green: ${m.toFixed(1)} s`} />}
              {stops.map((p, i) => (
                <div
                  key={i}
                  className="absolute top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-zinc-950"
                  style={{ left: `${x(p.lane) * 100}%`, background: p.neutral ? NEUTRAL : GREEN }}
                  title={`${code(race, p.driver)}, lap ${p.lap}: ${p.lane.toFixed(1)} s in the pit lane${p.stationary != null ? `, ${p.stationary.toFixed(1)} s stationary` : ""}${p.neutral ? ", under a safety car" : ""}`}
                />
              ))}
            </div>
          );
        }}
        value={(race) => {
          const m = greenMedian(race);
          return Number.isFinite(m) ? <span title="Median time in the pit lane under green">{m.toFixed(1)} s</span> : "—";
        }}
        axis={shown.length ? <CircuitAxis ticks={ticks} x={x} /> : undefined}
        unit="s in lane"
      />
      <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-0.5 pt-1 text-[11px] text-zinc-400">
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-full" style={{ background: GREEN }} />
          Under green
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-full" style={{ background: NEUTRAL }} />
          Under a safety car or VSC
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-3 w-0.5 rounded-full bg-zinc-50" />
          Median under green
        </span>
      </div>
    </CircuitFrame>
  );
}

export default defineWidget({
  id: "pit-history",
  name: "Pit lane",
  group: "circuit",
  description: "Earlier races at this circuit: every stop's time in the pit lane, under green or a safety car, year by year.",
  version: "1.0.0",
  // py-2, the title (20), the rows (22 each), the axis (16) and the legend (4 + 16).
  height: 8 + 20 + 4 + MAX_ROWS * 22 + 16 + 20 + 8,
  width: { min: 24, default: 40, max: 100 },
  sessions: ["race", "practice"],
  settings: {},
  Component: PitHistory,
});
