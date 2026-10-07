import { CircuitPlaceholder, COMPOUND, defineWidget, Label, stopsOf, strategies, teamColor, textOn, useCircuitRaces, useSettings, type PastRace, type PastStint } from "widget-kit";

type Show = "10" | "all";
interface Settings {
  [key: string]: string | number;
  /** The race's year; 0: the latest. */
  year: number;
  show: Show;
}

/** "M → H", the compounds in order. */
const sequence = (stints: readonly PastStint[]) => stints.map((s) => (COMPOUND[s.compound] ?? COMPOUND.UNKNOWN).letter).join(" → ");

/** The commonest compound sequence among the first `n` classified, and how many ran it. */
function commonest(race: PastRace, n = 10): { seq: string; stops: number; count: number; of: number } | null {
  const top = strategies(race)
    .filter((s) => s.finisher.position != null)
    .slice(0, n);
  const tally = new Map<string, { stops: number; count: number }>();
  for (const s of top) {
    const seq = sequence(s.stints);
    const t = tally.get(seq) ?? { stops: stopsOf(s.stints), count: 0 };
    tally.set(seq, { ...t, count: t.count + 1 });
  }
  const best = [...tally].sort((a, b) => b[1].count - a[1].count)[0];
  return best ? { seq: best[0], stops: best[1].stops, count: best[1].count, of: top.length } : null;
}

/** An earlier race at the circuit: each car's stints in finishing order, with the race's safety-car laps behind them. */
function StrategyHistory() {
  const data = useCircuitRaces();
  const [settings, update] = useSettings<Settings>();
  if (data.hidden || !data.races.length) return <CircuitPlaceholder data={data} what="Strategies" />;
  const race = data.races.find((r) => r.year === settings.year) ?? data.races[0];
  const rows = strategies(race).slice(0, settings.show === "10" ? 10 : undefined);
  const common = commonest(race);
  const pct = (lap: number) => `${(lap / Math.max(race.laps, 1)) * 100}%`;
  return (
    <div className="flex h-full flex-col text-xs">
      <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 px-3 pt-2">
        <Label>Strategies at {data.circuit}</Label>
        <span className="flex-1" />
        <div className="flex rounded-md bg-zinc-900 p-0.5" role="group" aria-label="Year">
          {data.races.map((r) => (
            <button
              key={r.sessionKey}
              type="button"
              aria-pressed={r === race}
              onClick={(e) => {
                e.currentTarget.blur();
                update({ year: r.year });
              }}
              className={`rounded px-1.5 py-px text-[11px] font-semibold tabular-nums ${r === race ? "bg-zinc-700 text-zinc-50" : "text-zinc-300 hover:text-zinc-50"}`}
            >
              {r.year}
            </button>
          ))}
        </div>
      </div>
      {common && (
        <p className="shrink-0 truncate px-3 pt-1 text-zinc-300">
          <span className="font-semibold text-zinc-50">{common.seq}</span>, {common.stops} {common.stops === 1 ? "stop" : "stops"}: {common.count} of the top {common.of}
          {race.neutral.length > 0 && <span className="text-zinc-400"> · shaded: laps behind a safety car, VSC or red flag</span>}
        </p>
      )}
      <ol className="mt-1.5 min-h-0 flex-1 overflow-y-auto px-3 pb-2">
        {rows.map(({ finisher, driver, stints }) => (
          <li key={finisher.driver} className="grid h-[22px] grid-cols-[2rem_2.75rem_minmax(0,1fr)_1.25rem] items-center gap-x-2">
            <span className={`tabular-nums ${finisher.position != null ? "text-zinc-300" : "text-zinc-400"}`}>{finisher.position ?? finisher.status.toUpperCase()}</span>
            <span
              className="rounded px-1 text-center text-[11px] font-bold leading-4"
              style={driver ? { background: teamColor(driver.color), color: textOn(driver.color) } : undefined}
              title={driver ? `${driver.name}, ${driver.team}` : undefined}
            >
              {driver?.code ?? `#${finisher.driver}`}
            </span>
            <div className="relative h-3.5 overflow-hidden rounded-sm bg-zinc-900">
              {race.neutral.map((p, i) => (
                <div key={`n${i}`} className="absolute inset-y-0 bg-amber-300/25" style={{ left: pct(p.from - 1), width: pct(p.to - p.from + 1) }} />
              ))}
              {stints.map((s, i) => {
                const c = COMPOUND[s.compound] ?? COMPOUND.UNKNOWN;
                const laps = s.to - s.from + 1;
                return (
                  <div
                    key={i}
                    className="absolute inset-y-[3px] flex items-center justify-center overflow-hidden rounded-[2px] text-[9px] font-bold leading-none text-black/75"
                    style={{ left: `calc(${pct(s.from - 1)} + ${i > 0 ? 1 : 0}px)`, width: `calc(${pct(laps)} - ${i > 0 ? 1 : 0}px)`, background: c.color }}
                    title={`${driver?.code ?? finisher.driver}: ${s.compound.toLowerCase()}, laps ${s.from}–${s.to}`}
                  >
                    {laps / Math.max(race.laps, 1) >= 0.06 ? c.letter : null}
                  </div>
                );
              })}
            </div>
            <span className="text-right tabular-nums text-zinc-400" title="Stops">
              {stopsOf(stints)}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

export default defineWidget({
  id: "strategy-history",
  name: "Strategies",
  group: "circuit",
  description: "Earlier races at this circuit: every car's tyre stints in finishing order, year by year, with the safety-car laps.",
  version: "1.0.0",
  // Fills its column and scrolls inside.
  height: { min: 220 },
  width: { min: 28, default: 50, max: 100 },
  sessions: ["race", "practice"],
  settings: { year: 0, show: "10" as Show } satisfies Settings,
  fields: {
    show: {
      kind: "choice",
      label: "Cars",
      options: [
        { value: "10", label: "Top 10" },
        { value: "all", label: "All" },
      ],
    },
  },
  Component: StrategyHistory,
});
