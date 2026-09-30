import { memo, useMemo } from "react";
import {
  defineBlock,
  gap,
  lapTime,
  shortTeam,
  teamColor,
  TyreBadge,
  useDriver,
  useDrivers,
  useFastestLap,
  useLeaderLap,
  useRunningOrder,
  useSelection,
  useSettings,
  type DriverInfo,
  type DriverState,
  type Lap,
} from "block-kit";

type GapMode = "leader" | "interval";
type Settings = { gapMode: GapMode };

const ROW_H = 30;
/** The selection line and the column titles (about 56 px). */
const HEAD_H = 56;
const COLS = "grid-cols-[22px_22px_minmax(0,1fr)_72px_58px_40px_20px]";
// Left gutter for the selection check.
const PAD = "pl-5 pr-2";

/** What a row shows of its driver: it re-renders only when one of these changes. */
interface RowData {
  status: DriverState["status"];
  position: number | null;
  gridPosition: number | null;
  gap: number | string | null;
  lastLap: Lap | null;
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
  personalBest: s.lastLap != null && s.bestLap === s.lastLap,
  compound: s.compound,
  tyreAge: s.tyreAge,
  pitStops: s.pitStops,
});

function GapCell({ s, mode }: { s: RowData; mode: GapMode }) {
  // Only the leader's row reads the leader's lap (whether the race has started).
  const started = useLeaderLap((l) => l > 0);
  if (s.status === "OUT") return <span className="font-semibold text-red-400">OUT</span>;
  if (s.status === "PIT") return <span className="rounded bg-zinc-200 px-1.5 text-[11px] font-bold text-zinc-900">PIT</span>;
  const flag = s.status === "FINISHED" ? <span className="mr-1" title="Finished">🏁</span> : null;
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
  if (!l) return <span className="text-zinc-600">—</span>;
  const color = fastest === l.lap ? "text-fuchsia-400" : s.personalBest ? "text-emerald-400" : "text-zinc-300";
  return <span className={`tabular-nums ${color}`}>{lapTime(l.duration)}</span>;
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
  isSelected,
  isFocused,
  onToggle,
}: {
  d: DriverInfo;
  index: number;
  mode: GapMode;
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
      className={`group absolute inset-x-0 grid ${COLS} items-center gap-1 ${PAD} text-left transition-transform duration-500 ease-out ${
        isFocused ? "bg-zinc-800" : isSelected ? "bg-zinc-800/50 hover:bg-zinc-800/70" : "hover:bg-zinc-900"
      } ${s.status === "OUT" ? "opacity-50" : ""}`}
      style={{ height: ROW_H, transform: `translateY(${index * ROW_H}px)` }}
    >
      <span
        aria-hidden
        className={`absolute left-1.5 top-1/2 flex h-3 w-3 -translate-y-1/2 items-center justify-center rounded-full text-[8px] font-black leading-none ${
          isSelected ? "bg-zinc-100 text-zinc-900" : "border border-zinc-600 opacity-0 group-hover:opacity-100"
        } ${isSelected && isFocused ? "ring-2 ring-zinc-100/40" : ""}`}
      >
        {isSelected ? "✓" : null}
      </span>
      <span className="font-bold tabular-nums">{s.status === "OUT" ? "–" : s.position}</span>
      <span className="text-[10px]">
        <Change s={s} />
      </span>
      <span className="flex min-w-0 items-center gap-2">
        <span className="h-4 w-1 shrink-0 rounded-sm" style={{ background: teamColor(d.teamColour) }} />
        <span className="font-bold tracking-wide">{d.acronym}</span>
        <span className="truncate text-xs text-zinc-500" title={d.team}>
          {shortTeam(d.team)}
        </span>
      </span>
      <span className="text-xs">
        <GapCell s={s} mode={mode} />
      </span>
      <span className="text-xs">
        <LastLapCell n={d.number} s={s} />
      </span>
      <TyreBadge compound={s.compound} age={s.tyreAge} />
      <span className="text-right text-xs tabular-nums text-zinc-400">{s.pitStops}</span>
    </button>
  );
});

function TimingTower() {
  const drivers = useDrivers();
  const order = useRunningOrder();
  const { selected, focused, toggle, clear } = useSelection();
  const [{ gapMode }, update] = useSettings<Settings>();
  const rowIndex = useMemo(() => new Map(order.map((n, i) => [n, i])), [order]);

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
          <span className="text-zinc-600">Click drivers to show only them on the track map</span>
        )}
      </div>
      <div className={`grid shrink-0 ${COLS} items-center gap-1 border-b border-zinc-800 ${PAD} py-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500`}>
        <span>Pos</span>
        <span />
        <span>Driver</span>
        <button
          onClick={() => update({ gapMode: gapMode === "leader" ? "interval" : "leader" })}
          className="text-left uppercase hover:text-zinc-200"
          title="Toggle gap to leader / interval"
        >
          {gapMode === "leader" ? "Gap ⇄" : "Int ⇄"}
        </button>
        <span>Last</span>
        <span>Tyre</span>
        <span className="text-right">Pit</span>
      </div>
      <div className="relative min-h-0 flex-1 overflow-y-auto">
        <div className="relative" style={{ height: order.length * ROW_H }}>
          {drivers.map((d) => (
            <Row
              key={d.number}
              d={d}
              index={rowIndex.get(d.number) ?? 0}
              mode={gapMode}
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

export default defineBlock({
  id: "timing-tower",
  name: "Timing tower",
  description: "Every driver's position, gap, last lap, tyre and pit stops.",
  version: "1.0.0",
  // Fills its column; the rows scroll inside when they don't all fit.
  height: { min: HEAD_H + 5 * ROW_H },
  width: { min: 22, default: 24, max: 40 },
  sessions: ["race"],
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
