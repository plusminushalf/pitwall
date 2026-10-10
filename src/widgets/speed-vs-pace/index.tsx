import { useMemo } from "react";
import {
  defineWidget,
  Label,
  lapTime,
  shortTeam,
  TAP_CLASS,
  teamColor,
  TyreBadge,
  useAllLaps,
  useAllStints,
  useCardState,
  useDrivers,
  useNeutralPeriods,
  usePlayback,
  useSelection,
  useSettings,
  useTime,
  useWidgetSize,
  type DriverInfo,
  type Lap,
  type StintView,
} from "widget-kit";
import { dots, median, placeLabels, PUSH, TOP_N, validLaps, type Dot, type Entry, type Side, type SpeedLap, type SpeedStint } from "./speed";

type By = "driver" | "team";
type Settings = { by: By };

/** The header line (py-1.5 around a 20 px control) and the one-line note under the chart. */
const HEAD_H = 33;
const FOOT_H = 25;
/** Px along the plot's top and bottom kept for the quadrant captions. */
const CAPTION_BAND = 18;
/** Seconds: slower than this to the fastest lap, a dot is drawn at it (its tooltip has the real gap). */
const GAP_CAP = 3;
/** Room for the gap labels and the rotated axis title (left), the speeds and their title (bottom). */
const M = { left: 52, right: 14, top: 10, bottom: 32 };
const DOT_R = 5;
const HIT_R = 12;
const LABEL_H = 11;
const SURFACE = "#09090b";
const GRID = "#27272a";
const AXIS = "#3f3f46";
const MEDIAN = "#71717b";
const TICK_TEXT = "#9f9fa9";
const LABEL_TEXT = "#e4e4e7";
const RING = "#f4f4f5";
const FONT = "ui-sans-serif, system-ui, sans-serif";
/** A label's width, near enough: 10 px semibold figures and capitals. */
const labelWidth = (text: string) => text.length * 6.4;

const pct = Math.round((PUSH - 1) * 1000) / 10;
const NOTE =
  `Top speed: the speed trap on push laps (within ${pct}% of the best), the median of the top ${TOP_N} so one tow doesn't count. ` +
  "Gap: best lap that counts (no deleted laps, none under a VSC, safety car or red flag). Fuel loads aren't known.";

/** The smallest step from `steps` that puts at least `minPx` between ticks. */
const tickStep = (span: number, px: number, minPx: number, steps: readonly number[]) => steps.find((s) => (s / span) * px >= minPx) ?? steps.at(-1)!;
const ticks = (lo: number, hi: number, step: number) => {
  const out: number[] = [];
  for (let v = Math.ceil(lo / step - 1e-9) * step; v <= hi + 1e-9; v += step) out.push(Math.round(v * 1000) / 1000);
  return out;
};

const slimLaps = (laps: readonly Lap[], deleted: ReadonlySet<string>, n: number): SpeedLap[] =>
  laps.map((l) => ({ lap: l.lap, start: l.start, end: l.end, duration: l.duration, pitOut: l.pitOut, st: l.speedTrap.st, i2: l.speedTrap.i2, deleted: deleted.has(`${n}:${l.lap}`) }));
const slimStints = (stints: readonly StintView[]): SpeedStint[] => stints.map((s) => ({ lapStart: s.lapStart, compound: s.compound, ageAtStart: s.ageAtStart }));

const compoundName = (c: string) => c.charAt(0) + c.slice(1).toLowerCase();

interface Placed {
  dot: Dot;
  x: number;
  y: number;
  label: string;
  color: string;
  /** The second car of a team (drivers): hollow, teammates share a colour. */
  hollow: boolean;
  side: Side;
}

function Tooltip({ p, by, info, w }: { p: Placed; by: By; info: DriverInfo | undefined; w: number }) {
  const { dot } = p;
  const flip = p.x > w * 0.6;
  const left = p.x;
  return (
    <div
      className="pointer-events-none absolute z-10 whitespace-nowrap rounded-md bg-zinc-900 px-2 py-1.5 text-xs shadow-lg ring-1 ring-zinc-800"
      style={{ top: p.y, left: flip ? undefined : left + 14, right: flip ? w - left + 14 : undefined, transform: "translateY(-50%)" }}
    >
      <div className="flex items-center gap-1.5">
        <span className="inline-block h-0.5 w-2.5 rounded-full" style={{ background: p.color }} />
        <span className="font-semibold text-zinc-50">{p.label}</span>
        {by === "team" && info && <span className="text-zinc-400">best lap {info.acronym}</span>}
      </div>
      <div className="tabular-nums text-zinc-200">
        <span className="font-semibold">{Math.round(dot.speed)} km/h</span>{" "}
        <span className="text-zinc-400">
          {dot.method === "median" ? `median of the top ${TOP_N} of ${dot.readings} push-lap traps` : `highest of ${dot.readings} push-lap ${dot.readings === 1 ? "trap" : "traps"}`}
        </span>
      </div>
      <div className="flex items-center gap-1.5 tabular-nums text-zinc-200">
        <span className="font-semibold">{lapTime(dot.best.time)}</span>
        <span className="text-zinc-400">{dot.gap === 0 ? "fastest" : `+${dot.gap.toFixed(3)}`}</span>
        <span className="text-zinc-400">lap {dot.best.lap}</span>
        <TyreBadge compound={dot.best.compound} size={12} />
        <span className="text-zinc-400">{dot.best.age == null ? compoundName(dot.best.compound) : `${dot.best.age} ${dot.best.age === 1 ? "lap" : "laps"} old`}</span>
      </div>
      <div className="text-zinc-400">Click to watch this lap</div>
    </div>
  );
}

/** Top speed against best lap: drag level and where each car finds its lap time. */
function SpeedVsPace() {
  const drivers = useDrivers();
  const laps = useAllLaps();
  const stints = useAllStints();
  const neutral = useNeutralPeriods();
  const seek = usePlayback((p) => p.seek);
  const selected = useSelection((s) => s.selected);
  const focused = useSelection((s) => s.focused);
  const focus = useSelection((s) => s.focus);
  const toggle = useSelection((s) => s.toggle);
  const [{ by }, update] = useSettings<Settings>();
  const size = useWidgetSize();
  const [hover, setHover] = useCardState<string | null>("hover", null);

  // Laps race control has deleted by now (practice, qualifying), as "driver:lap": a re-render when one goes, not at 10 Hz.
  const deletions = useMemo(() => [...laps].flatMap(([n, own]) => own.flatMap((l) => (l.deleted ? [{ key: `${n}:${l.lap}`, t: l.deleted.t }] : []))), [laps]);
  const deletedKey = useTime((t) => deletions.filter((d) => t >= d.t).map((d) => d.key).join());
  const deleted = useMemo(() => new Set(deletedKey ? deletedKey.split(",") : []), [deletedKey]);

  const info = useMemo(() => new Map<number, DriverInfo>(drivers.map((d) => [d.number, d])), [drivers]);
  const all = useMemo(() => {
    const valid = new Map([...laps].map(([n, own]) => [n, validLaps(slimLaps(own, deleted, n), slimStints(stints.get(n) ?? []), neutral)]));
    const entries: Entry[] =
      by === "driver"
        ? [...valid].map(([n, v]) => ({ key: String(n), drivers: [{ driver: n, valid: v }] }))
        : [...new Set(drivers.map((d) => d.team))].map((team) => ({
            key: team,
            drivers: drivers.filter((d) => d.team === team).map((d) => ({ driver: d.number, valid: valid.get(d.number) ?? [] })),
          }));
    return dots(entries);
  }, [laps, stints, neutral, deleted, by, drivers]);

  const w = size.width;
  const h = Math.max(0, size.height - HEAD_H - FOOT_H);
  const plotL = M.left;
  const plotR = w - M.right;
  const plotT = M.top;
  const plotB = h - M.bottom;
  const plotW = plotR - plotL;
  const plotH = plotB - plotT;

  const chart = useMemo(() => {
    if (all.length === 0 || plotW <= 40 || plotH <= 40) return null;
    const speeds = all.map((d) => d.speed);
    const gaps = all.map((d) => d.gap);
    let xLo = Math.min(...speeds);
    let xHi = Math.max(...speeds);
    const xPad = Math.max((xHi - xLo) * 0.08, 2);
    xLo -= xPad;
    xHi += xPad;
    // A car seconds off (a problem, a slow programme) would squash the field: gaps past GAP_CAP sit on the bottom edge.
    const top = Math.min(Math.max(...gaps), GAP_CAP);
    const yHi = top + Math.max(top * 0.08, 0.1);
    const yLo = -Math.max(yHi * 0.04, 0.03);
    const xOf = (v: number) => plotL + ((v - xLo) / (xHi - xLo)) * plotW;
    // Fastest at the top.
    // (No dot in the CAPTION_BAND along the top and bottom: the quadrants' captions are there.)
    const yOf = (g: number) => plotT + CAPTION_BAND + ((Math.min(g, top) - yLo) / (yHi - yLo)) * (plotH - 2 * CAPTION_BAND);

    const order = new Map(drivers.map((d, i) => [d.number, i]));
    const placed = [...all]
      .sort((a, b) => a.gap - b.gap)
      .map((dot): Omit<Placed, "side"> => {
        const d = info.get(dot.driver);
        const label = by === "team" ? shortTeam(dot.key) : (d?.acronym ?? `#${dot.driver}`);
        // Hollow: a teammate earlier in the session's order (drivers only).
        const hollow = by === "driver" && d != null && drivers.some((o) => o.team === d.team && o.number !== d.number && order.get(o.number)! < order.get(d.number)!);
        return { dot, x: xOf(dot.speed), y: yOf(dot.gap), label, color: d ? teamColor(d.teamColour) : AXIS, hollow };
      });
    // Kept off the gap labels on the left; they may run into the margin on the right.
    const sides = placeLabels(
      placed.map((p) => ({ x: p.x - plotL, y: p.y, w: labelWidth(p.label) })),
      w - plotL,
      LABEL_H,
      DOT_R + 3,
      DOT_R,
    );
    const yStep = tickStep(yHi - yLo, plotH, 26, [0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 5]);
    return {
      dots: placed.map((p, i): Placed => ({ ...p, side: sides[i] })),
      xTicks: ticks(xLo, xHi, tickStep(xHi - xLo, plotW, 44, [1, 2, 5, 10, 20, 50])),
      yTicks: ticks(0, yHi, yStep),
      yDecimals: yStep >= 1 ? 0 : yStep < 0.1 || yStep === 0.25 ? 2 : 1,
      xOf,
      yOf,
      mx: xOf(median(speeds)),
      my: yOf(median(gaps)),
      medianSpeed: median(speeds),
      medianGap: median(gaps),
    };
  }, [all, by, info, drivers, w, plotW, plotH]);

  // Watch the best lap from its start, its driver focused; with drivers selected, it joins them.
  const onPick = (dot: Dot) => {
    seek(dot.best.start);
    if (selected.length > 0 && !selected.includes(dot.driver)) toggle(dot.driver);
    focus(dot.driver);
  };

  const hovered = chart?.dots.find((p) => p.dot.key === hover) ?? null;
  const textAt = (p: Placed) => {
    const off = DOT_R + 3;
    if (p.side === "right") return { x: p.x + off, y: p.y, anchor: "start" as const };
    if (p.side === "left") return { x: p.x - off, y: p.y, anchor: "end" as const };
    return { x: p.x, y: p.side === "above" ? p.y - DOT_R - 2 - LABEL_H / 2 : p.y + DOT_R + 2 + LABEL_H / 2, anchor: "middle" as const };
  };

  return (
    <section className="relative flex h-full flex-col text-sm">
      <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-1.5" style={{ height: HEAD_H }}>
        <Label as="h2" className="shrink-0 whitespace-nowrap">
          Speed vs lap time
        </Label>
        <span className="truncate text-[11px] text-zinc-400">{by === "team" ? "by team" : "by driver"} · top speed, gap to the fastest lap</span>
        <div data-shot-control="" className="ml-auto flex shrink-0 rounded-md bg-zinc-900 p-0.5">
          {(["driver", "team"] as const).map((v) => (
            <button
              key={v}
              onClick={() => update({ by: v })}
              aria-pressed={by === v}
              className={`${TAP_CLASS} rounded px-2 text-[11px] leading-5 ${by === v ? "bg-zinc-700 text-zinc-50" : "text-zinc-300 hover:text-white"}`}
              title={v === "driver" ? "A dot per driver" : "A dot per team: both cars' push laps, the team's best lap"}
            >
              {v === "driver" ? "Drivers" : "Teams"}
            </button>
          ))}
        </div>
      </div>

      <div className="relative min-h-0 flex-1">
        {!chart ? (
          <p className="px-3 py-6 text-center text-xs text-zinc-400">No laps that count yet</p>
        ) : (
          <svg data-shot-fill="" width={w} height={h} className="block" role="img" aria-label="Top speed against gap to the fastest lap, a dot per driver" style={{ fontFamily: FONT }}>
            {/* Grid and axes. */}
            {chart.yTicks.map((v) => (
              <g key={`y${v}`}>
                <line x1={plotL} x2={plotR} y1={Math.round(chart.yOf(v)) + 0.5} y2={Math.round(chart.yOf(v)) + 0.5} stroke={GRID} />
                <text x={plotL - 6} y={chart.yOf(v)} fill={TICK_TEXT} fontSize={10} textAnchor="end" dominantBaseline="middle" className="tabular-nums">
                  {v === 0 ? "0" : `+${v.toFixed(chart.yDecimals)}`}
                </text>
              </g>
            ))}
            {chart.xTicks.map((v) => (
              <g key={`x${v}`}>
                <line x1={Math.round(chart.xOf(v)) + 0.5} x2={Math.round(chart.xOf(v)) + 0.5} y1={plotT} y2={plotB} stroke={GRID} />
                <text x={chart.xOf(v)} y={plotB + 13} fill={TICK_TEXT} fontSize={10} textAnchor="middle" className="tabular-nums">
                  {v}
                </text>
              </g>
            ))}
            <line x1={plotL} x2={plotR} y1={Math.round(plotB) + 0.5} y2={Math.round(plotB) + 0.5} stroke={AXIS} />
            <text x={(plotL + plotR) / 2} y={plotB + 27} fill={TICK_TEXT} fontSize={10} textAnchor="middle">
              Top speed (km/h) →
            </text>
            <text x={12} y={(plotT + plotB) / 2} fill={TICK_TEXT} fontSize={10} textAnchor="middle" transform={`rotate(-90 12 ${(plotT + plotB) / 2})`}>
              ← Gap to the fastest lap (s)
            </text>

            {/* The medians, splitting it into quadrants. */}
            <g stroke={MEDIAN} strokeDasharray="4 3">
              <line x1={chart.mx} x2={chart.mx} y1={plotT} y2={plotB}>
                <title>{`Median top speed: ${Math.round(chart.medianSpeed)} km/h`}</title>
              </line>
              <line x1={plotL} x2={plotR} y1={chart.my} y2={chart.my}>
                <title>{`Median gap: +${chart.medianGap.toFixed(3)} s`}</title>
              </line>
            </g>
            <g fill={TICK_TEXT} fontSize={11} pointerEvents="none">
              <text x={plotL + 6} y={plotT + 12}>
                Quick in the corners
              </text>
              <text x={plotR - 6} y={plotT + 12} textAnchor="end">
                Quick everywhere
              </text>
              <text x={plotL + 6} y={plotB - 6}>
                Off the pace
              </text>
              <text x={plotR - 6} y={plotB - 6} textAnchor="end">
                Quick on the straights
              </text>
            </g>

            {/* Dots, then labels on top of every dot. */}
            {chart.dots.map((p) => (
              <g key={p.dot.key} className="cursor-pointer" onClick={() => onPick(p.dot)} onPointerEnter={() => setHover(p.dot.key)} onPointerLeave={() => setHover(null)}>
                <circle cx={p.x} cy={p.y} r={HIT_R} fill="transparent" />
                <circle cx={p.x} cy={p.y} r={DOT_R + 1.5} fill={SURFACE} />
                {p.hollow ? <circle cx={p.x} cy={p.y} r={DOT_R - 0.75} fill={SURFACE} stroke={p.color} strokeWidth={1.75} /> : <circle cx={p.x} cy={p.y} r={DOT_R} fill={p.color} />}
                {(hover === p.dot.key || (by === "driver" && focused === p.dot.driver)) && <circle cx={p.x} cy={p.y} r={DOT_R + 3} fill="none" stroke={RING} strokeWidth={1.5} />}
              </g>
            ))}
            <g fontSize={10} fontWeight={600} fill={LABEL_TEXT} pointerEvents="none">
              {chart.dots.map((p) => {
                const at = textAt(p);
                return (
                  <text key={p.dot.key} x={at.x} y={at.y} textAnchor={at.anchor} dominantBaseline="central" stroke={SURFACE} strokeWidth={3} paintOrder="stroke">
                    {p.label}
                  </text>
                );
              })}
            </g>
          </svg>
        )}
        {hovered && <Tooltip p={hovered} by={by} info={info.get(hovered.dot.driver)} w={w} />}
      </div>

      <p className="truncate border-t border-zinc-800 px-3 text-[11px] leading-6 text-zinc-400" style={{ height: FOOT_H }} title={NOTE}>
        {NOTE}
      </p>
    </section>
  );
}

export default defineWidget({
  id: "speed-vs-pace",
  name: "Speed vs lap time",
  group: "analysis",
  description: "Each car's top speed on its push laps against its best lap. Drag level and where the lap time comes from.",
  version: "1.0.0",
  // Fills its column: a taller chart spreads the field out.
  height: { min: 260 },
  width: { min: 24, default: 34, max: 60 },
  sessions: ["race", "practice", "qualifying"],
  settings: { by: "driver" as By },
  fields: {
    by: {
      kind: "choice",
      label: "A dot per",
      options: [
        { value: "driver", label: "Driver" },
        { value: "team", label: "Team" },
      ],
    },
  },
  Component: SpeedVsPace,
});
