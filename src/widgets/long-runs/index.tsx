import { useEffect, useMemo } from "react";
import {
  defineWidget,
  Label,
  LABEL_CLASS,
  lapTime,
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
  useTrackStatus,
  useWidgetSize,
  type DriverInfo,
  type Lap,
  type StintView,
} from "widget-kit";
import { degText, listRows, longRuns, MIN_RUN_LAPS, pinAt, pinFor, type ListRow, type PinnedRun, type PinProgress, type RunLap, type RunStint } from "./runs";

type Show = "all" | "selected";
type Settings = { minLaps: number; show: Show };

/** Rank, driver, laps, tyre age, average, gap, trend. */
const COLS = "grid grid-cols-[16px_56px_34px_30px_minmax(0,1fr)_50px_44px] items-center gap-x-1.5";
/** Under NARROW px (a phone's full width is about 360) the gap column goes: the averages it comes from stay. */
const NARROW_COLS = "grid grid-cols-[16px_56px_34px_30px_minmax(0,1fr)_44px] items-center gap-x-1.5";
const NARROW = 340;
const colsOf = (narrow: boolean) => (narrow ? NARROW_COLS : COLS);

const slimLaps = (laps: readonly Lap[]): RunLap[] => laps.map((l) => ({ lap: l.lap, start: l.start, end: l.end, duration: l.duration, pitOut: l.pitOut }));
const slimStints = (stints: readonly StintView[]): RunStint[] =>
  stints.map((s) => ({ stint: s.stint, lapStart: s.lapStart, compound: s.compound, ageAtStart: s.ageAtStart ?? 0, open: s.open })); // practice: OpenF1's stints as they are, never null

const compoundName = (c: string) => c.charAt(0) + c.slice(1).toLowerCase();
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
/** The progress bar moves in steps of half a percent: the widget re-renders that often while a run is watched. */
const step = (p: PinProgress | null) => p && { ...p, fraction: Math.round(p.fraction * 200) / 200 };

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

function RunRow({ row, info, live, narrow, onPick }: { row: ListRow; info: DriverInfo | undefined; live: boolean; narrow: boolean; onPick: (r: ListRow) => void }) {
  const { run, rank, gap, pinned } = row;
  const name = info?.acronym ?? `#${run.driver}`;
  const from = run.laps[0];
  const to = run.laps.at(-1)!;
  const what =
    `${name} on ${run.compound.toLowerCase()}s ${run.age === 0 ? "from new" : `${plural(run.age, "lap")} old`}: laps ${from}–${to}, ` +
    `${plural(run.laps.length, "lap")} counted${run.skipped ? ` (${run.skipped} slow or under a neutral period left out)` : ""}, ` +
    `average ${lapTime(run.average)}, ${degText(run.deg)} s/lap.`;
  const title = pinned
    ? `Watching: lap ${pinned.lap} of the ${run.laps.length} counted. ${what} ${ordinal(rank)} on ${run.compound.toLowerCase()}s when you picked it. Click to watch it again from lap ${from}.`
    : `${what} Click to watch it from lap ${from}.`;
  return (
    <li className={pinned ? "relative bg-zinc-800/80" : undefined}>
      <button onClick={() => onPick(row)} className={`${colsOf(narrow)} w-full px-3 py-1 text-left ${pinned ? "" : "hover:bg-zinc-900"}`} title={title} aria-current={pinned ? "true" : undefined}>
        {pinned ? (
          <span className="rounded-sm bg-zinc-100 text-center text-[10px] font-bold leading-4 tabular-nums text-zinc-900">{rank}</span>
        ) : (
          <span className="text-[11px] font-semibold tabular-nums text-zinc-400">{rank}</span>
        )}
        <span className="flex items-center gap-1">
          <DriverChip n={run.driver} d={info} />
        </span>
        <span className="text-right text-xs tabular-nums text-zinc-300">
          {pinned ? (
            <>
              <span className="text-zinc-50">{pinned.lap}</span>
              <span className="text-zinc-400">/{pinned.of}</span>
            </>
          ) : (
            run.laps.length
          )}
          {live && !pinned && <span className="ml-0.5 inline-block h-1.5 w-1.5 rounded-full bg-emerald-400 align-middle" title="On this run now" />}
        </span>
        <span className="text-right text-xs tabular-nums text-zinc-400">{run.age}</span>
        <span className={`text-right text-xs tabular-nums ${rank === 1 || pinned ? "font-semibold text-zinc-50" : "text-zinc-200"}`}>{lapTime(run.average)}</span>
        {!narrow && <span className="text-right text-xs tabular-nums text-zinc-400">{gap != null ? `+${gap.toFixed(3)}` : ""}</span>}
        <span className="text-right text-xs tabular-nums text-zinc-400">{degText(run.deg)}</span>
      </button>
      {/* How far the replay is into the run. */}
      {pinned && (
        <span aria-hidden className="absolute inset-x-0 bottom-0 h-0.5 bg-zinc-700">
          <span className="block h-full bg-zinc-100" style={{ width: `${pinned.fraction * 100}%` }} />
        </span>
      )}
    </li>
  );
}

/** Every driver's long runs so far (race simulations), ranked by average lap within each compound. */
function LongRuns() {
  const drivers = useDrivers();
  const laps = useAllLaps();
  const stints = useAllStints();
  const neutral = useNeutralPeriods();
  const finished = useTrackStatus((s) => s === "CHEQUERED");
  const selected = useSelection((s) => s.selected);
  const focus = useSelection((s) => s.focus);
  const toggle = useSelection((s) => s.toggle);
  const seek = usePlayback((p) => p.seek);
  const [{ minLaps, show }, update] = useSettings<Settings>();
  const info = useMemo(() => new Map<number, DriverInfo>(drivers.map((d) => [d.number, d])), [drivers]);
  const sessionKey = useSessionInfo((i) => i.sessionKey);
  const narrow = useWidgetSize().width < NARROW;

  // The run clicked, kept in the list while it's watched (runs.ts); it goes once the replay leaves it.
  const [pin, setPin] = useCardState<PinnedRun | null>("pin", null);
  const progress = useTime((t) => (pin ? step(pinAt(pin, t, sessionKey)) : null));
  useEffect(() => {
    if (pin && !progress) setPin(null);
  }, [pin, progress]);

  const groups = useMemo(() => {
    const runs = [...laps].flatMap(([n, own]) => longRuns(n, slimLaps(own), slimStints(stints.get(n) ?? []), neutral, minLaps));
    return listRows(show === "selected" ? runs.filter((r) => selected.includes(r.driver)) : runs, pin, progress);
  }, [laps, stints, neutral, minLaps, show, selected, pin, progress]);

  // Watch the run from its first lap, with its driver focused; with drivers selected, it joins them (so stint pace
  // and the track map show it too). It stays in the list meanwhile (pinned); clicking it again starts it over.
  const onPick = (row: ListRow) => {
    const r = row.run;
    setPin(pinFor(row, pin, sessionKey));
    seek(r.start);
    if (selected.length > 0 && !selected.includes(r.driver)) toggle(r.driver);
    focus(r.driver);
  };

  return (
    <section className="flex h-full flex-col text-sm">
      <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-1.5">
        <Label as="h2" className="shrink-0 whitespace-nowrap">
          Long runs
        </Label>
        <span className="truncate text-[11px] text-zinc-400" title={`Runs of ${minLaps} or more laps at pace on one set, ranked by average within each compound`}>
          {minLaps}+ laps on a set
        </span>
        <div className="ml-auto flex shrink-0 rounded-md bg-zinc-900 p-0.5">
          {(["all", "selected"] as const).map((v) => (
            <button
              key={v}
              onClick={() => update({ show: v })}
              aria-pressed={show === v}
              className={`${TAP_CLASS} rounded px-2 text-[11px] leading-5 ${show === v ? "bg-zinc-700 text-zinc-50" : "text-zinc-300 hover:text-white"}`}
              title={v === "all" ? "Every driver's runs" : "The selected drivers' runs"}
            >
              {v === "all" ? "All" : "Selected"}
            </button>
          ))}
        </div>
      </div>
      <div className={`${colsOf(narrow)} border-b border-zinc-800 px-3 py-1 ${LABEL_CLASS}`}>
        <span />
        <span>Driver</span>
        <span className="text-right" title="Laps counted">
          Laps
        </span>
        <span className="text-right" title="Laps on the set at the start of the run">
          Age
        </span>
        <span className="text-right" title="Average of the laps counted">
          Avg
        </span>
        {!narrow && (
          <span className="text-right" title="Behind the quickest run on the compound">
            Gap
          </span>
        )}
        <span className="text-right" title="Seconds per lap slower as the tyres age (fuel burning off is in it too)">
          s/lap
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {groups.length === 0 && (
          <p className="px-3 py-6 text-center text-xs text-zinc-400">{show === "selected" && selected.length === 0 ? "No drivers selected" : show === "selected" ? "No long runs by the selected drivers yet" : "No long runs yet"}</p>
        )}
        {groups.map((g) => (
          <div key={g.compound}>
            <div className="flex items-center gap-1.5 px-3 pt-2 pb-0.5">
              <TyreBadge compound={g.compound} size={14} />
              <span className="text-xs font-semibold text-zinc-200">{compoundName(g.compound)}</span>
              <span className="text-[11px] text-zinc-400">{plural(g.rows.length, "run")}</span>
            </div>
            <ol>
              {g.rows.map((row) => (
                <RunRow key={`${row.run.driver}:${row.run.stint}:${row.run.laps[0]}`} row={row} info={info.get(row.run.driver)} live={row.run.ongoing && !finished} narrow={narrow} onPick={onPick} />
              ))}
            </ol>
          </div>
        ))}
      </div>
      <p className="border-t border-zinc-800 px-3 py-1 text-[11px] leading-4 text-zinc-400">
        Out-, in- and slow laps and laps under a VSC, safety car or red flag aren't counted. Fuel loads aren't known: a quick run may be a light one.
      </p>
    </section>
  );
}

export default defineWidget({
  id: "long-runs",
  name: "Long runs",
  group: "analysis",
  description: `Practice's race simulations: every run of ${MIN_RUN_LAPS}+ laps at pace on one set, its average and trend, ranked by compound. Fuel loads aren't known.`,
  version: "1.0.0",
  // Fills its column and scrolls inside.
  height: { min: 150 },
  width: { min: 24, default: 28, max: 50 },
  sessions: ["practice"],
  settings: { minLaps: MIN_RUN_LAPS, show: "all" as Show },
  fields: {
    minLaps: {
      kind: "choice",
      label: "Laps at pace",
      options: [
        { value: 5, label: "5 or more" },
        { value: 8, label: "8 or more" },
        { value: 10, label: "10 or more" },
      ],
    },
    show: {
      kind: "choice",
      label: "Show",
      options: [
        { value: "all", label: "Every driver's runs" },
        { value: "selected", label: "Selected drivers' runs" },
      ],
    },
  },
  Component: LongRuns,
});
