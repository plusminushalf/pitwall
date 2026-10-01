import { memo, useCallback, useMemo } from "react";
import {
  defineBlock,
  teamColor,
  textOn,
  TyreBadge,
  useDrivers,
  useFeed,
  useLaps,
  usePitStops,
  usePlayback,
  useSelection,
  useSettings,
  useStints,
  type DriverInfo,
  type FeedEntry,
  type Lap,
  type PitStop,
  type StintView,
} from "block-kit";
import { analyse, type CarInput, type ControlMsg, type Duel, type LapLine, type Neutralised, type PitRecord, type StintStart, type Stop } from "./strategy";

type Show = "all" | "selected";
type Settings = { show: Show };

/** Seek this long before the stop, to watch the car come in. */
const LEAD_MS = 5_000;

// What the analysis reads of each hook: the block re-renders when a lap, stint or stop is added, not at 10 Hz.
const toLines = (laps: readonly Lap[]): LapLine[] => laps.flatMap((l) => (l.end == null ? [] : [{ lap: l.lap, end: l.end }]));
const toStarts = (stints: readonly StintView[]): StintStart[] => stints.map(({ stint, lapStart, compound }) => ({ stint, lapStart, compound }));
const toRecords = (pits: readonly PitStop[]): PitRecord[] => pits.map(({ entry, exit, laneDuration, stopDuration }) => ({ entry, exit, laneDuration, stopDuration }));
/** Safety car messages, and the flags that end one. */
const toControl = (feed: readonly FeedEntry[]): ControlMsg[] =>
  feed
    .filter((f) => f.kind === "safety-car" || (f.kind === "flag" && ["GREEN", "CLEAR", "RED", "CHEQUERED"].includes(f.flag ?? "")))
    .map(({ t, kind, text, flag }) => ({ t, kind, text, flag }));

/**
 * Every car's completed laps, stints and finished stops. One set of hooks per car: `numbers` is fixed for
 * the component's life (PitStrategy remounts it when the session's drivers change), so the hook order is too.
 */
function useCars(numbers: readonly number[]): CarInput[] {
  const cars = numbers.map((n) => ({ driver: n, laps: useLaps(n, toLines), stints: useStints(n, toStarts), pits: usePitStops(n, toRecords) }));
  // The hooks keep their result while it's unchanged, so this changes only when one of them does.
  return useMemo(() => cars, cars.flatMap((c) => [c.laps, c.stints, c.pits]));
}

type Row = { key: string; t: number; stop: Stop; duel?: undefined } | { key: string; t: number; duel: Duel; stop?: undefined };

const UNDER: Record<Exclude<Neutralised, null>, string> = { SC: "under the safety car", VSC: "under the VSC" };

const secs = (s: number) => `${s.toFixed(1)} s`;

/** A driver's team-coloured acronym. */
function DriverChip({ n, d }: { n: number; d: DriverInfo | undefined }) {
  return (
    <span
      className={`inline-block rounded px-1 align-middle text-[10px] font-bold leading-4 ${d ? "" : "bg-zinc-700 text-zinc-100"}`}
      style={d ? { background: teamColor(d.teamColour), color: textOn(d.teamColour) } : undefined}
    >
      {d?.acronym ?? `#${n}`}
    </span>
  );
}

function Tag({ label }: { label: string }) {
  return <span className="inline-block rounded bg-zinc-800 px-1 align-middle text-[10px] font-bold uppercase leading-4 text-zinc-200">{label}</span>;
}

/** Places before the stop and once it's settled; gained in emerald. */
function Places({ before, after }: { before: number | null; after: number | null }) {
  if (before == null && after == null) return null;
  const delta = before != null && after != null ? before - after : null;
  return (
    <span className="ml-auto shrink-0 text-[11px] tabular-nums text-zinc-300">
      {/* Until the out-lap is done the arrow points nowhere yet. */}
      {before != null ? `P${before}` : "?"} → {after != null ? `P${after}` : ""}
      {delta != null && (
        <span className={`ml-1.5 inline-block w-5 text-right ${delta > 0 ? "text-emerald-400" : "text-zinc-400"}`}>{delta > 0 ? `+${delta}` : delta < 0 ? `−${-delta}` : "="}</span>
      )}
    </span>
  );
}

function StopRow({ stop, info }: { stop: Stop; info: Map<number, DriverInfo> }) {
  const detail = [
    stop.lane != null && `${secs(stop.lane)} in the pit lane`,
    stop.stationary != null && `${secs(stop.stationary)} stopped`,
    stop.under && UNDER[stop.under],
  ].filter(Boolean);
  return (
    <>
      <span className="flex items-center gap-1.5">
        <Tag label="Pit" />
        <DriverChip n={stop.driver} d={info.get(stop.driver)} />
        <TyreBadge compound={stop.from} size={14} />
        <span className="text-zinc-400">→</span>
        {stop.to ? <TyreBadge compound={stop.to} size={14} /> : <span className="text-zinc-400">no tyre change</span>}
        <Places before={stop.before} after={stop.after} />
      </span>
      {detail.length > 0 && <span className="block text-[11px] text-zinc-400">{detail.join(" · ")}</span>}
    </>
  );
}

/** What follows the attacker's name ("undercut LEC"), and what happened, in a line. */
function duelText(d: Duel, name: (n: number) => string): { title: string; detail: string } {
  const b = name(d.defender);
  const [aLap, bLap] = [d.attackerStop.lap, d.defenderStop.lap];
  const margin = secs(d.margin);
  const title = d.worked ? `${d.kind} ${b}` : `tried to ${d.kind} ${b}`;
  const detail =
    d.kind === "undercut"
      ? d.worked
        ? `Pitted L${aLap}, ahead after ${b}'s stop on L${bLap} (+${margin})`
        : `Pitted L${aLap}, still ${margin} behind after ${b}'s stop on L${bLap}`
      : `Stayed out to L${aLap} after ${b} pitted on L${bLap}, came out ${margin} ${d.worked ? "ahead" : "behind"}`;
  const under = [d.attackerStop, d.defenderStop].filter((s) => s.under).map((s) => `${name(s.driver)} stopped ${UNDER[s.under!]}`);
  return { title, detail: [detail, ...under].join(" · ") };
}

function DuelRow({ duel, info }: { duel: Duel; info: Map<number, DriverInfo> }) {
  const { title, detail } = duelText(duel, (n) => info.get(n)?.acronym ?? `#${n}`);
  return (
    <>
      <span className="flex items-center gap-1.5">
        <Tag label={duel.kind} />
        <DriverChip n={duel.attacker} d={info.get(duel.attacker)} />
        <span className="min-w-0 truncate text-zinc-200">{title}</span>
        <span className={`ml-auto shrink-0 text-[11px] ${duel.worked ? "text-emerald-400" : "text-zinc-400"}`}>{duel.worked ? "Worked" : "Didn't work"}</span>
      </span>
      <span className="block text-[11px] text-zinc-400">{detail}</span>
    </>
  );
}

/** The later of a duel's two stops: watching it, you see who comes out ahead. */
const secondStop = (d: Duel) => (d.attackerStop.lap > d.defenderStop.lap ? d.attackerStop : d.defenderStop);

const MomentRow = memo(function MomentRow({ row, info, onRow }: { row: Row; info: Map<number, DriverInfo>; onRow: (row: Row) => void }) {
  const lap = row.stop ? row.stop.lap : secondStop(row.duel).lap;
  return (
    <li className="border-b border-zinc-900 hover:bg-zinc-900">
      <button
        onClick={() => onRow(row)}
        className="grid w-full grid-cols-[30px_minmax(0,1fr)] gap-2 px-3 py-1.5 text-left text-xs leading-5"
        title={row.stop ? "Watch from 5 s before the stop" : "Watch the second stop, from 5 s before it"}
      >
        <span className="pt-px text-[11px] tabular-nums text-zinc-400">L{lap}</span>
        <span className="min-w-0">{row.stop ? <StopRow stop={row.stop} info={info} /> : <DuelRow duel={row.duel} info={info} />}</span>
      </button>
    </li>
  );
});

function Moments({ numbers }: { numbers: readonly number[] }) {
  const cars = useCars(numbers);
  const control = useFeed(toControl);
  const [{ show }] = useSettings<Settings>();
  const selected = useSelection((s) => s.selected);
  const focus = useSelection((s) => s.focus);
  const seek = usePlayback((p) => p.seek);
  const drivers = useDrivers();
  const info = useMemo(() => new Map<number, DriverInfo>(drivers.map((d) => [d.number, d])), [drivers]);
  const { stops, duels } = useMemo(() => analyse(cars, control), [cars, control]);

  // Newest first, like the race feed: the latest stop is on top while you watch, and an undercut's
  // outcome arrives on top as soon as it's settled. With nobody selected, the filter shows everyone.
  const filtered = show === "selected" && selected.length > 0;
  const rows = useMemo(() => {
    const shown = (...ns: number[]) => !filtered || ns.some((n) => selected.includes(n));
    const all: Row[] = [
      ...stops.filter((s) => shown(s.driver)).map((stop): Row => ({ key: `s${stop.driver}-${stop.lap}`, t: stop.t, stop })),
      ...duels.filter((d) => shown(d.attacker, d.defender)).map((duel): Row => ({ key: `d${duel.attacker}-${duel.defender}-${duel.attackerStop.lap}`, t: duel.t, duel })),
    ];
    return all.sort((a, b) => b.t - a.t);
  }, [stops, duels, filtered, selected]);

  const onRow = useCallback(
    (row: Row) => {
      const stop = row.stop ?? secondStop(row.duel);
      seek(stop.t - LEAD_MS);
      focus(row.stop ? row.stop.driver : row.duel.attacker);
    },
    [seek, focus],
  );

  const count = stops.filter((s) => !filtered || selected.includes(s.driver)).length;
  return (
    <section className="flex h-full flex-col text-sm">
      <div className="border-b border-zinc-800 px-3 py-1.5">
        <h2 className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
          Pit stops
          <span className="font-normal normal-case tracking-normal text-zinc-400">
            {" "}
            · {count} {count === 1 ? "stop" : "stops"}
            {filtered && ", selected drivers"}
          </span>
        </h2>
      </div>
      <ol className="min-h-0 flex-1 overflow-y-auto">
        {rows.length === 0 && <li className="px-3 py-6 text-center text-xs text-zinc-400">No pit stops yet</li>}
        {rows.map((row) => (
          <MomentRow key={row.key} row={row} info={info} onRow={onRow} />
        ))}
      </ol>
    </section>
  );
}

/** Pit stops and undercut outcomes so far, newest first; a click jumps to just before the stop. */
function PitStrategy() {
  const numbers = useDrivers((ds) => ds.map((d) => d.number));
  return <Moments key={numbers.join(",")} numbers={numbers} />;
}

export default defineBlock({
  id: "pit-strategy",
  name: "Pit stops",
  description: "Pit stops with tyres, pit times and places gained, and whether each undercut worked.",
  version: "1.0.0",
  // Fills its column and scrolls inside, so the layout never jumps as stops arrive.
  height: { min: 150 },
  width: { min: 15, default: 21, max: 40 },
  sessions: ["race"],
  settings: { show: "all" as Show },
  fields: {
    show: {
      kind: "choice",
      label: "Drivers",
      options: [
        { value: "all", label: "All drivers" },
        { value: "selected", label: "Selected drivers" },
      ],
    },
  },
  Component: PitStrategy,
});
