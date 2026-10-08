import { CircuitAxis, CircuitFrame, CircuitYearRows, defineWidget, useCircuitRaces, type PastRace } from "widget-kit";

const MAX_ROWS = 4;
/** Laps per cell of the strip. */
const BIN = 5;
/**
 * Passes per cell, one hue light to dark on the near-black (sequential: more is lighter). Four steps, far enough apart
 * to tell once a screenshot is shrunk and recompressed in a feed. Zero is an empty outlined cell, so a stretch without
 * passes still shows as part of the race.
 */
const STEPS = ["#3f3f46", "#71717b", "#b4b4bb", "#fafafa"];
const EMPTY = { boxShadow: "inset 0 0 0 1px #3f3f46" };
const cell = (n: number, max: number) => (n <= 0 ? EMPTY : { background: STEPS[Math.min(STEPS.length - 1, Math.floor((n / max) * (STEPS.length - 1) + 1e-9))] });

const binsOf = (race: PastRace, bins: number) => {
  const out = new Array<number>(bins).fill(0);
  for (const p of race.passes) out[Math.min(bins - 1, Math.floor((p.lap - 1) / BIN))]++;
  return out;
};

/** Each earlier race's passes on track, and where in the race they came: a strip of five-lap cells, lighter for more. */
function Overtakes() {
  const data = useCircuitRaces();
  const entries = data.entries.slice(0, MAX_ROWS);
  const maxLaps = Math.max(...entries.map((e) => e.race?.laps ?? 0), 0) || 60;
  const bins = Math.ceil(maxLaps / BIN);
  const max = Math.max(1, ...entries.flatMap((e) => (e.race ? binsOf(e.race, bins) : [])));
  const average = data.races.length ? Math.round(data.races.reduce((n, r) => n + r.passes.length, 0) / data.races.length) : 0;
  const ticks = Array.from({ length: Math.floor(maxLaps / 10) }, (_, i) => ({ value: (i + 1) * 10, text: String((i + 1) * 10) }));
  return (
    <CircuitFrame
      title="Overtakes"
      data={data}
      done={
        <span className="tabular-nums text-zinc-300" title="Passes on track: not at the start, behind a safety car, or from pit stops">
          {average} a race
        </span>
      }
    >
      <CircuitYearRows
        entries={entries}
        plot={(race) => {
          const counts = binsOf(race, bins);
          return (
            <div className="flex h-4 gap-[3px]">
              {counts.map((n, i) => {
                const from = i * BIN + 1;
                const to = Math.min((i + 1) * BIN, race.laps);
                // Past the race's own distance (a shorter race than the longest shown): nothing to draw.
                if (from > race.laps) return <span key={i} className="flex-1" />;
                return (
                  <span
                    key={i}
                    className="flex-1 rounded-[2px]"
                    style={cell(n, max)}
                    title={`Laps ${from}–${to}: ${n} ${n === 1 ? "pass" : "passes"}`}
                  />
                );
              })}
            </div>
          );
        }}
        value={(race) => race.passes.length}
        axis={<CircuitAxis ticks={ticks} x={(v) => v / (bins * BIN)} />}
        unit="lap"
      />
      <div className="mt-auto flex items-center gap-1.5 pt-1 text-[11px] text-zinc-400">
        Passes per {BIN} laps: none
        <span className="inline-block h-2.5 w-3 rounded-[2px]" style={EMPTY} />
        {STEPS.map((c) => (
          <span key={c} className="inline-block h-2.5 w-3 rounded-[2px]" style={{ background: c }} />
        ))}
        more
      </div>
    </CircuitFrame>
  );
}

export default defineWidget({
  id: "overtakes-history",
  name: "Overtakes",
  group: "circuit",
  description: "Earlier races at this circuit: how many passes were made on track, and in which part of the race.",
  version: "1.0.0",
  // py-2, the title (20), the rows (22 each), the lap axis (16) and the legend (4 + 16).
  height: 8 + 20 + 4 + MAX_ROWS * 22 + 16 + 20 + 8,
  width: { min: 24, default: 40, max: 100 },
  sessions: ["race", "practice"],
  settings: {},
  Component: Overtakes,
});
