import { useEffect, useMemo, useState } from "react";
import {
  defineWidget,
  Label,
  LABEL_CLASS,
  lapTime,
  teamColor,
  textOn,
  TyreBadge,
  useAllLaps,
  useAllStints,
  useDrivers,
  useNeutralPeriods,
  usePlayback,
  useSelection,
  useSessionInfo,
  useTime,
  useWidgetSize,
  type DriverInfo,
  type Lap,
  type StintView,
} from "widget-kit";
import { BIG_DROP, byCompound, dropText, pinHolds, pushSets, SMALL_DROP, withPin, type PinnedSet, type PushLap, type PushStint, type SetPushes } from "./pushes";

/** Rank, driver, tyre age, 1st push, best push, pushes, drop. */
const COLS = "grid grid-cols-[16px_56px_28px_minmax(0,1fr)_minmax(0,1fr)_40px_52px] items-center gap-x-1.5";
/** Under NARROW px (a phone's full width is about 360) the 1st push column goes: the drop from it stays. */
const NARROW_COLS = "grid grid-cols-[16px_56px_28px_minmax(0,1fr)_40px_52px] items-center gap-x-1.5";
const NARROW = 380;
const colsOf = (narrow: boolean) => (narrow ? NARROW_COLS : COLS);

const slimLaps = (laps: readonly Lap[], deleted: ReadonlySet<number>): PushLap[] =>
  laps.map((l) => ({ lap: l.lap, start: l.start, end: l.end, duration: l.duration, pitOut: l.pitOut, deleted: deleted.has(l.lap) }));
const slimStints = (stints: readonly StintView[]): PushStint[] =>
  stints.map((s) => ({ stint: s.stint, lapStart: s.lapStart, compound: s.compound, ageAtStart: s.ageAtStart ?? 0 })); // practice: OpenF1's stints as they are, never null

const compoundName = (c: string) => c.charAt(0) + c.slice(1).toLowerCase();
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
/** Small drops and gains: the set held up; big drops: it didn't (as lap compare colours slower and quicker). */
const dropClass = (d: number) => (d <= SMALL_DROP ? "text-emerald-300" : d > BIG_DROP ? "text-red-300" : "text-zinc-200");

/** A driver's team-coloured acronym. */
function DriverChip({ n, d }: { n: number; d: DriverInfo | undefined }) {
  return (
    <span
      className={`inline-block rounded px-1 text-center text-[10px] font-bold leading-4 ${d ? "" : "bg-zinc-700 text-zinc-100"}`}
      style={d ? { background: teamColor(d.teamColour), color: textOn(d.teamColour) } : undefined}
    >
      {d?.acronym ?? `#${n}`}
    </span>
  );
}

function SetRow({ set, rank, info, pinned, narrow, onPick }: { set: SetPushes; rank: number; info: DriverInfo | undefined; pinned: boolean; narrow: boolean; onPick: (s: SetPushes) => void }) {
  const name = info?.acronym ?? `#${set.driver}`;
  const title =
    `${name} on ${set.compound.toLowerCase()}s, ${set.age === 0 ? "new" : `${plural(set.age, "lap")} old`} at the first push: ` +
    `${plural(set.laps.length, "push lap")} (${set.laps.map((l, i) => `lap ${l} ${lapTime(set.times[i])}`).join(", ")}). ` +
    `${pinned ? "Watching. " : ""}Click to watch from the first push.`;
  return (
    <li className={pinned ? "bg-zinc-800/80" : undefined}>
      <button onClick={() => onPick(set)} className={`${colsOf(narrow)} w-full px-3 py-1 text-left ${pinned ? "" : "hover:bg-zinc-900"}`} title={title} aria-current={pinned ? "true" : undefined}>
        <span className="text-[11px] font-semibold tabular-nums text-zinc-400">{rank}</span>
        <span className="flex items-center gap-1">
          <DriverChip n={set.driver} d={info} />
        </span>
        <span className="text-right text-xs tabular-nums text-zinc-400">{set.age}</span>
        {!narrow && <span className="text-right text-xs tabular-nums text-zinc-300">{lapTime(set.first)}</span>}
        <span className={`text-right text-xs tabular-nums ${rank === 1 ? "font-semibold text-zinc-50" : "text-zinc-200"}`}>{lapTime(set.best)}</span>
        <span className="text-right text-xs tabular-nums text-zinc-400">{set.laps.length}</span>
        {set.drop == null ? (
          <span className="text-right text-xs text-zinc-400" title="One push lap on the set">
            −
          </span>
        ) : (
          <span className={`text-right text-xs font-semibold tabular-nums ${dropClass(set.drop)}`}>{dropText(set.drop)}</span>
        )}
      </button>
    </li>
  );
}

/** Every driver's push laps so far, set by set (quali simulations), ranked by best push within each compound. */
function PushLaps() {
  const drivers = useDrivers();
  const laps = useAllLaps();
  const stints = useAllStints();
  const neutral = useNeutralPeriods();
  const selected = useSelection((s) => s.selected);
  const focus = useSelection((s) => s.focus);
  const toggle = useSelection((s) => s.toggle);
  const seek = usePlayback((p) => p.seek);
  const info = useMemo(() => new Map<number, DriverInfo>(drivers.map((d) => [d.number, d])), [drivers]);
  const sessionKey = useSessionInfo((i) => i.sessionKey);
  const narrow = useWidgetSize().width < NARROW;

  // Laps race control has deleted by now ("driver:lap"); re-renders only when that changes.
  const deletedKeys = useTime((t) => {
    const out: string[] = [];
    for (const [n, own] of laps) for (const l of own) if (l.deleted && t >= l.deleted.t) out.push(`${n}:${l.lap}`);
    return out;
  });

  // The set clicked, kept in the list while its pushes are watched (pushes.ts); it goes once the replay leaves them.
  const [pin, setPin] = useState<PinnedSet | null>(null);
  const held = useTime((t) => (pin ? pinHolds(pin, t, sessionKey) : false));
  useEffect(() => {
    if (pin && !held) setPin(null);
  }, [pin, held]);

  const groups = useMemo(() => {
    const deleted = new Map<number, Set<number>>();
    for (const k of deletedKeys) {
      const [n, lap] = k.split(":").map(Number);
      if (!deleted.has(n)) deleted.set(n, new Set());
      deleted.get(n)!.add(lap);
    }
    const sets = [...laps].flatMap(([n, own]) => pushSets(n, slimLaps(own, deleted.get(n) ?? new Set()), slimStints(stints.get(n) ?? []), neutral));
    return byCompound(withPin(sets, held ? pin : null));
  }, [laps, stints, neutral, deletedKeys, pin, held]);

  // Watch the set from its first push lap, with its driver focused; with drivers selected, it joins them.
  const onPick = (s: SetPushes) => {
    setPin(pin && held && pin.set.driver === s.driver && pin.set.stint === s.stint ? pin : { set: s, sessionKey });
    seek(s.start);
    if (selected.length > 0 && !selected.includes(s.driver)) toggle(s.driver);
    focus(s.driver);
  };

  return (
    <section className="flex h-full flex-col text-sm">
      <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-1.5">
        <Label as="h2" className="shrink-0 whitespace-nowrap">
          Push laps
        </Label>
        <span className="truncate text-[11px] text-zinc-400" title="Laps within 1.5% of the driver's best, or of the best on a set pushed on (within 3% of the driver's best)">
          by set, ranked by best push
        </span>
      </div>
      <div className={`${colsOf(narrow)} border-b border-zinc-800 px-3 py-1 ${LABEL_CLASS}`}>
        <span />
        <span>Driver</span>
        <span className="text-right" title="Laps on the set at the first push">
          Age
        </span>
        {!narrow && (
          <span className="text-right" title="The first push lap on the set">
            1st
          </span>
        )}
        <span className="text-right" title="The best push lap on the set">
          Best
        </span>
        <span className="text-right" title="Push laps on the set">
          Laps
        </span>
        <span className="text-right" title="The 2nd push lap minus the 1st: the grip the set lost (− a gain)">
          Drop
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {groups.length === 0 && <p className="px-3 py-6 text-center text-xs text-zinc-400">No push laps yet</p>}
        {groups.map((g) => (
          <div key={g.compound}>
            <div className="flex items-center gap-1.5 px-3 pt-2 pb-0.5">
              <TyreBadge compound={g.compound} size={14} />
              <span className="text-xs font-semibold text-zinc-200">{compoundName(g.compound)}</span>
              <span className="text-[11px] text-zinc-400">{plural(g.sets.length, "set")}</span>
            </div>
            <ol>
              {g.sets.map((s, i) => (
                <SetRow
                  key={`${s.driver}:${s.stint}`}
                  set={s}
                  rank={i + 1}
                  info={info.get(s.driver)}
                  pinned={held && pin != null && pin.set.driver === s.driver && pin.set.stint === s.stint}
                  narrow={narrow}
                  onPick={onPick}
                />
              ))}
            </ol>
          </div>
        ))}
      </div>
      <p className="border-t border-zinc-800 px-3 py-1 text-[11px] leading-4 text-zinc-400">
        Drop: the 2nd push lap on a set minus the 1st, usually with a cool-down lap between. Within {SMALL_DROP} s the tyres held up; more is thermal degradation. A gain is
        often the track getting quicker.
      </p>
    </section>
  );
}

export default defineWidget({
  id: "push-laps",
  name: "Push laps",
  group: "analysis",
  description: "Practice's quali simulations set by set: the first and best push lap, how many, and the drop from the 1st push to the 2nd (thermal degradation).",
  version: "1.0.0",
  // Fills its column and scrolls inside.
  height: { min: 160 },
  width: { min: 24, default: 34, max: 60 },
  sessions: ["practice"],
  settings: {},
  Component: PushLaps,
});
