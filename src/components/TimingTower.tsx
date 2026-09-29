import type { DriverState, RaceState } from "../engine/raceState";
import { gap, lapTime, shortTeam, teamColor } from "../lib/format";
import { useReplay } from "../store";
import { TyreBadge } from "./TyreBadge";

const ROW_H = 30;
const COLS = "grid-cols-[22px_22px_minmax(0,1fr)_72px_58px_40px_20px]";
// Left gutter for the selection check.
const PAD = "pl-5 pr-2";

function GapCell({ s, race, mode }: { s: DriverState; race: RaceState; mode: "leader" | "interval" }) {
  if (s.status === "OUT") return <span className="font-semibold text-red-400">OUT</span>;
  if (s.status === "PIT") return <span className="rounded bg-zinc-200 px-1.5 text-[11px] font-bold text-zinc-900">PIT</span>;
  const isLeader = s.position === 1;
  const flag = s.status === "FINISHED" ? <span className="mr-1" title="Finished">🏁</span> : null;
  if (isLeader) return <span className="text-zinc-400">{flag}{race.leaderLap > 0 ? (mode === "leader" ? "Leader" : "Interval") : ""}</span>;
  return (
    <span className="tabular-nums">
      {flag}
      {gap(mode === "leader" ? s.gapToLeader : s.interval)}
    </span>
  );
}

function LastLapCell({ s, race }: { s: DriverState; race: RaceState }) {
  const l = s.lastLap;
  if (!l) return <span className="text-zinc-600">—</span>;
  const overall = race.fastestLap && race.fastestLap.driver === l.driver && race.fastestLap.lap === l.lap;
  const personal = s.bestLap === l;
  const color = overall ? "text-fuchsia-400" : personal ? "text-emerald-400" : "text-zinc-300";
  return <span className={`tabular-nums ${color}`}>{lapTime(l.duration)}</span>;
}

function Change({ s }: { s: DriverState }) {
  if (s.gridPosition == null || s.position == null || s.status === "OUT") return null;
  const delta = s.gridPosition - s.position;
  if (delta === 0) return <span className="text-zinc-600">–</span>;
  return delta > 0 ? (
    <span className="text-emerald-400">▲{delta}</span>
  ) : (
    <span className="text-red-400">▼{-delta}</span>
  );
}

export function TimingTower() {
  const session = useReplay((s) => s.session);
  const race = useReplay((s) => s.race);
  const selected = useReplay((s) => s.selected);
  const focused = useReplay((s) => s.focused);
  const gapMode = useReplay((s) => s.gapMode);
  const toggleSelected = useReplay((s) => s.toggleSelected);
  const clearSelection = useReplay((s) => s.clearSelection);
  const toggleGapMode = useReplay((s) => s.toggleGapMode);
  if (!session || !race) return null;

  const rowIndex = new Map(race.drivers.map((d, i) => [d.driver, i]));

  return (
    <div className="flex h-full flex-col text-sm">
      <div className="flex h-7 shrink-0 items-center border-b border-zinc-800 px-2 text-[11px]">
        {selected.length > 0 ? (
          <span className="text-zinc-400">
            Showing <span className="font-semibold tabular-nums text-zinc-100">{selected.length}</span> on track ·{" "}
            <button onClick={clearSelection} className="rounded px-1 font-semibold text-zinc-200 underline-offset-2 hover:bg-zinc-800 hover:text-white hover:underline" title="Show every car on the track map (esc)">
              Show all
            </button>
          </span>
        ) : (
          <span className="text-zinc-600">Click drivers to show only them on the track map</span>
        )}
      </div>
      <div className={`grid ${COLS} items-center gap-1 border-b border-zinc-800 ${PAD} py-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500`}>
        <span>Pos</span>
        <span />
        <span>Driver</span>
        <button onClick={toggleGapMode} className="text-left uppercase hover:text-zinc-200" title="Toggle gap to leader / interval">
          {gapMode === "leader" ? "Gap ⇄" : "Int ⇄"}
        </button>
        <span>Last</span>
        <span>Tyre</span>
        <span className="text-right">Pit</span>
      </div>
      <div className="relative flex-1 overflow-y-auto">
        <div className="relative" style={{ height: race.drivers.length * ROW_H }}>
          {session.driverNumbers.map((n) => {
            const i = rowIndex.get(n)!;
            const s = race.drivers[i];
            const d = session.drivers.get(n)!.info;
            const isSelected = selected.includes(n);
            const isFocused = focused === n;
            return (
              <button
                key={n}
                onClick={() => toggleSelected(n)}
                aria-pressed={isSelected}
                title={isSelected ? `Remove ${d.acronym} from the selection` : `Add ${d.acronym} to the selection (filters the track map)`}
                className={`group absolute inset-x-0 grid ${COLS} items-center gap-1 ${PAD} text-left transition-transform duration-500 ease-out ${
                  isFocused ? "bg-zinc-800" : isSelected ? "bg-zinc-800/50 hover:bg-zinc-800/70" : "hover:bg-zinc-900"
                } ${s.status === "OUT" ? "opacity-50" : ""}`}
                style={{ height: ROW_H, transform: `translateY(${i * ROW_H}px)` }}
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
                  <GapCell s={s} race={race} mode={gapMode} />
                </span>
                <span className="text-xs">
                  <LastLapCell s={s} race={race} />
                </span>
                <TyreBadge compound={s.compound} age={s.tyreAge} />
                <span className="text-right text-xs tabular-nums text-zinc-400">{s.pitStops}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
