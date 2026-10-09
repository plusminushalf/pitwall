import { useMemo } from "react";
import {
  defineWidget,
  Label,
  LABEL_CLASS,
  lapTime,
  sectorTime,
  shortTeam,
  TAP_CLASS,
  teamColor,
  textOn,
  useAllLaps,
  useAllStints,
  useDrivers,
  useNeutralPeriods,
  usePlayback,
  useSelection,
  useSettings,
  useTime,
  type DriverInfo,
} from "widget-kit";
import { COLUMNS, deletionsUpTo, driverBests, gapText, groupBests, IDEAL, SPEED, strength, strengthTable, validLaps, type Bests, type Cell, type Mark } from "./strengths";

type By = "teams" | "drivers";
type Settings = { by: By };

/** Name, then S1, S2, S3, ideal and top speed. */
const COLS = "grid grid-cols-[minmax(72px,1.3fr)_repeat(5,minmax(0,1fr))] items-stretch gap-x-px";

const compoundName = (c: string) => c.charAt(0) + c.slice(1).toLowerCase();
const tyreText = (m: Mark) => `${compoundName(m.compound).toLowerCase()}s ${m.age === 0 ? "from new" : `${m.age} lap${m.age === 1 ? "" : "s"} old`}`;
const valueText = (k: number, v: number) => (k === SPEED ? `${Math.round(v)}` : k === IDEAL ? lapTime(v) : sectorTime(v));

/** A row's name: the team on its colour stripe, or the driver's acronym badge. */
function RowName({ label, colour }: { label: string; colour: string | undefined }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5 px-3">
      <span aria-hidden className="h-3.5 w-1 shrink-0 rounded-sm" style={{ background: colour ? teamColor(colour) : "#52525c" }} />
      <span className="truncate text-xs font-semibold text-zinc-100">{label}</span>
    </span>
  );
}

/**
 * One cell: the gap to the column's best (the best shows its own value) and the rank, shaded by rank: the
 * column's best in fuchsia (fastest), then brighter grey the higher up it ranks.
 */
function StrengthCell({ k, cell, who, onPick }: { k: number; cell: Cell | null; who: (n: number) => string; onPick: (m: Mark) => void }) {
  if (!cell) return <span className="flex items-center justify-end px-2 text-xs text-zinc-600">—</span>;
  const { mark, rank, of } = cell;
  const first = rank === 1;
  const unit = k === SPEED ? " km/h" : " s";
  const what =
    k === IDEAL
      ? `Ideal lap ${lapTime(mark.value)}: ${who(mark.driver)}'s best sectors added up. Click to watch their fastest lap (lap ${mark.lap}, ${tyreText(mark)}).`
      : `${COLUMNS[k]} ${valueText(k, mark.value)}${unit}: ${who(mark.driver)}, lap ${mark.lap} on ${tyreText(mark)}. Click to watch the lap.`;
  const title = `${first ? "Fastest" : `${rank} of ${of}, ${gapText(k, cell.gap)}${unit} off the best`}. ${what}`;
  const style = first ? undefined : { background: `rgb(244 244 245 / ${(0.03 + 0.27 * strength(cell)).toFixed(3)})` };
  return (
    <button
      onClick={() => onPick(mark)}
      title={title}
      style={style}
      className={`flex items-center justify-end gap-1 px-2 text-right tabular-nums hover:outline hover:-outline-offset-1 hover:outline-zinc-400 ${first ? "bg-fuchsia-500/45" : ""}`}
    >
      <span className={`text-xs ${first ? "font-semibold text-fuchsia-50" : strength(cell) >= 0.5 ? "text-zinc-50" : "text-zinc-300"}`}>
        {first ? valueText(k, mark.value) : gapText(k, cell.gap)}
      </span>
      <span className={`w-4 text-[10px] ${first ? "text-fuchsia-100" : "text-zinc-400"}`}>{rank}</span>
    </button>
  );
}

/** Where each car is quick: every team's (or driver's) best sectors, ideal lap and top speed so far, ranked by column. */
function SectorStrengths() {
  const drivers = useDrivers();
  const laps = useAllLaps();
  const stints = useAllStints();
  const neutral = useNeutralPeriods();
  // Deletions take effect at their own time, not the lap's end: re-render when one does, not ten times a second.
  const deletedBy = useTime((t) => deletionsUpTo(laps.values(), t));
  const selected = useSelection((s) => s.selected);
  const focus = useSelection((s) => s.focus);
  const toggle = useSelection((s) => s.toggle);
  const seek = usePlayback((p) => p.seek);
  const [{ by }, update] = useSettings<Settings>();
  const info = useMemo(() => new Map<number, DriverInfo>(drivers.map((d) => [d.number, d])), [drivers]);
  const who = (n: number) => info.get(n)?.acronym ?? `#${n}`;

  const rows = useMemo(() => {
    const bests = new Map<number, Bests>();
    for (const [n, own] of laps) bests.set(n, driverBests(n, validLaps(own, stints.get(n) ?? [], neutral, deletedBy)));
    if (by === "drivers") {
      return strengthTable([...bests].map(([n, b]) => ({ key: { label: who(n), colour: info.get(n)?.teamColour }, bests: b })));
    }
    // A team takes the best of its cars in each column.
    const teams = new Map<string, number[]>();
    for (const d of drivers) teams.set(d.team, [...(teams.get(d.team) ?? []), d.number]);
    return strengthTable(
      [...teams].map(([team, ns]) => ({
        key: { label: shortTeam(team), colour: info.get(ns[0])?.teamColour },
        bests: groupBests(ns.map((n) => bests.get(n) ?? [])),
      })),
    );
  }, [laps, stints, neutral, deletedBy, by, drivers, info]);

  // Watch the lap the best was set on, with its driver focused; with drivers selected, it joins them.
  const onPick = (m: Mark) => {
    seek(m.start);
    if (selected.length > 0 && !selected.includes(m.driver)) toggle(m.driver);
    focus(m.driver);
  };

  return (
    <section className="flex h-full flex-col text-sm">
      <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-1.5">
        <Label as="h2" className="shrink-0 whitespace-nowrap">
          Sector strengths
        </Label>
        <span className="truncate text-[11px] text-zinc-400" title="Gap to the best in each column and rank; the fastest in fuchsia">
          {by === "teams" ? "Each team's best car per column" : "Each driver's best per column"}
        </span>
        <div data-shot-control="" className="ml-auto flex shrink-0 rounded-md bg-zinc-900 p-0.5">
          {(["teams", "drivers"] as const).map((v) => (
            <button
              key={v}
              onClick={() => update({ by: v })}
              aria-pressed={by === v}
              className={`${TAP_CLASS} rounded px-2 text-[11px] leading-5 ${by === v ? "bg-zinc-700 text-zinc-50" : "text-zinc-300 hover:text-white"}`}
              title={v === "teams" ? "A row per team, its quicker car in each column" : "A row per driver"}
            >
              {v === "teams" ? "Teams" : "Drivers"}
            </button>
          ))}
        </div>
      </div>
      <div className={`${COLS} border-b border-zinc-800 py-1 ${LABEL_CLASS}`}>
        <span className="px-3">{by === "teams" ? "Team" : "Driver"}</span>
        {COLUMNS.map((c, k) => (
          <span key={c} className="truncate px-2 text-right" title={k === IDEAL ? "Best S1 + S2 + S3" : k === SPEED ? "Speed trap, km/h" : undefined}>
            {k === SPEED ? "Speed" : c}
          </span>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {rows.length === 0 && <p className="px-3 py-6 text-center text-xs text-zinc-400">No laps that count yet</p>}
        <ol>
          {rows.map((r) => (
            <li key={r.key.label} className={`${COLS} h-6 border-b border-zinc-800/70`}>
              <RowName label={r.key.label} colour={r.key.colour} />
              {r.cells.map((c, k) => (
                <StrengthCell key={k} k={k} cell={c} who={who} onPick={onPick} />
              ))}
            </li>
          ))}
        </ol>
      </div>
      <p className="border-t border-zinc-800 px-3 py-1 text-[11px] leading-4 text-zinc-400">
        Sector bests may come from different laps and tyres. Out-, in- and deleted laps and laps under a VSC, safety car or red flag aren't counted.
      </p>
    </section>
  );
}

export default defineWidget({
  id: "sector-strengths",
  name: "Sector strengths",
  group: "analysis",
  description: "Where each car is quick: best S1, S2, S3, ideal lap and top speed by team or driver, each ranked against the field.",
  version: "1.0.0",
  // Header, column labels, eleven team rows and the note; fills its column and scrolls inside (drivers).
  height: { min: 30 + 25 + 11 * 24 + 25 },
  width: { min: 24, default: 34, max: 60 },
  sessions: ["practice", "qualifying"],
  settings: { by: "teams" as By },
  fields: {
    by: {
      kind: "choice",
      label: "Rows",
      options: [
        { value: "teams", label: "Teams" },
        { value: "drivers", label: "Drivers" },
      ],
    },
  },
  Component: SectorStrengths,
});
