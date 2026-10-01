import { useCallback, useLayoutEffect, useMemo, useState } from "react";
import {
  defineBlock,
  teamColor,
  textOn,
  useDriver,
  useDrivers,
  useFeed,
  useLaps,
  usePlayback,
  useSelection,
  useSettings,
  useStints,
  type DriverInfo,
  type FeedEntry,
} from "block-kit";
import { detectBattles, neutralSpells, type Battle, type CarLaps, type NeutralKind, type Pass } from "./detect";

type Show = "all" | "selected";
type Settings = { gap: number; minLaps: number; show: Show };

/** A click jumps to this long before the moment, like the race feed. */
const LEAD_MS = 5_000;

const NEUTRAL: Record<NeutralKind, string> = { sc: "Safety car", vsc: "VSC", red: "Red flag" };

/** The feed items the detector reads: pit entries, overtakes, and safety car, VSC and red flag messages. */
const relevant = (f: FeedEntry) =>
  f.kind === "pit" || f.kind === "overtake" || f.kind === "safety-car" || f.kind === "flag" || (f.kind === "control" && f.text.startsWith("RED FLAG"));

const pickFeed = (feed: readonly FeedEntry[]) => feed.filter(relevant);
const stintStarts = (stints: readonly { lapStart: number }[]) => stints.map((s) => s.lapStart);
const outOrFinished = (d: { status: string }) => (d.status === "OUT" ? "out" : d.status === "FINISHED" ? "finished" : null);

/**
 * One car's completed laps, stints and status, reported up to the block when they change (once a lap, or
 * on a seek): block-kit's lap hooks are per car, and the battles need every car.
 */
function CarProbe({ n, report }: { n: number; report: (car: CarLaps) => void }) {
  const laps = useLaps(n);
  const starts = useStints(n, stintStarts);
  const done = useDriver(n, outOrFinished);
  useLayoutEffect(() => report({ driver: n, laps, stintStarts: starts, out: done === "out", finished: done === "finished" }), [n, laps, starts, done, report]);
  return null;
}

/** A driver's team-coloured acronym. */
function DriverChip({ n, d }: { n: number; d: DriverInfo | undefined }) {
  return (
    <span
      className={`inline-block rounded px-1 text-[10px] font-bold leading-4 ${d ? "" : "bg-zinc-700 text-zinc-100"}`}
      style={d ? { background: teamColor(d.teamColour), color: textOn(d.teamColour) } : undefined}
    >
      {d?.acronym ?? `#${n}`}
    </span>
  );
}

/** Gaps at the line, to the thousandth like the timing tower. */
const seconds = (s: number) => `${s.toFixed(3)} s`;

function BattleRow({
  b,
  info,
  onBattle,
  onPass,
}: {
  b: Battle;
  info: Map<number, DriverInfo>;
  onBattle: (b: Battle) => void;
  onPass: (p: Pass) => void;
}) {
  const name = (n: number) => info.get(n)?.acronym ?? `#${n}`;
  const laps = b.from === b.to ? `Lap ${b.from}` : `Laps ${b.from}–${b.to}`;
  let outcome: string;
  if (b.ongoing) outcome = `${name(b.ahead)} ahead by ${seconds(b.last)}`;
  else {
    const e = b.end!;
    const why =
      e.reason === "pit"
        ? `${name(e.driver!)} pitted`
        : e.reason === "retired"
          ? `${name(e.driver!)} retired`
          : e.reason === "neutral"
            ? NEUTRAL[e.neutral ?? "sc"]
            : e.reason === "flag"
              ? "to the flag"
              : "gap opened";
    outcome = `${name(b.ahead)} ahead, ${why}`;
  }
  return (
    <li className="border-b border-zinc-900 hover:bg-zinc-900">
      <button onClick={() => onBattle(b)} className="block w-full px-3 pt-1.5 pb-1 text-left" title={`Jump to 5 s before lap ${b.from}'s line`}>
        <span className="flex items-center gap-1.5">
          <span className="w-7 text-[11px] font-semibold tabular-nums text-zinc-400" title={`Fighting for P${b.position}`}>
            P{b.position}
          </span>
          <DriverChip n={b.ahead} d={info.get(b.ahead)} />
          <DriverChip n={b.behind} d={info.get(b.behind)} />
          {b.ongoing && <span className="rounded bg-zinc-800 px-1.5 text-[10px] font-semibold uppercase leading-4 tracking-wider text-zinc-200">Now</span>}
          <span className="ml-auto text-xs tabular-nums text-zinc-200" title="Closest at the line">
            {seconds(b.closest)}
          </span>
        </span>
        <span className="mt-0.5 flex gap-1.5 pl-[34px] text-[11px] text-zinc-400">
          <span className="shrink-0 tabular-nums">{laps}</span>
          <span className="truncate">{outcome}</span>
        </span>
      </button>
      {b.passes.length > 0 && (
        <div className="flex flex-wrap gap-1 pb-1.5 pl-[46px] pr-3">
          {b.passes.map((p) => (
            <button
              key={`${p.lap}-${p.by}`}
              onClick={() => onPass(p)}
              className="rounded bg-zinc-800 px-1.5 text-[11px] leading-5 text-zinc-200 hover:bg-zinc-700 hover:text-white"
              title={
                p.exact
                  ? `${name(p.by)} passes ${name(p.on)} on lap ${p.lap}: jump to 5 s before`
                  : `${name(p.by)} was ahead of ${name(p.on)} at the end of lap ${p.lap}: jump to 5 s before that line`
              }
            >
              <span className="tabular-nums text-zinc-400">L{p.lap}</span> {name(p.by)} passes
            </button>
          ))}
        </div>
      )}
    </li>
  );
}

function Battles() {
  const drivers = useDrivers();
  const feed = useFeed(pickFeed);
  const selected = useSelection((s) => s.selected);
  const focus = useSelection((s) => s.focus);
  const seek = usePlayback((p) => p.seek);
  const [{ gap, minLaps, show }, update] = useSettings<Settings>();
  const info = useMemo(() => new Map<number, DriverInfo>(drivers.map((d) => [d.number, d])), [drivers]);

  const [cars, setCars] = useState<ReadonlyMap<number, CarLaps>>(new Map());
  const report = useCallback((car: CarLaps) => setCars((m) => new Map(m).set(car.driver, car)), []);

  const battles = useMemo(() => {
    const oldestFirst = [...feed].reverse();
    const number = new Map(drivers.map((d) => [d.acronym, d.number]));
    // The feed names the car passed only in its text: "VER passes NOR for P3".
    const passes = oldestFirst
      .filter((f) => f.kind === "overtake" && f.driver != null)
      .map((f) => ({ t: f.t, by: f.driver!, on: number.get(/ passes (\S+)/.exec(f.text)?.[1] ?? "") ?? null }));
    const pitEntries = oldestFirst.filter((f) => f.kind === "pit" && f.driver != null).map((f) => ({ driver: f.driver!, t: f.t }));
    return detectBattles({ cars: [...cars.values()].filter((c) => info.has(c.driver)), neutral: neutralSpells(oldestFirst), pitEntries, passes }, { gap, minLaps });
  }, [cars, feed, drivers, info, gap, minLaps]);

  const shown = show === "selected" ? battles.filter((b) => selected.includes(b.ahead) || selected.includes(b.behind)) : battles;

  // Focus the chaser (driver blocks follow it); the track map filter (selection) stays as it is.
  const onBattle = useCallback(
    (b: Battle) => {
      seek(b.t - LEAD_MS);
      focus(b.behind);
    },
    [seek, focus],
  );
  const onPass = useCallback(
    (p: Pass) => {
      seek(p.t - LEAD_MS);
      focus(p.by);
    },
    [seek, focus],
  );

  return (
    <section className="flex h-full flex-col text-sm">
      {drivers.map((d) => (
        <CarProbe key={d.number} n={d.number} report={report} />
      ))}
      <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-1.5">
        <h2 className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Battles</h2>
        <span className="truncate text-[11px] text-zinc-400">
          Within {gap.toFixed(1)} s at the line, {minLaps}+ laps
        </span>
        <div className="ml-auto flex shrink-0 rounded-md bg-zinc-900 p-0.5">
          {(["all", "selected"] as const).map((v) => (
            <button
              key={v}
              onClick={() => update({ show: v })}
              aria-pressed={show === v}
              className={`rounded px-2 text-[11px] leading-5 ${show === v ? "bg-zinc-700 text-zinc-50" : "text-zinc-300 hover:text-white"}`}
              title={v === "all" ? "Every battle" : "Battles with a selected driver"}
            >
              {v === "all" ? "All" : "Selected"}
            </button>
          ))}
        </div>
      </div>

      <ol className="min-h-0 flex-1 overflow-y-auto">
        {shown.length === 0 && (
          <li className="px-3 py-6 text-center text-xs text-zinc-400">
            {show === "selected" && selected.length === 0 ? "No drivers selected" : battles.length > 0 ? "No battles with the selected drivers yet" : "No battles yet"}
          </li>
        )}
        {shown.map((b) => (
          <BattleRow key={b.key} b={b} info={info} onBattle={onBattle} onPass={onPass} />
        ))}
      </ol>
    </section>
  );
}

export default defineBlock({
  id: "battles",
  name: "Battles",
  description: "Cars within a second of each other for laps on end: who passed whom, and who's ahead now.",
  version: "1.0.0",
  // Fills its column and scrolls inside, so the layout never jumps as battles come and go.
  height: { min: 150 },
  width: { min: 18, default: 24, max: 40 },
  sessions: ["race"],
  settings: { gap: 1, minLaps: 3, show: "all" as Show },
  fields: {
    gap: {
      kind: "choice",
      label: "Gap at the line",
      options: [
        { value: 0.5, label: "0.5 s" },
        { value: 1, label: "1 s" },
        { value: 1.5, label: "1.5 s" },
        { value: 2, label: "2 s" },
      ],
    },
    minLaps: {
      kind: "choice",
      label: "Laps in a row",
      options: [
        { value: 2, label: "2 laps" },
        { value: 3, label: "3 laps" },
        { value: 5, label: "5 laps" },
      ],
    },
    show: {
      kind: "choice",
      label: "Show",
      options: [
        { value: "all", label: "All battles" },
        { value: "selected", label: "Selected drivers' battles" },
      ],
    },
  },
  Component: Battles,
});
