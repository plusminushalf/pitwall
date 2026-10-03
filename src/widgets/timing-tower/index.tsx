import { memo, useMemo } from "react";
import {
  defineWidget,
  gap,
  Icon,
  LABEL_CLASS,
  lapTime,
  sectorTime,
  shortTeam,
  teamColor,
  TyreBadge,
  useBestSectors,
  useWidgetSize,
  useDriver,
  useDrivers,
  useFastestLap,
  useLaps,
  useLeaderLap,
  useRunningOrder,
  useSelection,
  useSessionInfo,
  useSettings,
  useTime,
  type DriverInfo,
  type DriverState,
  type Lap,
} from "widget-kit";

type GapMode = "leader" | "interval";
type Settings = { gapMode: GapMode };

const ROW_H = 30;
/** The selection line (h-7 and its hairline) and the column titles (py-1.5, a line of 11 px label, the hairline). */
const HEAD_H = 28 + 1 + 12 + (11 * 20) / 14 + 1;
const COLS = "grid-cols-[22px_22px_minmax(0,1fr)_60px_58px_40px_20px]";
/** With the last lap's sectors and the best lap, once the widget is WIDE px or more. */
const WIDE_COLS = "grid-cols-[22px_22px_minmax(0,1fr)_60px_46px_46px_46px_58px_58px_40px_20px]";
/** Practice: no grid to gain places from, and laps run (or a PIT tag) in the last column. */
const PRACTICE_COLS = "grid-cols-[28px_minmax(0,1fr)_60px_58px_40px_28px]";
const PRACTICE_WIDE_COLS = "grid-cols-[28px_minmax(0,1fr)_60px_46px_46px_46px_58px_58px_40px_28px]";
const colsOf = (wide: boolean, practice: boolean) => (practice ? (wide ? PRACTICE_WIDE_COLS : PRACTICE_COLS) : wide ? WIDE_COLS : COLS);
const WIDE = 590;
// Left gutter for the selection check.
const PAD = "pl-5 pr-2";
/** What the columns other than the driver's take (fixed widths, gap-1 between, PAD), so the driver's gets the rest. */
const FIXED_W = 22 + 22 + 60 + 58 + 40 + 20 + 6 * 4 + 20 + 8;
const WIDE_FIXED_W = FIXED_W + 3 * 46 + 58 + 4 * 4;
/** Practice's (no grid-change column, a wider last one). */
const PRACTICE_FIXED_W = 28 + 60 + 58 + 40 + 28 + 5 * 4 + 20 + 8;
const fixedWidthOf = (wide: boolean, practice: boolean) => (practice ? PRACTICE_FIXED_W : FIXED_W) + (wide ? WIDE_FIXED_W - FIXED_W : 0);

/**
 * How wide the driver column must be to show every team's name whole after the stripe and acronym (gap-2
 * apart), in the page's font: names are shown in full or not at all ("Merc…" says less than the stripe).
 */
function teamNamesWidth(drivers: readonly DriverInfo[]): number {
  const ctx = typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d");
  if (!ctx) return Infinity;
  const family = getComputedStyle(document.body).fontFamily;
  const widest = (font: string, texts: string[]) => {
    ctx.font = font;
    return Math.max(0, ...texts.map((t) => ctx.measureText(t).width));
  };
  // The acronym is text-sm bold with tracking-wide (0.025em), the team text-xs.
  const acronym = widest(`700 14px ${family}`, drivers.map((d) => d.acronym)) + 3 * 0.35;
  return 4 + 8 + acronym + 8 + widest(`12px ${family}`, drivers.map((d) => shortTeam(d.team))) + 1;
}

/** What a row shows of its driver: it re-renders only when one of these changes. */
interface RowData {
  status: DriverState["status"];
  position: number | null;
  gridPosition: number | null;
  gap: number | string | null;
  lastLap: Lap | null;
  bestLap: number | null;
  personalBest: boolean;
  compound: string | null;
  tyreAge: number | null;
  pitStops: number;
}

const rowData = (mode: GapMode) => (s: DriverState): RowData => ({
  status: s.status,
  position: s.position,
  gridPosition: s.gridPosition,
  gap: mode === "leader" ? s.gapToLeader : s.interval,
  lastLap: s.lastLap,
  bestLap: s.bestLap?.duration ?? null,
  personalBest: s.lastLap != null && s.bestLap === s.lastLap,
  compound: s.compound,
  tyreAge: s.tyreAge,
  pitStops: s.pitStops,
});

/** Practice: the gap to the fastest (or the car ahead) by best lap, also from the garage; P1 shows its time. */
function PracticeGapCell({ s }: { s: RowData }) {
  if (s.status === "OUT") return <span className="font-semibold text-red-400">OUT</span>;
  if (s.position === 1 && s.bestLap != null) return <span className="tabular-nums text-zinc-200">{lapTime(s.bestLap)}</span>;
  return <span className="tabular-nums">{gap(s.gap)}</span>;
}

function GapCell({ s, mode }: { s: RowData; mode: GapMode }) {
  // Only the leader's row reads the leader's lap (whether the race has started).
  const started = useLeaderLap((l) => l > 0);
  if (s.status === "OUT") return <span className="font-semibold text-red-400">OUT</span>;
  if (s.status === "PIT") return <span className="rounded bg-zinc-200 px-1.5 text-[11px] font-bold text-zinc-900">PIT</span>;
  const flag = s.status === "FINISHED" ? <Icon name="chequered" size={12} label="Finished" className="mr-1 inline-block align-[-2px]" /> : null;
  if (s.position === 1) return <span className="text-zinc-400">{flag}{started ? (mode === "leader" ? "Leader" : "Interval") : ""}</span>;
  return (
    <span className="tabular-nums">
      {flag}
      {gap(s.gap)}
    </span>
  );
}

function LastLapCell({ n, s }: { n: number; s: RowData }) {
  const l = s.lastLap;
  // The fastest lap's number if it's this driver's, so other rows ignore a new fastest lap.
  const fastest = useFastestLap((f) => (f?.driver === n ? f.lap : null));
  // Practice: race control has deleted it by now (track limits).
  const deleted = useTime((t) => l?.deleted != null && t >= l.deleted.t);
  if (!l) return <span className="text-zinc-600">—</span>;
  if (deleted) {
    return (
      <span className="tabular-nums text-zinc-400 line-through" title={`Deleted: ${l.deleted!.reason.toLowerCase()}`}>
        {lapTime(l.duration)}
      </span>
    );
  }
  const color = fastest === l.lap ? "text-fuchsia-400" : s.personalBest ? "text-emerald-400" : "text-zinc-300";
  return <span className={`tabular-nums ${color}`}>{lapTime(l.duration)}</span>;
}

/** Practice's last column: laps run so far, or PIT while the car is in the pits (the garage, mostly). */
function LapsCell({ n, s }: { n: number; s: RowData }) {
  const laps = useLaps(n, (l) => l.length);
  if (s.status === "PIT") return <span className="rounded bg-zinc-200 px-1 text-[10px] font-bold text-zinc-900">PIT</span>;
  return <span className="text-right text-xs tabular-nums text-zinc-400">{laps}</span>;
}

/** Each sector's fastest time among a driver's laps so far. */
const personalBestSectors = (laps: readonly Lap[]) =>
  [0, 1, 2].map((k) => laps.reduce<number | null>((min, l) => (l.sectors[k] != null && (min == null || l.sectors[k]! < min) ? l.sectors[k] : min), null));

/** The last lap's sector times: purple for the fastest by anyone so far, green for the driver's own best. */
function SectorCells({ n, s }: { n: number; s: RowData }) {
  const overall = useBestSectors();
  const own = useLaps(n, personalBestSectors);
  return (
    <>
      {[0, 1, 2].map((k) => {
        const v = s.lastLap?.sectors[k] ?? null;
        if (v == null) return <span key={k} className="text-xs text-zinc-600">—</span>;
        const color = v === overall[k] ? "text-fuchsia-400" : v === own[k] ? "text-emerald-400" : "text-zinc-300";
        return (
          <span key={k} className={`text-xs tabular-nums ${color}`}>
            {sectorTime(v)}
          </span>
        );
      })}
    </>
  );
}

function BestLapCell({ n, s }: { n: number; s: RowData }) {
  const fastest = useFastestLap((f) => (f?.driver === n ? f.duration : null));
  if (s.bestLap == null) return <span className="text-xs text-zinc-600">—</span>;
  return <span className={`text-xs tabular-nums ${fastest === s.bestLap ? "text-fuchsia-400" : "text-zinc-300"}`}>{lapTime(s.bestLap)}</span>;
}

function Change({ s }: { s: RowData }) {
  if (s.gridPosition == null || s.position == null || s.status === "OUT") return null;
  const delta = s.gridPosition - s.position;
  if (delta === 0) return <span className="text-zinc-600">–</span>;
  return delta > 0 ? <span className="text-emerald-400">▲{delta}</span> : <span className="text-red-400">▼{-delta}</span>;
}

/** One driver's row: memoised, and subscribed to just that driver's fields. */
const Row = memo(function Row({
  d,
  index,
  mode,
  wide,
  team,
  practice,
  isSelected,
  isFocused,
  onToggle,
}: {
  d: DriverInfo;
  index: number;
  mode: GapMode;
  wide: boolean;
  /** Show the team's name after the acronym. */
  team: boolean;
  practice: boolean;
  isSelected: boolean;
  isFocused: boolean;
  onToggle: (n: number) => void;
}) {
  const select = useMemo(() => rowData(mode), [mode]);
  const s = useDriver(d.number, select);
  if (!s) return null;
  return (
    <button
      onClick={() => onToggle(d.number)}
      aria-pressed={isSelected}
      title={isSelected ? `Remove ${d.acronym} from the selection` : `Add ${d.acronym} to the selection (filters the track map)`}
      className={`group absolute inset-x-0 grid ${colsOf(wide, practice)} items-center gap-1 ${PAD} text-left transition-transform duration-500 ease-out focus-visible:-outline-offset-2 ${
        isFocused ? "bg-zinc-800" : isSelected ? "bg-zinc-800/50 hover:bg-zinc-800/70" : "hover:bg-zinc-900"
      } ${s.status === "OUT" ? "opacity-50" : ""}`}
      style={{ height: ROW_H, transform: `translateY(${index * ROW_H}px)` }}
    >
      <span
        aria-hidden
        className={`absolute left-1.5 top-1/2 flex h-3 w-3 -translate-y-1/2 items-center justify-center rounded-full ${
          isSelected ? "bg-zinc-100 text-zinc-900" : "border border-zinc-600 opacity-0 group-hover:opacity-100"
        } ${isSelected && isFocused ? "ring-2 ring-zinc-100/40" : ""}`}
      >
        {isSelected && <Icon name="check" size={9} className="[&_path]:[stroke-width:2.5]" />}
      </span>
      <span className="font-bold tabular-nums">{s.status === "OUT" ? "–" : s.position}</span>
      {!practice && (
        <span className="text-[10px]">
          <Change s={s} />
        </span>
      )}
      <span className="flex min-w-0 items-center gap-2">
        <span className="h-4 w-1 shrink-0 rounded-sm" style={{ background: teamColor(d.teamColour) }} />
        <span className="font-bold tracking-wide">{d.acronym}</span>
        {team && (
          <span className="whitespace-nowrap text-xs text-zinc-400" title={d.team}>
            {shortTeam(d.team)}
          </span>
        )}
      </span>
      <span className="text-xs">{practice ? <PracticeGapCell s={s} /> : <GapCell s={s} mode={mode} />}</span>
      {wide && <SectorCells n={d.number} s={s} />}
      <span className="text-xs">
        <LastLapCell n={d.number} s={s} />
      </span>
      {wide && <BestLapCell n={d.number} s={s} />}
      <TyreBadge compound={s.compound} age={s.tyreAge} />
      {practice ? (
        <span className="flex justify-end">
          <LapsCell n={d.number} s={s} />
        </span>
      ) : (
        <span className="text-right text-xs tabular-nums text-zinc-400">{s.pitStops}</span>
      )}
    </button>
  );
});

function TimingTower() {
  const drivers = useDrivers();
  const order = useRunningOrder();
  const { selected, focused, toggle, clear } = useSelection();
  const [{ gapMode }, update] = useSettings<Settings>();
  const rowIndex = useMemo(() => new Map(order.map((n, i) => [n, i])), [order]);
  const { width } = useWidgetSize();
  const wide = width >= WIDE;
  // Practice: ordered by best lap, gaps by best lap, and laps run instead of pit stops.
  const practice = useSessionInfo((i) => i.kind === "practice");
  const teamRoom = useMemo(() => teamNamesWidth(drivers), [drivers]);
  const teams = width - fixedWidthOf(wide, practice) >= teamRoom;

  return (
    <div className="flex h-full flex-col text-sm">
      <div className="flex h-7 shrink-0 items-center border-b border-zinc-800 px-2 text-[11px]">
        {selected.length > 0 ? (
          <span className="text-zinc-400">
            Showing <span className="font-semibold tabular-nums text-zinc-100">{selected.length}</span> on track ·{" "}
            <button onClick={clear} className="rounded px-1 font-semibold text-zinc-200 underline-offset-2 hover:bg-zinc-800 hover:text-white hover:underline" title="Show every car on the track map (esc)">
              Show all
            </button>
          </span>
        ) : (
          <span className="text-zinc-400">Click drivers to show only them on the track map</span>
        )}
      </div>
      <div className={`grid shrink-0 ${colsOf(wide, practice)} items-center gap-1 border-b border-zinc-800 ${PAD} py-1.5 ${LABEL_CLASS}`}>
        <span>Pos</span>
        {!practice && <span />}
        <span>Driver</span>
        <button
          onClick={() => update({ gapMode: gapMode === "leader" ? "interval" : "leader" })}
          className="flex items-center gap-1 rounded-sm text-left uppercase hover:text-zinc-100"
          title={
            practice
              ? gapMode === "leader"
                ? "Gap to the fastest by best lap: switch to the car ahead"
                : "Gap to the car ahead by best lap: switch to the fastest"
              : gapMode === "leader"
                ? "Gap to the leader: switch to the interval to the car ahead"
                : "Interval to the car ahead: switch to the gap to the leader"
          }
        >
          {gapMode === "leader" ? "Gap" : "Int"}
          <Icon name="swap" size={11} />
        </button>
        {wide && (
          <>
            <span title="Last lap's sector 1">S1</span>
            <span title="Last lap's sector 2">S2</span>
            <span title="Last lap's sector 3">S3</span>
          </>
        )}
        <span>Last</span>
        {wide && <span title="Best lap so far">Best</span>}
        <span>Tyre</span>
        {practice ? (
          <span className="text-right" title="Laps run">
            Laps
          </span>
        ) : (
          <span className="text-right">Pit</span>
        )}
      </div>
      <div className="relative min-h-0 flex-1 overflow-y-auto">
        <div className="relative" style={{ height: order.length * ROW_H }}>
          {drivers.map((d) => (
            <Row
              key={d.number}
              d={d}
              index={rowIndex.get(d.number) ?? 0}
              mode={gapMode}
              wide={wide}
              team={teams}
              practice={practice}
              isSelected={selected.includes(d.number)}
              isFocused={focused === d.number}
              onToggle={toggle}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

export default defineWidget({
  id: "timing-tower",
  name: "Timing tower",
  description: "Every driver's position, gap, last lap (with its sectors) and best lap, tyre and pit stops. In practice, by best lap.",
  version: "1.0.0",
  // Fills its column; the rows scroll inside when they don't all fit.
  height: { min: HEAD_H + 5 * ROW_H },
  width: { min: 22, default: 35, max: 45 },
  sessions: ["race", "practice"],
  settings: { gapMode: "leader" as GapMode },
  fields: {
    gapMode: {
      kind: "choice",
      label: "Gap",
      options: [
        { value: "leader", label: "Gap to leader" },
        { value: "interval", label: "Interval" },
      ],
    },
  },
  Component: TimingTower,
});
