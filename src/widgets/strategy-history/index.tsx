import {
  circuitNotice,
  COMPOUND,
  defineWidget,
  Label,
  RetryButton,
  Skeleton,
  stopsOf,
  strategies,
  teamColor,
  textOn,
  useCircuitRaces,
  useSettings,
  type PastRace,
  type PastStint,
} from "widget-kit";

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

const ROW = "grid h-[22px] grid-cols-[2rem_2.75rem_minmax(0,1fr)_1.25rem] items-center gap-x-2";

/** Ten rows shaped like the real ones, while a race loads. */
const skeleton = (
  <ol aria-hidden className="mt-1.5 px-3">
    {Array.from({ length: 10 }, (_, i) => (
      <li key={i} className={ROW}>
        <Skeleton className="h-3 w-4" />
        <Skeleton className="h-4" />
        {/* Varied, so it reads as bars of stints, not a wall. */}
        <Skeleton className="h-3.5" style={{ width: `${100 - ((i * 7) % 4) * 6}%` }} />
        <Skeleton className="ml-auto h-3 w-2" />
      </li>
    ))}
  </ol>
);

/** One race's strategies: each car's stints in finishing order, the race's neutral laps shaded behind them. */
function Race({ race, show }: { race: PastRace; show: Show }) {
  const rows = strategies(race).slice(0, show === "10" ? 10 : undefined);
  const common = commonest(race);
  const pct = (lap: number) => `${(lap / Math.max(race.laps, 1)) * 100}%`;
  return (
    <>
      {common && (
        <p className="shrink-0 truncate px-3 pt-1 text-zinc-300">
          <span className="font-semibold text-zinc-50">{common.seq}</span>, {common.stops} {common.stops === 1 ? "stop" : "stops"}: {common.count} of the top {common.of}
          {race.neutral.length > 0 && <span className="text-zinc-400"> · shaded: laps behind a safety car, VSC or red flag</span>}
        </p>
      )}
      <ol className="mt-1.5 min-h-0 flex-1 overflow-y-auto px-3 pb-2">
        {rows.map(({ finisher, driver, stints }) => (
          <li key={finisher.driver} className={ROW}>
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
              {stints.map((st, i) => {
                const c = COMPOUND[st.compound] ?? COMPOUND.UNKNOWN;
                const laps = st.to - st.from + 1;
                return (
                  <div
                    key={i}
                    className="absolute inset-y-[3px] flex items-center justify-center overflow-hidden rounded-[2px] text-[9px] font-bold leading-none text-black/75"
                    style={{ left: `calc(${pct(st.from - 1)} + ${i > 0 ? 1 : 0}px)`, width: `calc(${pct(laps)} - ${i > 0 ? 1 : 0}px)`, background: c.color }}
                    title={`${driver?.code ?? finisher.driver}: ${st.compound.toLowerCase()}, laps ${st.from}–${st.to}`}
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
    </>
  );
}

/** An earlier race at the circuit, picked by year: each car's stints in finishing order. Years show as their races load. */
function StrategyHistory() {
  const data = useCircuitRaces();
  const [settings, update] = useSettings<Settings>();
  const picked = data.entries.find((e) => e.year === settings.year && !e.error) ?? data.entries.find((e) => e.race) ?? data.entries[0];
  const notice = circuitNotice(data, skeleton);
  let body;
  if (notice) body = <div className="flex flex-1 flex-col px-3">{notice}</div>;
  else if (picked?.race) body = <Race race={picked.race} show={settings.show} />;
  else if (picked?.loading) body = skeleton;
  else
    body = (
      <div className="flex flex-1 flex-col items-start justify-center gap-2 px-3">
        <p className="text-red-400">{picked?.error}</p>
        <RetryButton onClick={data.retry} />
      </div>
    );
  return (
    <div className="flex h-full flex-col text-xs">
      <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 px-3 pt-2">
        <Label>Strategies{data.circuit ? ` at ${data.circuit}` : ""}</Label>
        <span className="flex-1" />
        {data.entries.length > 0 && (
          <div className="flex rounded-md bg-zinc-900 p-0.5" role="group" aria-label="Year">
            {data.entries.map((e) => {
              const on = e === picked;
              return (
                <button
                  key={e.sessionKey}
                  type="button"
                  aria-pressed={on}
                  disabled={!e.race}
                  onClick={(ev) => {
                    ev.currentTarget.blur();
                    update({ year: e.year });
                  }}
                  title={e.error ?? (e.loading ? `${e.year}: loading` : e.meetingName)}
                  className={`rounded px-1.5 py-px text-[11px] font-semibold tabular-nums ${
                    on ? "bg-zinc-700 text-zinc-50" : e.race ? "text-zinc-300 hover:text-zinc-50" : e.error ? "text-red-400/80" : "text-zinc-400 motion-safe:animate-pulse"
                  }`}
                >
                  {e.year}
                </button>
              );
            })}
          </div>
        )}
      </div>
      {body}
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
