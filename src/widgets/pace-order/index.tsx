import { useEffect, useMemo } from "react";
import {
  defineWidget,
  Label,
  LABEL_CLASS,
  lapTime,
  shortTeam,
  TAP_CLASS,
  teamColor,
  textOn,
  TyreBadge,
  useAllLaps,
  useAllStints,
  useCardState,
  useDrivers,
  useNeutralPeriods,
  usePlayback,
  useSelection,
  useSessionInfo,
  useSettings,
  useTime,
  useWidgetSize,
  type DriverInfo,
  type Lap,
} from "widget-kit";
import { bestLap, leftOf, paceRows, watching, withPin, type PaceRow, type PinnedBest } from "./pace";

type Show = "drivers" | "teams";
type Settings = { show: Show };

/** Rank, driver (or team), tyre, the gap bar, best, gap, ideal, left on the table. */
const COLS = "grid grid-cols-[18px_44px_40px_minmax(40px,1fr)_68px_56px_68px_48px] items-center gap-x-2";
const TEAM_COLS = "grid grid-cols-[18px_128px_40px_minmax(40px,1fr)_68px_56px_68px_48px] items-center gap-x-2";
/** Under NARROW px the ideal lap's column goes (its time is in the row's tooltip); what's left on the table stays. */
const NARROW_COLS = "grid grid-cols-[18px_44px_40px_minmax(24px,1fr)_68px_56px_44px] items-center gap-x-1.5";
const NARROW_TEAM_COLS = "grid grid-cols-[18px_96px_40px_minmax(24px,1fr)_68px_56px_44px] items-center gap-x-1.5";
const NARROW = 460;
const colsOf = (narrow: boolean, teams: boolean) => (narrow ? (teams ? NARROW_TEAM_COLS : NARROW_COLS) : teams ? TEAM_COLS : COLS);

/** The bars' scale: the slowest gap shown, between these (s): a lap 6 s off doesn't squash the rest. */
const SCALE_MIN = 0.5;
const SCALE_MAX = 3;

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
/** The last deletion by race control up to t (validity only needs that, so the list doesn't recompute 10 times a second). */
const lastDeletion = (laps: ReadonlyMap<number, readonly Lap[]>, t: number) => {
  let last = -Infinity;
  for (const own of laps.values()) for (const l of own) if (l.deleted && l.deleted.t <= t && l.deleted.t > last) last = l.deleted.t;
  return last;
};

/** A driver's team-coloured acronym, or the team's name. */
function Chip({ n, d, team }: { n: number; d: DriverInfo | undefined; team: boolean }) {
  return (
    <span
      className={`inline-block truncate rounded px-1 text-center text-[11px] font-bold leading-5 ${d ? "" : "bg-zinc-700 text-zinc-100"}`}
      style={d ? { background: teamColor(d.teamColour), color: textOn(d.teamColour) } : undefined}
    >
      {team && d ? shortTeam(d.team) : (d?.acronym ?? `#${n}`)}
    </span>
  );
}

function PaceRowView({ row, info, scale, narrow, teams, pinned, onPick }: { row: PaceRow; info: DriverInfo | undefined; scale: number; narrow: boolean; teams: boolean; pinned: boolean; onPick: (r: PaceRow) => void }) {
  const { best, rank, gap } = row;
  const name = info?.acronym ?? `#${best.driver}`;
  const left = leftOf(best);
  const first = rank === 1;
  const title =
    `${teams && info ? `${shortTeam(info.team)}, ${name}` : name}: ${lapTime(best.time)} on lap ${best.lap}, ` +
    `${best.compound.toLowerCase()}s ${best.age === 0 ? "new" : `${plural(best.age, "lap")} old`}` +
    `${first ? "" : `, ${gap.toFixed(3)} s off the quickest`}. ` +
    (best.ideal == null ? "No ideal lap yet (a sector without a valid time). " : `Ideal lap (best sectors) ${lapTime(best.ideal)}: ${left!.toFixed(3)} s left on the table. `) +
    (pinned ? "Watching it." : "Click to watch the lap.");
  return (
    <li className={pinned ? "bg-zinc-800/80" : undefined}>
      <button onClick={() => onPick(row)} className={`${colsOf(narrow, teams)} w-full px-3 py-1 text-left ${pinned ? "" : "hover:bg-zinc-900"}`} title={title} aria-current={pinned ? "true" : undefined}>
        <span className={`text-right text-[11px] font-semibold tabular-nums ${first ? "text-zinc-50" : "text-zinc-400"}`}>{rank}</span>
        <span className="flex min-w-0 items-center gap-1">
          <Chip n={best.driver} d={info} team={teams} />
          {teams && !narrow && <span className="text-[11px] text-zinc-400">{name}</span>}
        </span>
        <TyreBadge compound={best.compound} age={best.age} size={16} />
        {/* The gap to the quickest, on one scale for every row. */}
        <span className="relative h-3">
          {!first && (
            <span
              className="absolute inset-y-0 left-0 rounded-sm"
              style={{ width: `max(2px, ${Math.min(1, gap / scale) * 100}%)`, background: info ? teamColor(info.teamColour) : "#71717b" }}
            />
          )}
        </span>
        <span className={`text-right text-xs tabular-nums ${first ? "font-semibold text-zinc-50" : "text-zinc-200"}`}>{lapTime(best.time)}</span>
        <span className="text-right text-xs tabular-nums text-zinc-400">{first ? "" : `+${gap.toFixed(3)}`}</span>
        {!narrow && <span className="text-right text-xs tabular-nums text-zinc-300">{lapTime(best.ideal)}</span>}
        <span className="text-right text-xs tabular-nums text-zinc-400">{left == null ? "—" : left.toFixed(3)}</span>
      </button>
    </li>
  );
}

/** Every driver's best valid lap so far, ranked, on the tyre it was set on, with the ideal lap from their best sectors. */
function PaceOrder() {
  const drivers = useDrivers();
  const laps = useAllLaps();
  const stints = useAllStints();
  const neutral = useNeutralPeriods();
  const selected = useSelection((s) => s.selected);
  const focus = useSelection((s) => s.focus);
  const toggle = useSelection((s) => s.toggle);
  const seek = usePlayback((p) => p.seek);
  const [{ show }, update] = useSettings<Settings>();
  const info = useMemo(() => new Map<number, DriverInfo>(drivers.map((d) => [d.number, d])), [drivers]);
  const sessionKey = useSessionInfo((i) => i.sessionKey);
  const narrow = useWidgetSize().width < NARROW;
  const teams = show === "teams";
  const deletedBy = useTime((t) => lastDeletion(laps, t));

  // The best clicked, kept as its driver's best while its lap is watched (pace.ts); it goes once the lap is done.
  const [pin, setPin] = useCardState<PinnedBest | null>("pin", null);
  const watched = useTime((t) => pin != null && watching(pin, t, sessionKey));
  useEffect(() => {
    if (pin && !watched) setPin(null);
  }, [pin, watched]);

  const rows = useMemo(() => {
    const bests = [...laps].flatMap(([n, own]) => bestLap(n, own, stints.get(n) ?? [], neutral, deletedBy) ?? []);
    return paceRows(withPin(bests, watched ? pin : null), teams ? (n) => info.get(n)?.team ?? `#${n}` : undefined);
  }, [laps, stints, neutral, deletedBy, pin, watched, teams, info]);
  const scale = Math.min(SCALE_MAX, Math.max(SCALE_MIN, ...rows.map((r) => r.gap)));

  // Watch the lap from its start, with its driver focused; with drivers selected, it joins them (so the other
  // widgets show it too). It stays in the list meanwhile (pinned).
  const onPick = (row: PaceRow) => {
    const b = row.best;
    setPin({ best: b, sessionKey });
    seek(b.start);
    if (selected.length > 0 && !selected.includes(b.driver)) toggle(b.driver);
    focus(b.driver);
  };

  return (
    <section className="flex h-full flex-col text-sm">
      <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-1.5">
        <Label as="h2" className="shrink-0 whitespace-nowrap">
          Pace order
        </Label>
        <span className="truncate text-[11px] text-zinc-400" title="Each best valid lap so far, ranked; the bar is the gap to the quickest">
          {teams ? "Each team's quicker driver" : "Best lap so far"}
        </span>
        <div data-shot-control="" className="ml-auto flex shrink-0 rounded-md bg-zinc-900 p-0.5">
          {(["drivers", "teams"] as const).map((v) => (
            <button
              key={v}
              onClick={() => update({ show: v })}
              aria-pressed={show === v}
              className={`${TAP_CLASS} rounded px-2 text-[11px] leading-5 ${show === v ? "bg-zinc-700 text-zinc-50" : "text-zinc-300 hover:text-white"}`}
              title={v === "drivers" ? "Every driver's best lap" : "Each team's best lap, by its quicker driver"}
            >
              {v === "drivers" ? "Drivers" : "Teams"}
            </button>
          ))}
        </div>
      </div>
      <div className={`${colsOf(narrow, teams)} border-b border-zinc-800 px-3 py-1 ${LABEL_CLASS}`}>
        <span />
        <span>{teams ? "Team" : "Driver"}</span>
        <span title="The tyre the lap was set on, and laps on the set">Tyre</span>
        <span />
        <span className="text-right" title="Best valid lap">
          Best
        </span>
        <span className="text-right" title="Behind the quickest">
          Gap
        </span>
        {!narrow && (
          <span className="text-right" title="Ideal lap: the driver's best valid sectors added up">
            Ideal
          </span>
        )}
        <span className="text-right" title="Left on the table: best lap minus ideal lap">
          Left
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {rows.length === 0 && <p className="px-3 py-6 text-center text-xs text-zinc-400">No valid laps yet</p>}
        <ol>
          {rows.map((row) => (
            <PaceRowView
              key={row.best.driver}
              row={row}
              info={info.get(row.best.driver)}
              scale={scale}
              narrow={narrow}
              teams={teams}
              pinned={watched && pin?.best.driver === row.best.driver}
              onPick={onPick}
            />
          ))}
        </ol>
      </div>
      <p className="border-t border-zinc-800 px-3 py-1 text-[11px] leading-4 text-zinc-400">
        Out-, in- and deleted laps and laps under a VSC, safety car or red flag aren't counted. Fuel loads and engine modes aren't known.
      </p>
    </section>
  );
}

export default defineWidget({
  id: "pace-order",
  name: "Pace order",
  group: "analysis",
  description: "The order by best lap: every driver's best valid lap so far, the tyre it was on, the gap to the quickest, and the ideal lap from their best sectors.",
  version: "1.0.0",
  // Fills its column and scrolls inside.
  height: { min: 200 },
  width: { min: 24, default: 32, max: 60 },
  sessions: ["race", "practice", "qualifying"],
  settings: { show: "drivers" as Show },
  fields: {
    show: {
      kind: "choice",
      label: "Show",
      options: [
        { value: "drivers", label: "Every driver" },
        { value: "teams", label: "Each team's quicker driver" },
      ],
    },
  },
  Component: PaceOrder,
});
