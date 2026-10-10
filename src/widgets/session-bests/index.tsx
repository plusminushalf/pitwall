import { useEffect, useMemo, useState } from "react";
import {
  defineWidget,
  DriverTag,
  Label,
  lapTime,
  sectorTime,
  TAP_CLASS,
  TyreBadge,
  useAllLaps,
  useAllPitStops,
  useAllStints,
  useDrivers,
  useLeaderLap,
  usePlayback,
  useSelection,
  useSessionInfo,
  useTime,
  useTotalLaps,
  useWidgetSize,
  type DriverInfo,
  type Lap,
  type PitStop,
  type StintView,
} from "widget-kit";
import { displayName, gapText, LABELS, sessionBests, type BestLap, type BestPit, type BestStint, type Bests, type CarInput, type IdealLap, type Mark, type RecordId, type SessionRecord } from "./bests";

/** Seek this long before a pit stop, to watch the car come in. */
const LEAD_MS = 5_000;
const ROW_H = 28;
const HEADER_H = 30;
/** Under this many px the next driver's column goes (it's in the row's tooltip). */
const NARROW = 380;

/** What, the time, who, the lap and tyres, the next best. */
const COLS = "grid grid-cols-[72px_64px_minmax(0,1fr)_64px_84px] items-center gap-x-2";
const NARROW_COLS = "grid grid-cols-[64px_64px_minmax(0,1fr)_56px] items-center gap-x-2";

// What the records read of each hook: the widget re-renders when a lap, stint or stop is added, not at 10 Hz.
const each =
  <T, R>(pick: (v: readonly T[]) => R[]) =>
  (all: ReadonlyMap<number, readonly T[]>) =>
    new Map([...all].map(([n, v]) => [n, pick(v)]));
const toLaps = each((laps: readonly Lap[]): BestLap[] => laps.map(({ lap, start, end, duration, sectors, speedTrap, deleted }) => ({ lap, start, end, duration, sectors, speedTrap, deleted })));
const toStints = each((stints: readonly StintView[]): BestStint[] => stints.map(({ lapStart, compound, ageAtStart }) => ({ lapStart, compound, ageAtStart })));
const toPits = each((pits: readonly PitStop[]): BestPit[] => pits.map(({ lap, entry, exit, laneDuration, stopDuration }) => ({ lap, entry, exit, laneDuration, stopDuration })));

/** The latest deletion in effect at t: validity only changes then, so the records don't recompute 10 times a second. */
const lastDeletion = (laps: ReadonlyMap<number, readonly BestLap[]>, t: number) => {
  let last = -Infinity;
  for (const own of laps.values()) for (const l of own) if (l.deleted && l.deleted.t <= t && l.deleted.t > last) last = l.deleted.t;
  return last;
};

const isPit = (id: RecordId) => id === "stop" || id === "lane";
const isTimed = (id: RecordId) => id === "lap" || id === "s1" || id === "s2" || id === "s3";

/** A record's value as shown: a lap time, a sector time, km/h or a stop in tenths. */
function valueText(id: RecordId, v: number): string {
  if (id === "lap") return lapTime(v);
  if (id === "speed") return `${Math.round(v)}`;
  if (isPit(id)) return `${v.toFixed(1)} s`;
  return sectorTime(v);
}
const unit = (id: RecordId) => (id === "speed" ? " km/h" : "");

const nameOf = (info: ReadonlyMap<number, DriverInfo>, n: number) => {
  const d = info.get(n);
  return d ? displayName(d.fullName) : `#${n}`;
};

/** The records as text, to paste into a post: "S1 - 31.845 - Lewis Hamilton". */
function asText(bests: Bests, info: ReadonlyMap<number, DriverInfo>, heading: string): string {
  const lines = [heading, ""];
  const line = (r: SessionRecord) => {
    const lap = r.id === "lap" || r.id === "speed" ? ` (lap ${r.best.lap})` : "";
    return `${LABELS[r.id]} - ${valueText(r.id, r.best.value)}${unit(r.id)} - ${nameOf(info, r.best.driver)}${lap}`;
  };
  const sectors = bests.records.filter((r) => r.id === "s1" || r.id === "s2" || r.id === "s3");
  const rest = bests.records.filter((r) => !sectors.includes(r));
  lines.push(...sectors.map(line));
  if (bests.ideal) lines.push(`Ideal lap - ${lapTime(bests.ideal.value)}`);
  if (rest.length) lines.push("", ...rest.map(line));
  return lines.join("\n");
}

function Who({ n, info }: { n: number; info: ReadonlyMap<number, DriverInfo> }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <DriverTag driver={info.get(n)} number={n} />
      <span className="truncate text-xs text-zinc-200">{nameOf(info, n)}</span>
    </span>
  );
}

function RecordRow({ r, info, narrow, onPick }: { r: SessionRecord; info: ReadonlyMap<number, DriverInfo>; narrow: boolean; onPick: (r: SessionRecord) => void }) {
  const { id, best, next } = r;
  const purple = isTimed(id);
  const tyre = best.compound ? `, ${best.compound.toLowerCase()}s${best.age != null ? ` ${best.age === 0 ? "from new" : `${best.age} laps old`}` : ""}` : "";
  const what = isPit(id) ? (id === "stop" ? "stationary" : "entry to exit") : `lap ${best.lap}${tyre}`;
  const behind = next ? ` Next: ${nameOf(info, next.driver)}, ${gapText(id, best, next)}${id === "speed" ? " km/h" : " s"}.` : "";
  const title = `${LABELS[id]} ${valueText(id, best.value)}${unit(id)}: ${nameOf(info, best.driver)}, ${isPit(id) ? `lap ${best.lap}, ` : ""}${what}.${behind} Click to watch it.`;
  return (
    <li className="border-b border-zinc-800/70">
      <button onClick={() => onPick(r)} title={title} className={`${narrow ? NARROW_COLS : COLS} h-7 w-full px-3 text-left hover:bg-zinc-900`}>
        <span className="truncate text-[11px] font-semibold uppercase tracking-wider text-zinc-400">{LABELS[id]}</span>
        <span className={`text-right text-xs font-semibold tabular-nums ${purple ? "text-fuchsia-400" : "text-zinc-50"}`}>
          {valueText(id, best.value)}
          {id === "speed" && <span className="text-[10px] font-normal text-zinc-400"> km/h</span>}
        </span>
        <Who n={best.driver} info={info} />
        <span className="flex items-center justify-end gap-1.5 text-[11px] tabular-nums text-zinc-400">
          L{best.lap}
          {!isPit(id) && best.compound && <TyreBadge compound={best.compound} size={16} />}
        </span>
        {!narrow && (
          <span className="truncate text-right text-[11px] tabular-nums text-zinc-400">
            {next ? (
              <>
                {gapText(id, best, next)} <span className="font-semibold text-zinc-300">{info.get(next.driver)?.acronym ?? `#${next.driver}`}</span>
              </>
            ) : (
              "—"
            )}
          </span>
        )}
      </button>
    </li>
  );
}

/** The fastest sectors added up: who set them, and how far under the fastest lap that is. */
function IdealRow({ ideal, info, narrow }: { ideal: IdealLap; info: ReadonlyMap<number, DriverInfo>; narrow: boolean }) {
  const one = ideal.drivers.every((n) => n === ideal.drivers[0]);
  const title =
    `Ideal lap ${lapTime(ideal.value)}: the fastest S1, S2 and S3 added up` +
    (ideal.under != null ? `, ${ideal.under.toFixed(3)} s under the fastest lap.` : ".");
  return (
    <li className={`${narrow ? NARROW_COLS : COLS} h-7 border-b border-zinc-800/70 px-3`} title={title}>
      <span className="truncate text-[11px] font-semibold uppercase tracking-wider text-zinc-400">Ideal</span>
      <span className="text-right text-xs font-semibold tabular-nums text-zinc-200">{lapTime(ideal.value)}</span>
      {one ? (
        <Who n={ideal.drivers[0]} info={info} />
      ) : (
        <span className="flex min-w-0 items-center gap-1">
          {ideal.drivers.map((n, k) => (
            <DriverTag key={k} driver={info.get(n)} number={n} title={`S${k + 1}`} />
          ))}
        </span>
      )}
      <span className={`${narrow ? "" : "col-span-2"} truncate text-right text-[11px] tabular-nums text-zinc-400`}>{ideal.under != null && ideal.under > 0.0005 ? `−${ideal.under.toFixed(3)} on the lap` : ""}</span>
    </li>
  );
}

/** The session's records so far: the fastest lap and sectors, the ideal lap, top speed and, in a race, the quickest stops. */
function SessionBests() {
  const drivers = useDrivers();
  const session = useSessionInfo();
  const laps = useAllLaps(toLaps);
  const stints = useAllStints(toStints);
  const pits = useAllPitStops(toPits);
  // Laps and stops are only added once done, so the rest of t only matters for deletions (practice, qualifying).
  const deletedBy = useTime((t) => lastDeletion(laps, t));
  const leaderLap = useLeaderLap();
  const totalLaps = useTotalLaps();
  const seek = usePlayback((p) => p.seek);
  const selected = useSelection((s) => s.selected);
  const toggle = useSelection((s) => s.toggle);
  const focus = useSelection((s) => s.focus);
  const { width } = useWidgetSize();
  const narrow = width < NARROW;
  const race = session.kind === "race";
  const info = useMemo(() => new Map<number, DriverInfo>(drivers.map((d) => [d.number, d])), [drivers]);

  const bests = useMemo(() => {
    const cars: CarInput[] = [...laps].map(([driver, l]) => ({ driver, laps: l, stints: stints.get(driver) ?? [], pits: pits.get(driver) ?? [] }));
    // Every lap and stop here is done by now; only deletions need the time.
    return sessionBests(cars, Infinity, race, deletedBy);
  }, [laps, stints, pits, deletedBy, race]);

  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(id);
  }, [copied]);

  const so = race && totalLaps > 0 && leaderLap < totalLaps ? ` (after lap ${leaderLap} of ${totalLaps})` : "";
  const heading = `Fastest in the ${session.year} ${session.meetingName}${race && session.sessionName === "Race" ? "" : ` ${session.sessionName}`}${so}`;
  const copy = () => {
    navigator.clipboard?.writeText(asText(bests, info, heading)).then(
      () => setCopied(true),
      () => {},
    );
  };

  // Watch the lap (or the car come in), with its driver focused; with drivers selected, it joins them.
  const onPick = (r: SessionRecord) => {
    const m: Mark = r.best;
    seek(isPit(r.id) ? m.at - LEAD_MS : m.at);
    if (selected.length > 0 && !selected.includes(m.driver)) toggle(m.driver);
    focus(m.driver);
  };

  const sectors = bests.records.filter((r) => r.id === "s1" || r.id === "s2" || r.id === "s3");
  const rest = bests.records.filter((r) => !sectors.includes(r));

  return (
    <section className="flex h-full flex-col text-sm">
      <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-1.5">
        <Label as="h2" className="shrink-0 whitespace-nowrap">
          Session bests
        </Label>
        <span className="truncate text-[11px] text-zinc-400" title="The best so far by anyone; sectors and laps in purple, as in the timing">
          {so ? `So far, lap ${leaderLap} of ${totalLaps}` : "The fastest by anyone, and the next best"}
        </span>
        <button
          data-shot-control=""
          onClick={copy}
          disabled={bests.records.length === 0}
          title="Copy the records as text, to paste into a post"
          className={`${TAP_CLASS} ml-auto shrink-0 rounded-md bg-zinc-900 px-2 text-[11px] leading-5 text-zinc-300 hover:text-white disabled:opacity-40`}
        >
          {copied ? "Copied" : "Copy text"}
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {bests.records.length === 0 && <p className="px-3 py-6 text-center text-xs text-zinc-400">No laps completed yet</p>}
        <ol>
          {sectors.map((r) => (
            <RecordRow key={r.id} r={r} info={info} narrow={narrow} onPick={onPick} />
          ))}
          {bests.ideal && <IdealRow ideal={bests.ideal} info={info} narrow={narrow} />}
          {rest.map((r) => (
            <RecordRow key={r.id} r={r} info={info} narrow={narrow} onPick={onPick} />
          ))}
        </ol>
      </div>
    </section>
  );
}

export default defineWidget({
  id: "session-bests",
  name: "Session bests",
  group: "analysis",
  description: "The fastest lap, the fastest S1, S2 and S3 and who set them, the ideal lap, top speed and the quickest pit stop, so far. Copies as text for a post.",
  version: "1.0.0",
  // The header and a row per record: three sectors, the ideal lap, the fastest lap, top speed, and in a race two pit records.
  height: { min: ({ info }) => HEADER_H + (info.kind === "race" ? 8 : 6) * ROW_H },
  width: { min: 18, default: 26, max: 50 },
  sessions: ["race", "practice", "qualifying"],
  settings: {},
  Component: SessionBests,
});
