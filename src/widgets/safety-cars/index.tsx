import { CircuitAxis, CircuitFrame, CircuitYearRows, defineWidget, useCircuitRaces, type NeutralKind, type PastRace } from "widget-kit";

/** How each kind is drawn: the replay header's flag colours, a VSC hatched too so it isn't colour alone. */
const KIND: Record<NeutralKind, { label: string; short: string; background: string }> = {
  SC: { label: "Safety car", short: "SC", background: "#fbbf24" },
  VSC: { label: "Virtual safety car", short: "VSC", background: "repeating-linear-gradient(135deg, #fcd34d 0 3px, #78350f 3px 5px)" },
  RED: { label: "Red flag", short: "Red", background: "#dc2626" },
};

const ROW_H = 22;
const MAX_ROWS = 4;

/** "1 SC · 1 VSC", or "None". */
function counts(race: PastRace): string {
  const n = (k: NeutralKind) => race.neutral.filter((p) => p.kind === k).length;
  const parts = (["SC", "VSC", "RED"] as const).filter((k) => n(k) > 0).map((k) => `${n(k)} ${KIND[k].short}`);
  return parts.length ? parts.join(" · ") : "None";
}

/** Each earlier race at the circuit as a strip of its laps, with the laps run behind a safety car, a VSC or a red flag. */
function SafetyCars() {
  const data = useCircuitRaces();
  const entries = data.entries.slice(0, MAX_ROWS);
  const withAny = data.races.filter((r) => r.neutral.length > 0).length;
  // Laps across: the longest shown (a typical race distance until one is in).
  const maxLaps = Math.max(...entries.map((e) => e.race?.laps ?? 0), 0) || 60;
  const ticks = Array.from({ length: Math.floor(maxLaps / 10) }, (_, i) => ({ value: (i + 1) * 10, text: String((i + 1) * 10) }));
  return (
    <CircuitFrame
      title="Safety cars"
      what="Safety cars"
      data={data}
      done={
        <span className="tabular-nums text-zinc-300" title="Races with a safety car, a VSC or a red flag">
          {withAny} of {data.races.length} {data.races.length === 1 ? "race" : "races"}
        </span>
      }
    >
      <CircuitYearRows
        entries={entries}
        plot={(race) => (
          <div className="relative h-3 rounded-sm bg-zinc-800/80">
            {race.neutral.map((p, i) => (
              <div
                key={i}
                className="absolute inset-y-0 rounded-[1px]"
                style={{ left: `${((p.from - 1) / maxLaps) * 100}%`, width: `max(3px, ${((p.to - p.from + 1) / maxLaps) * 100}%)`, background: KIND[p.kind].background }}
                title={`${KIND[p.kind].label}, ${p.from === p.to ? `lap ${p.from}` : `laps ${p.from}–${p.to}`}`}
              />
            ))}
            {/* The race's own distance, when it's shorter than the longest shown (a race cut short). */}
            {race.laps < maxLaps && <div className="absolute inset-y-0 right-0 bg-zinc-950/70" style={{ width: `${((maxLaps - race.laps) / maxLaps) * 100}%` }} />}
          </div>
        )}
        value={(race) => <span className={race.neutral.length ? "" : "text-zinc-400"}>{counts(race)}</span>}
        axis={<CircuitAxis ticks={ticks} x={(v) => v / maxLaps} />}
        unit="lap"
      />
      <div className="mt-auto flex items-center gap-3 pt-1 text-[11px] text-zinc-400">
        {(["SC", "VSC", "RED"] as const).map((k) => (
          <span key={k} className="flex items-center gap-1">
            <span className="inline-block h-2.5 w-3 rounded-[1px]" style={{ background: KIND[k].background }} />
            {KIND[k].label}
          </span>
        ))}
      </div>
    </CircuitFrame>
  );
}

export default defineWidget({
  id: "safety-cars",
  name: "Safety cars",
  group: "circuit",
  description: "Earlier races at this circuit: the laps run behind a safety car, a VSC or a red flag, year by year.",
  version: "1.0.0",
  // py-2, the title (20), the rows, the lap axis (16) and the legend (4 + 16).
  height: 8 + 20 + 4 + MAX_ROWS * ROW_H + 16 + 20 + 8,
  width: { min: 24, default: 40, max: 100 },
  sessions: ["race", "practice"],
  settings: {},
  Component: SafetyCars,
});
