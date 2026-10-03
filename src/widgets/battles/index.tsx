import { useCallback, useMemo } from "react";
import {
  defineWidget,
  DriverTag,
  Label,
  useAllLaps,
  useAllStints,
  useDrivers,
  useFeed,
  useNeutralPeriods,
  usePlayback,
  useSelection,
  useSettings,
  useTotalLaps,
  type DriverInfo,
  type FeedEntry,
  type NeutralPeriod,
  type StintView,
} from "widget-kit";
import { detectBattles, type Battle, type CarLaps, type Pass } from "./detect";

type Show = "all" | "selected";
type Settings = { gap: number; minLaps: number; show: Show };

/** A click jumps to this long before the moment, like the race feed. */
const LEAD_MS = 5_000;

const NEUTRAL: Record<NeutralPeriod["status"], string> = { SC: "Safety car", VSC: "VSC", RED: "Red flag" };

/** The feed items the detector reads: pit-lane entries, overtakes and retirements. */
const relevant = (f: FeedEntry) => f.kind === "pit" || f.kind === "overtake" || f.kind === "retired";

const pickFeed = (feed: readonly FeedEntry[]) => feed.filter(relevant);
/** Each car's stint starts only: the open stint's end moves every lap, and the widget re-renders only when a stint starts. */
const stintStarts = (all: ReadonlyMap<number, readonly StintView[]>) => new Map([...all].map(([n, stints]) => [n, stints.map((s) => s.lapStart)]));

/** Gaps at the line, to the thousandth like the timing tower. */
const seconds = (s: number) => `${s.toFixed(3)} s`;

/** Starts a ring's beat on the page clock, so every light in the list beats together however late its battle began. */
const onBeat = (el: HTMLElement | null) => el?.getAnimations().forEach((a) => (a.startTime = 0));

/** A battle going on at the playhead: a light that beats while the replay plays and holds still while paused. */
function NowLight({ playing }: { playing: boolean }) {
  return (
    <span className="relative flex h-1.5 w-1.5 shrink-0" title="Going on now">
      {playing && <span ref={onBeat} className="absolute inset-0 rounded-full bg-emerald-400 opacity-75 motion-safe:animate-[ping_2s_cubic-bezier(0,0,0.2,1)_infinite]" />}
      <span className="relative h-1.5 w-1.5 rounded-full bg-emerald-400" />
      <span className="sr-only">Now</span>
    </span>
  );
}

function BattleRow({
  b,
  info,
  playing,
  onBattle,
  onPass,
}: {
  b: Battle;
  info: Map<number, DriverInfo>;
  playing: boolean;
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
            ? NEUTRAL[e.neutral ?? "SC"]
            : e.reason === "flag"
              ? "to the flag"
              : "gap opened";
    outcome = `${name(b.ahead)} ahead, ${why}`;
  }
  return (
    // Battles going on now sit on a faint wash of their light's colour, so the live ones read as one band above the rest.
    <li className={`border-b border-zinc-900 ${b.ongoing ? "bg-emerald-400/[0.05] hover:bg-emerald-400/10" : "hover:bg-zinc-900"}`}>
      <button onClick={() => onBattle(b)} className="block w-full px-3 pt-1.5 pb-1 text-left" title={`Jump to 5 s before lap ${b.from}'s line`}>
        <span className="flex items-center gap-1.5">
          <span className="flex w-9 shrink-0 items-center justify-between pr-0.5">
            <span className="text-[11px] font-semibold tabular-nums text-zinc-400" title={`Fighting for P${b.position}`}>
              P{b.position}
            </span>
            {b.ongoing && <NowLight playing={playing} />}
          </span>
          <DriverTag number={b.ahead} driver={info.get(b.ahead)} />
          <DriverTag number={b.behind} driver={info.get(b.behind)} />
          <span className="ml-auto text-xs tabular-nums text-zinc-200" title="Closest at the line">
            {seconds(b.closest)}
          </span>
        </span>
        <span className="mt-0.5 flex gap-1.5 pl-[42px] text-[11px] text-zinc-400">
          <span className="shrink-0 tabular-nums">{laps}</span>
          <span className="truncate">{outcome}</span>
        </span>
      </button>
      {b.passes.length > 0 && (
        <div className="flex flex-wrap gap-1 pb-1.5 pl-[54px] pr-3">
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
  const laps = useAllLaps();
  const starts = useAllStints(stintStarts);
  const neutral = useNeutralPeriods();
  const totalLaps = useTotalLaps();
  const selected = useSelection((s) => s.selected);
  const focus = useSelection((s) => s.focus);
  const seek = usePlayback((p) => p.seek);
  const playing = usePlayback((p) => p.playing);
  const [{ gap, minLaps, show }, update] = useSettings<Settings>();
  const info = useMemo(() => new Map<number, DriverInfo>(drivers.map((d) => [d.number, d])), [drivers]);

  const battles = useMemo(() => {
    const oldestFirst = [...feed].reverse();
    const passes = oldestFirst
      .filter((f) => f.kind === "overtake" && f.driver != null && f.passed != null)
      .map((f) => ({ t: f.t, by: f.driver!, on: f.passed! }));
    const pitEntries = oldestFirst.filter((f) => f.kind === "pit" && f.driver != null).map((f) => ({ driver: f.driver!, t: f.t }));
    const retired = new Set(oldestFirst.filter((f) => f.kind === "retired").map((f) => f.driver));
    // The winner took the flag at the end of the race distance; every car crossing the line since has too.
    let flag = Infinity;
    for (const car of laps.values()) for (const l of car) if (l.lap === totalLaps && l.end != null) flag = Math.min(flag, l.end);
    const cars = [...laps].map(
      ([driver, own]): CarLaps => ({
        driver,
        laps: own,
        stintStarts: starts.get(driver) ?? [],
        out: retired.has(driver),
        finished: (own.at(-1)?.end ?? -Infinity) >= flag,
      }),
    );
    return detectBattles({ cars, neutral, pitEntries, passes }, { gap, minLaps });
  }, [feed, laps, starts, neutral, totalLaps, gap, minLaps]);

  const shown = show === "selected" ? battles.filter((b) => selected.includes(b.ahead) || selected.includes(b.behind)) : battles;

  // Focus the chaser (driver widgets follow it); the track map filter (selection) stays as it is.
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
      <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-1.5">
        <Label as="h2">Battles</Label>
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
          <BattleRow key={b.key} b={b} info={info} playing={playing} onBattle={onBattle} onPass={onPass} />
        ))}
      </ol>
    </section>
  );
}

export default defineWidget({
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
