import { memo, useMemo, type MouseEvent } from "react";
import {
  COMPOUND,
  defineWidget,
  DriverTag,
  Label,
  LABEL_CLASS,
  lapTime,
  useAllLaps,
  useAllStints,
  useDrivers,
  useNeutralPeriods,
  usePlayback,
  useSelection,
  useSessionInfo,
  useTime,
  type DriverInfo,
  type Lap,
  type NeutralPeriod,
  type StintView,
} from "widget-kit";
import { axisOf, byTeam, deletedBy, planRow, type LapKind, type PlanLap, type PlanRow } from "./plan";

/** Row height, the gap between teams, and the label and laps columns, in px. */
const ROW = 16;
const TEAM_GAP = 4;
const LABEL_W = 44;
const LAPS_W = 30;
/** The title bar (py-1.5, a 20 px line, its hairline) and the minutes axis. */
const HEADER = 33;
const AXIS = 16;

/** How strongly a lap's compound shows: push laps full, laps at pace half, the rest faint. */
const OPACITY: Record<LapKind, number> = { push: 1, pace: 0.5, slow: 0.2 };
/** Neutral periods as a faint band in the header's flag colours. */
const BAND: Record<NeutralPeriod["status"], string> = { RED: "rgb(239 68 68 / 0.14)", SC: "rgb(255 210 48 / 0.10)", VSC: "rgb(255 210 48 / 0.07)" };

const KIND_TEXT: Record<LapKind, string> = { push: "push lap", pace: "at pace", slow: "" };

/** "Lap 12 · 1:32.456 · soft, 3 laps old · push lap". */
function lapTitle(l: PlanLap, name: string): string {
  const tyre = l.age == null ? l.compound.toLowerCase() : `${l.compound.toLowerCase()}, ${l.age === 0 ? "new" : `${l.age} ${l.age === 1 ? "lap" : "laps"} old`}`;
  return [`${name} lap ${l.lap}`, l.duration != null && l.duration > 0 ? lapTime(l.duration) : "no time", tyre, l.why ?? KIND_TEXT[l.kind]].join(" · ");
}

const pct = (x: number) => `${x * 100}%`;

const Row = memo(function Row({
  row,
  info,
  from,
  span,
  focused,
  onPlot,
  onLabel,
}: {
  row: PlanRow;
  info: DriverInfo | undefined;
  from: number;
  span: number;
  focused: boolean;
  onPlot: (driver: number, e: MouseEvent<HTMLDivElement>) => void;
  onLabel: (driver: number) => void;
}) {
  const name = info?.acronym ?? `#${row.driver}`;
  return (
    <div className={`flex items-center ${focused ? "bg-zinc-100/5" : ""}`} style={{ height: ROW }}>
      <button onClick={() => onLabel(row.driver)} className="flex shrink-0 items-center pl-3" style={{ width: LABEL_W }} title={`Focus ${name}`}>
        <DriverTag number={row.driver} driver={info} />
      </button>
      <div className="relative h-full min-w-0 flex-1 cursor-pointer" onClick={(e) => onPlot(row.driver, e)}>
        {row.laps.map((l) => {
          const left = Math.max(0, (l.start - from) / span);
          const width = Math.max((Math.min(l.end, from + span) - Math.max(l.start, from)) / span, 0);
          if (width <= 0) return null;
          const c = (COMPOUND[l.compound] ?? COMPOUND.UNKNOWN).color;
          return (
            <div key={l.lap} data-start={l.start} className="absolute" style={{ left: pct(left), width: pct(width), top: 5, height: 9 }} title={lapTitle(l, name)}>
              {/* 1 px of ground between laps, so a run reads as laps. */}
              <span className="absolute inset-y-0 left-0 right-px" style={{ background: c, opacity: OPACITY[l.kind] }} />
              {l.kind === "push" && <span className="absolute left-1/2 size-[3px] -translate-x-1/2 rounded-full bg-zinc-50" style={{ top: -4 }} />}
            </div>
          );
        })}
      </div>
      <span className="shrink-0 pr-3 text-right text-[11px] tabular-nums text-zinc-400" style={{ width: LAPS_W }}>
        {row.laps.length}
      </span>
    </div>
  );
});

/** The playhead: replay time on the axis, in steps of a second. */
function Playhead({ from, span }: { from: number; span: number }) {
  const x = useTime((t) => Math.round((t - from) / 1000) * 1000 / span);
  if (x < 0 || x > 1) return null;
  return <div className="absolute inset-y-0 w-px bg-zinc-100" style={{ left: pct(x) }} />;
}

/** Laps the replay has seen deleted by now (track limits), as "driver:lap" keys: changes only when one is. */
const deletedKeys = (laps: ReadonlyMap<number, readonly Lap[]>, t: number) =>
  [...laps].flatMap(([n, own]) => own.filter((l) => deletedBy(l, t)).map((l) => `${n}:${l.lap}`)).join();

/** Every driver's practice programme on the session clock: laps by compound, push laps marked, teams together. */
function RunPlans() {
  const drivers = useDrivers();
  const laps = useAllLaps();
  const stints = useAllStints();
  const neutral = useNeutralPeriods();
  const deleted = useTime((t) => deletedKeys(laps, t));
  const { lightsOut, scheduledEnd } = useSessionInfo((i) => ({ lightsOut: i.lightsOut, scheduledEnd: i.scheduledEnd }));
  const selected = useSelection((s) => s.selected);
  const focused = useSelection((s) => s.focused);
  const focus = useSelection((s) => s.focus);
  const toggle = useSelection((s) => s.toggle);
  const seek = usePlayback((p) => p.seek);
  const info = useMemo(() => new Map<number, DriverInfo>(drivers.map((d) => [d.number, d])), [drivers]);

  const { teams, axis } = useMemo(() => {
    const gone = new Set(deleted ? deleted.split(",") : []);
    const rows = drivers.map((d) =>
      planRow(
        d.number,
        (laps.get(d.number) ?? []).map((l) => ({ lap: l.lap, start: l.start, end: l.end, duration: l.duration, pitOut: l.pitOut, deleted: gone.has(`${d.number}:${l.lap}`) })),
        (stints.get(d.number) ?? []).map((s: StintView) => ({ lapStart: s.lapStart, compound: s.compound, ageAtStart: s.ageAtStart })),
        neutral,
      ),
    );
    return { teams: byTeam(rows, (n) => info.get(n)?.team ?? `#${n}`), axis: axisOf(lightsOut, scheduledEnd, rows) };
  }, [drivers, laps, stints, neutral, deleted, info, lightsOut, scheduledEnd]);

  const span = axis.to - axis.from;

  // Focus the driver; with drivers selected, they join them (as long runs does), so other widgets show them too.
  const onLabel = (n: number) => {
    if (selected.length > 0 && !selected.includes(n)) toggle(n);
    focus(n);
  };
  // A lap: watch it from its start. Elsewhere in the row (the garage): that moment.
  const onPlot = (n: number, e: MouseEvent<HTMLDivElement>) => {
    const lap = (e.target as HTMLElement).closest<HTMLElement>("[data-start]");
    const box = e.currentTarget.getBoundingClientRect();
    const at = lap ? Number(lap.dataset.start) : axis.from + Math.min(Math.max((e.clientX - box.left) / box.width, 0), 1) * span;
    seek(at);
    onLabel(n);
  };

  const pushes = teams.flat().reduce((a, r) => a + r.laps.filter((l) => l.kind === "push").length, 0);

  return (
    <section className="flex h-full flex-col text-sm">
      <div className="flex items-center gap-3 border-b border-zinc-800 px-3 py-1.5">
        <Label as="h2" className="shrink-0 whitespace-nowrap">
          Run plans
        </Label>
        <span className="truncate text-[11px] text-zinc-400">
          {pushes} push {pushes === 1 ? "lap" : "laps"}
        </span>
        {/* The key: how strongly a lap shows, in a neutral grey (the colour is the compound). */}
        <span className="ml-auto flex shrink-0 items-center gap-2.5 text-[11px] text-zinc-400">
          {(["push", "pace", "slow"] as const).map((k) => (
            <span key={k} className="flex items-center gap-1">
              <span className="relative inline-block h-[9px] w-3">
                <span className="absolute inset-0 bg-zinc-200" style={{ opacity: OPACITY[k] }} />
                {k === "push" && <span className="absolute left-1/2 size-[3px] -translate-x-1/2 rounded-full bg-zinc-50" style={{ top: -4 }} />}
              </span>
              {k === "push" ? "Push" : k === "pace" ? "At pace" : "Out, in, slow"}
            </span>
          ))}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="relative pb-1">
          {/* Gridlines, neutral periods and the playhead span every row; they sit over the plot column only. */}
          <div className="pointer-events-none absolute inset-y-0" style={{ left: LABEL_W, right: LAPS_W }}>
            {axis.ticks.map((m) => (
              <div key={m} className="absolute inset-y-0 w-px bg-zinc-800/70" style={{ left: pct((m * 60_000) / span) }} />
            ))}
            {neutral.map((p) => {
              const left = Math.max(0, (p.start - axis.from) / span);
              const right = Math.min(1, ((p.end ?? axis.to) - axis.from) / span);
              return right > left ? <div key={p.start} className="absolute inset-y-0" style={{ left: pct(left), width: pct(right - left), background: BAND[p.status] }} /> : null;
            })}
          </div>

          {/* The minutes axis. */}
          <div className="sticky top-0 z-10 flex bg-zinc-950/90" style={{ height: AXIS }}>
            <span className={`shrink-0 pl-3 leading-4 ${LABEL_CLASS}`} style={{ width: LABEL_W }}>
              Min
            </span>
            <div className="relative flex-1">
              {axis.ticks.map((m, i) => (
                <span
                  key={m}
                  className={`absolute top-0 text-[10px] leading-4 tabular-nums text-zinc-400 ${i === 0 ? "" : i === axis.ticks.length - 1 && (m * 60_000) / span > 0.97 ? "-translate-x-full" : "-translate-x-1/2"}`}
                  style={{ left: pct((m * 60_000) / span) }}
                >
                  {m}
                </span>
              ))}
            </div>
            <span className={`shrink-0 pr-3 text-right leading-4 ${LABEL_CLASS}`} style={{ width: LAPS_W }} title="Laps run">
              Laps
            </span>
          </div>

          {teams.map((team) => (
            <div key={team[0].driver} style={{ paddingTop: TEAM_GAP }}>
              {team.map((row) => (
                <Row key={row.driver} row={row} info={info.get(row.driver)} from={axis.from} span={span} focused={focused === row.driver} onPlot={onPlot} onLabel={onLabel} />
              ))}
            </div>
          ))}

          <div className="pointer-events-none absolute inset-y-0" style={{ left: LABEL_W, right: LAPS_W }}>
            <Playhead from={axis.from} span={span} />
          </div>
        </div>
      </div>
    </section>
  );
}

export default defineWidget({
  id: "run-plans",
  name: "Run plans",
  group: "analysis",
  description: "Each team's practice programme on the session clock: every lap by compound, push laps marked, red flags shaded.",
  version: "1.0.0",
  // Every driver's row fits at the least; it fills its column and scrolls inside if shorter.
  height: { min: ({ drivers }) => HEADER + AXIS + drivers.length * ROW + new Set(drivers.map((d) => d.team)).size * TEAM_GAP + 4 },
  width: { min: 30, default: 50, max: 100 },
  sessions: ["practice"],
  settings: {},
  Component: RunPlans,
});
