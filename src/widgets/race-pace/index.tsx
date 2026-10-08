import { CircuitAxis, CircuitFrame, CircuitYearRows, defineWidget, lapTime, median, useCircuitRaces, type PastRace } from "widget-kit";

const MAX_ROWS = 4;
/** The fastest lap's tick: fuchsia means fastest overall, and only that (DESIGN.md). */
const FASTEST = "#ed6bff";

/** A race's pace: each of the top 10's typical green lap, the winner's, and the fastest lap. Null without lap times. */
function paceOf(race: PastRace) {
  const typical = race.finish
    .filter((f) => f.position != null && f.position <= 10)
    .map((f) => ({ driver: f.driver, s: median(race.pace.find((p) => p.driver === f.driver)?.laps ?? []) }))
    .filter((t) => Number.isFinite(t.s));
  if (!typical.length) return null;
  const winner = typical.find((t) => t.driver === race.finish[0]?.driver)?.s ?? null;
  return { lo: Math.min(...typical.map((t) => t.s)), hi: Math.max(...typical.map((t) => t.s)), winner, fastest: race.fastest };
}

/** "1:36": a whole-second tick. */
const tick = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;

/**
 * Each earlier race's pace on one seconds axis: the spread of the top 10's typical green lap (a bar), the winner's
 * (a dot) and the fastest lap of the race (a fuchsia tick).
 */
function RacePace() {
  const data = useCircuitRaces();
  const entries = data.entries.slice(0, MAX_ROWS);
  const paces = entries.flatMap((e) => (e.race ? [paceOf(e.race)] : [])).filter((p) => p != null);
  const lo = Math.floor(Math.min(...paces.flatMap((p) => [p.lo, p.fastest?.time ?? p.lo])) - 0.5);
  const hi = Math.ceil(Math.max(...paces.map((p) => p.hi)) + 0.5);
  const span = Math.max(hi - lo, 1);
  const x = (s: number) => (s - lo) / span;
  const step = span > 8 ? 2 : 1;
  const ticks = paces.length ? Array.from({ length: Math.floor(span / step) + 1 }, (_, i) => lo + i * step).map((v) => ({ value: v, text: tick(v) })) : [];
  const best = data.races.reduce<{ race: PastRace; time: number; driver: number } | null>(
    (b, r) => (r.fastest && (!b || r.fastest.time < b.time) ? { race: r, time: r.fastest.time, driver: r.fastest.driver } : b),
    null,
  );
  const code = (r: PastRace, n: number) => r.drivers.find((d) => d.number === n)?.code ?? `#${n}`;
  return (
    <CircuitFrame
      title="Race pace"
      data={data}
      done={
        best && (
          <span className="tabular-nums text-zinc-300" title="The fastest lap of these races">
            Fastest {code(best.race, best.driver)} {lapTime(best.time)} · {best.race.year}
          </span>
        )
      }
    >
      <CircuitYearRows
        entries={entries}
        plot={(race) => {
          const p = paceOf(race);
          if (!p) return <span className="text-zinc-400">No lap times</span>;
          return (
            <div className="relative h-4">
              <div
                className="absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-zinc-500"
                style={{ left: `${x(p.lo) * 100}%`, width: `max(4px, ${(x(p.hi) - x(p.lo)) * 100}%)` }}
                title={`Top 10's typical lap: ${lapTime(p.lo)} to ${lapTime(p.hi)}`}
              />
              {p.fastest && (
                <div
                  className="absolute top-0 h-4 w-0.5 -translate-x-1/2 rounded-full"
                  style={{ left: `${x(p.fastest.time) * 100}%`, background: FASTEST }}
                  title={`Fastest lap: ${code(race, p.fastest.driver)} ${lapTime(p.fastest.time)}, lap ${p.fastest.lap}`}
                />
              )}
              {p.winner != null && (
                <div
                  className="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-zinc-50 ring-2 ring-zinc-950"
                  style={{ left: `${x(p.winner) * 100}%` }}
                  title={`Winner ${code(race, race.finish[0].driver)}'s typical lap: ${lapTime(p.winner)}`}
                />
              )}
            </div>
          );
        }}
        value={(race) => {
          const p = paceOf(race);
          return p?.winner != null ? <span title="The winner's typical green lap">{lapTime(p.winner)}</span> : "—";
        }}
        axis={paces.length ? <CircuitAxis ticks={ticks} x={x} /> : undefined}
        unit="lap time"
      />
      <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-0.5 pt-1 text-[11px] text-zinc-400">
        <span className="flex items-center gap-1">
          <span className="inline-block h-1.5 w-4 rounded-full bg-zinc-500" />
          Top 10's typical laps
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-2.5 w-2.5 rounded-full bg-zinc-50" />
          Winner's
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-3 w-0.5 rounded-full" style={{ background: FASTEST }} />
          Fastest lap
        </span>
      </div>
    </CircuitFrame>
  );
}

export default defineWidget({
  id: "race-pace",
  name: "Race pace",
  group: "circuit",
  description: "Earlier races at this circuit: the top 10's typical green-flag lap, the winner's, and the fastest lap, year by year.",
  version: "1.0.0",
  // py-2, the title (20), the rows (22 each), the axis (16) and the legend (4 + 16).
  height: 8 + 20 + 4 + MAX_ROWS * 22 + 16 + 20 + 8,
  width: { min: 24, default: 40, max: 100 },
  sessions: ["race", "practice"],
  settings: {},
  Component: RacePace,
});
