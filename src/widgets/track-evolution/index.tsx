import { useMemo } from "react";
import {
  COMPOUND,
  defineWidget,
  Label,
  lapTime,
  useAllLaps,
  useAllStints,
  useDrivers,
  useNeutralPeriods,
  usePlayback,
  useSelection,
  useSessionInfo,
  useTime,
  useWholeSession,
  useWidgetSize,
  type DriverInfo,
  type NeutralPeriod,
} from "widget-kit";
import { CLIP, evolution, gainOf, gainText, minutes, trackTempAt, WINDOW_MS, type EvoPoint, type Evolution } from "./evolution";

const SURFACE = "#09090b";
const GRID = "#27272a";
const AXIS = "#3f3f46";
const TICK_TEXT = "#9f9fa9";
const NOW_LINE = "#f4f4f5";
/** The fastest lap so far: fuchsia, the app's colour for fastest. */
const FASTEST = "#ed6bff";
const MEDIAN = "#e4e4e7";
const BAND: Record<NeutralPeriod["status"], string> = {
  RED: "rgba(231, 0, 11, 0.12)",
  SC: "rgba(255, 210, 48, 0.10)",
  VSC: "rgba(255, 210, 48, 0.06)",
};
/** The header line. */
const HEAD_H = 28;
/** Room for the lap times (left) and the minutes (bottom). */
const M = { left: 44, right: 14, top: 8, bottom: 18 };
/** Under this width the key leaves the header for a row of its own under it (a share card is 480 wide). */
const KEY_MIN_W = 620;
const KEY_ROW_H = 24;
const HOUR = 60 * 60_000;

const compoundColor = (c: string) => (COMPOUND[c] ?? COMPOUND.UNKNOWN).color;
const compoundName = (c: string) => c.charAt(0) + c.slice(1).toLowerCase();

/** The smallest step from `steps` that puts at least `minPx` between ticks. */
const tickStep = (span: number, px: number, minPx: number, steps: readonly number[]) => steps.find((s) => (s / span) * px >= minPx) ?? steps.at(-1)!;

/** 92.5 -> "1:32.5" (decimals 1) or "1:32" (decimals 0). */
function tickTime(seconds: number, decimals: number): string {
  const m = Math.floor(seconds / 60);
  const s = (seconds - m * 60).toFixed(decimals).padStart(decimals ? 3 + decimals : 2, "0");
  return m > 0 ? `${m}:${s}` : s;
}

/** Session time (ms since t0) and lap time (s) to px, fast at the top. */
interface Scale {
  x0: number;
  x1: number;
  lo: number;
  hi: number;
  plotL: number;
  plotR: number;
  plotT: number;
  plotB: number;
}
const xOf = (s: Scale, ms: number) => s.plotL + ((ms - s.x0) / (s.x1 - s.x0)) * (s.plotR - s.plotL);
const yOf = (s: Scale, time: number) => s.plotT + ((time - s.lo) / (s.hi - s.lo)) * (s.plotB - s.plotT);

/** The valid laps as dots: the rest small and faint under the push laps. Each one seeks to its lap when clicked. */
function Dots({ points, scale, info, onPick }: { points: EvoPoint[]; scale: Scale; info: Map<number, DriverInfo>; onPick: (p: EvoPoint) => void }) {
  const ordered = [...points.filter((p) => !p.push), ...points.filter((p) => p.push)];
  return (
    <g>
      {ordered.map((p) => {
        const name = info.get(p.driver)?.acronym ?? `#${p.driver}`;
        return (
          <circle
            key={`${p.driver}:${p.lap}`}
            cx={xOf(scale, p.end)}
            cy={yOf(scale, p.time)}
            r={p.push ? 3.5 : 2}
            fill={compoundColor(p.compound)}
            fillOpacity={p.push ? 1 : 0.35}
            // The push laps ringed in the ground colour; the rest get a wider, unseen edge to click.
            stroke={p.push ? SURFACE : "transparent"}
            strokeWidth={p.push ? 1.5 : 6}
            className="cursor-pointer"
            onClick={() => onPick(p)}
          >
            <title>
              {`${name} ${lapTime(p.time)}, lap ${p.lap}${p.push ? " (push lap)" : ""}\n${compoundName(p.compound)}, ${p.age} ${p.age === 1 ? "lap" : "laps"} old\nClick to watch it`}
            </title>
          </circle>
        );
      })}
    </g>
  );
}

/** The key, for a picture of the chart. */
function Key() {
  return (
    <span className="flex shrink-0 items-center gap-3 text-[11px] text-zinc-400">
      <span className="flex items-center gap-1">
        <svg width="16" height="8" aria-hidden>
          <circle cx="3" cy="4" r="2" fill={TICK_TEXT} fillOpacity={0.5} />
          <circle cx="11" cy="4" r="3.5" fill={TICK_TEXT} />
        </svg>
        lap · push lap
      </span>
      <span className="flex items-center gap-1">
        <svg width="14" height="8" aria-hidden>
          <path d="M0 6.5H6V1.5H14" fill="none" stroke={FASTEST} strokeWidth="1.5" />
        </svg>
        fastest so far
      </span>
      <span className="flex items-center gap-1">
        <svg width="16" height="8" aria-hidden>
          <path d="M0 6L16 2" stroke={MEDIAN} strokeWidth="2" />
          <circle cx="8" cy="4" r="2.5" fill={SURFACE} stroke={MEDIAN} strokeWidth="1.5" />
        </svg>
        10-min push-lap median
      </span>
    </span>
  );
}

/** Every valid lap of the session so far by session time, with the fastest lap so far and the push-lap median. */
function TrackEvolution() {
  const drivers = useDrivers();
  const laps = useAllLaps();
  const stints = useAllStints();
  const neutral = useNeutralPeriods();
  const { lightsOut: green, scheduledEnd } = useSessionInfo();
  const weather = useWholeSession((s) => s.meta.weather);
  const seek = usePlayback((p) => p.seek);
  const selected = useSelection((s) => s.selected);
  const focus = useSelection((s) => s.focus);
  const toggle = useSelection((s) => s.toggle);
  const size = useWidgetSize();
  // To the second: the playhead and a running red flag's band.
  const t = useTime((x) => Math.floor(x / 1000) * 1000);
  const info = useMemo(() => new Map<number, DriverInfo>(drivers.map((d) => [d.number, d])), [drivers]);

  // A lap race control deletes counts until then: the model is rebuilt when t passes a deletion, not every second.
  // (Cut at the latest deletion by t, it's the same as at t.)
  const deletions = useMemo(() => [...laps.values()].flatMap((own) => own.flatMap((l) => (l.deleted ? [l.deleted.t] : []))).sort((a, b) => a - b), [laps]);
  const passed = deletions.filter((d) => d <= t);
  const cut = passed.at(-1) ?? -Infinity;
  const model: Evolution = useMemo(() => evolution(laps, stints, neutral, cut, green), [laps, stints, neutral, cut, green]);

  const w = size.width;
  const keyRow = w < KEY_MIN_W;
  const h = size.height - HEAD_H - (keyRow ? KEY_ROW_H : 0);
  const fastest = model.records.at(-1)?.time ?? null;
  const shown = useMemo(() => (fastest == null ? [] : model.points.filter((p) => p.time <= CLIP * fastest)), [model, fastest]);

  const scale = useMemo((): Scale | null => {
    if (fastest == null || shown.length === 0) return null;
    const slowest = Math.max(...shown.map((p) => p.time));
    const pad = Math.max((slowest - fastest) * 0.06, 0.1);
    const end = Math.max(scheduledEnd ?? green + HOUR, ...shown.map((p) => p.end));
    return { x0: green, x1: end, lo: fastest - pad, hi: slowest + pad, plotL: M.left, plotR: w - M.right, plotT: M.top, plotB: h - M.bottom };
  }, [fastest, shown, scheduledEnd, green, w, h]);

  // Watch the lap from its start, with its driver focused; with drivers selected, it joins them (as long runs does).
  const onPick = (p: EvoPoint) => {
    seek(p.start);
    if (selected.length > 0 && !selected.includes(p.driver)) toggle(p.driver);
    focus(p.driver);
  };
  // The dots only change with the laps and the size, not each second.
  const dots = useMemo(() => (scale ? <Dots points={shown} scale={scale} info={info} onPick={onPick} /> : null), [shown, scale, info, selected]);

  // The caption: the gain from the first window with push laps to the latest that's run, and the track temperature then and now.
  const gain = gainOf(model.windows, t, scheduledEnd);
  const samples = useMemo(() => weather.filter((s) => s.t <= t), [weather, t]);
  const tempNow = trackTempAt(samples, t);
  const tempThen = gain ? trackTempAt(samples, gain.first.from) : null;
  const temp =
    tempNow == null ? null : tempThen != null && Math.round(tempThen) !== Math.round(tempNow) ? `track ${Math.round(tempThen)}° → ${Math.round(tempNow)}°C` : `track ${Math.round(tempNow)}°C`;
  const span = (win: { from: number; to: number }) => `${minutes(win.from, green)}–${minutes(win.to, green)} min`;
  const gainTitle = gain
    ? `Median push lap, ${span(gain.first)}: ${lapTime(gain.first.median)} (${gain.first.laps} laps); ${span(gain.last)}: ${lapTime(gain.last.median)} (${gain.last.laps} laps). Push laps: within 1.5% of the driver's best so far. Compounds and fuel loads are mixed in.`
    : undefined;

  return (
    <section className="flex h-full flex-col text-sm">
      <div className="flex items-center gap-2 overflow-hidden border-b border-zinc-800 px-3" style={{ height: HEAD_H }}>
        <Label as="h2" className="shrink-0 whitespace-nowrap">
          Track evolution
        </Label>
        <span className="min-w-0 truncate text-[11px] text-zinc-300" title={gainTitle}>
          {gain ? gainText(gain.gain) : model.points.length > 0 ? "push-lap trend after two 10-minute windows" : ""}
          {temp && <span className="text-zinc-400"> · {temp}</span>}
        </span>
        {!keyRow && (
          <span className="ml-auto">
            <Key />
          </span>
        )}
      </div>
      {keyRow && (
        <div className="flex items-center overflow-hidden px-3" style={{ height: KEY_ROW_H }}>
          <Key />
        </div>
      )}
      <div className="relative min-h-0 flex-1">
        {scale && h > 40 ? (
          <svg data-shot-fill="" width={w} height={h} role="img" aria-label="Every valid lap by session time, with the fastest lap so far and the 10-minute median of push laps" className="block">
            <Frame scale={scale} neutral={neutral} t={t} />
            {dots}
            <Lines model={model} scale={scale} t={t} />
            {t >= scale.x0 && t <= scale.x1 && <line x1={xOf(scale, t)} x2={xOf(scale, t)} y1={scale.plotT} y2={scale.plotB} stroke={NOW_LINE} strokeOpacity={0.7} strokeWidth={1} />}
          </svg>
        ) : (
          <p className="flex h-full items-center justify-center text-xs text-zinc-400">No valid laps yet</p>
        )}
      </div>
    </section>
  );
}

/** Grid, axes and the neutral periods' bands. */
function Frame({ scale, neutral, t }: { scale: Scale; neutral: readonly NeutralPeriod[]; t: number }) {
  const { lo, hi, plotL, plotR, plotT, plotB, x0, x1 } = scale;
  const yStep = tickStep(hi - lo, plotB - plotT, 24, [0.1, 0.2, 0.5, 1, 2, 5, 10]);
  const decimals = yStep < 1 ? 1 : 0;
  const yTicks: number[] = [];
  for (let v = Math.ceil(lo / yStep) * yStep; v <= hi; v += yStep) yTicks.push(v);
  const xTicks: number[] = [];
  for (let m = x0; m <= x1; m += WINDOW_MS) xTicks.push(m);
  return (
    <g fontSize={10} fontFamily="ui-sans-serif, system-ui, sans-serif">
      {neutral.map((p) => {
        const a = xOf(scale, Math.max(p.start, x0));
        const b = xOf(scale, Math.min(p.end ?? t, x1));
        return b > a ? (
          <g key={`${p.status}:${p.start}`}>
            <rect x={a} y={plotT} width={b - a} height={plotB - plotT} fill={BAND[p.status]} />
            <text x={a + 3} y={plotT + 9} fill={TICK_TEXT}>
              {p.status}
            </text>
          </g>
        ) : null;
      })}
      {yTicks.map((v) => (
        <g key={v}>
          <line x1={plotL} x2={plotR} y1={Math.round(yOf(scale, v)) + 0.5} y2={Math.round(yOf(scale, v)) + 0.5} stroke={GRID} />
          <text x={plotL - 5} y={yOf(scale, v)} textAnchor="end" dominantBaseline="middle" fill={TICK_TEXT}>
            {tickTime(v, decimals)}
          </text>
        </g>
      ))}
      {xTicks.map((m) => (
        <g key={m}>
          {m > x0 && <line x1={Math.round(xOf(scale, m)) + 0.5} x2={Math.round(xOf(scale, m)) + 0.5} y1={plotT} y2={plotB} stroke={GRID} strokeDasharray="2 3" />}
          <text x={xOf(scale, m)} y={plotB + 13} textAnchor="middle" fill={TICK_TEXT}>
            {m === x0 ? "0 min" : minutes(m, x0)}
          </text>
        </g>
      ))}
      <line x1={plotL} x2={plotR} y1={Math.round(plotB) + 0.5} y2={Math.round(plotB) + 0.5} stroke={AXIS} />
    </g>
  );
}

/** The fastest lap so far (a step to t) and the push-lap median of each window (at the middle of what's run of it). */
function Lines({ model, scale, t }: { model: Evolution; scale: Scale; t: number }) {
  const { records, windows } = model;
  let step = "";
  records.forEach((r, i) => {
    const x = xOf(scale, r.at);
    const y = yOf(scale, r.time);
    step += i === 0 ? `M${x} ${y}` : `H${x}V${y}`;
  });
  if (records.length) step += `H${xOf(scale, Math.min(Math.max(t, records.at(-1)!.at), scale.x1))}`;
  const medians = windows.map((win) => ({ x: xOf(scale, (win.from + Math.min(win.to, Math.max(t, win.from))) / 2), y: yOf(scale, win.median), win }));
  const lastMedian = medians.at(-1);
  return (
    <g>
      <path d={step} fill="none" stroke={FASTEST} strokeWidth={1.5} />
      {medians.length > 1 && <polyline points={medians.map((m) => `${m.x},${m.y}`).join(" ")} fill="none" stroke={MEDIAN} strokeWidth={2} strokeLinejoin="round" />}
      {medians.map((m) => (
        <circle key={m.win.from} cx={m.x} cy={m.y} r={3.5} fill={SURFACE} stroke={MEDIAN} strokeWidth={1.75}>
          <title>{`Median push lap, ${minutes(m.win.from, scale.x0)}–${minutes(m.win.to, scale.x0)} min: ${lapTime(m.win.median)} (${m.win.laps} laps)`}</title>
        </circle>
      ))}
      {lastMedian && lastMedian.x < scale.plotR - 50 && (
        <text x={lastMedian.x + 7} y={lastMedian.y} dominantBaseline="middle" fontSize={11} fontWeight={600} fill={MEDIAN} fontFamily="ui-sans-serif, system-ui, sans-serif">
          {lapTime(lastMedian.win.median)}
        </text>
      )}
    </g>
  );
}

export default defineWidget({
  id: "track-evolution",
  name: "Track evolution",
  group: "analysis",
  description: "How much quicker the track got: every valid lap by session time, the fastest lap so far and the median of each 10 minutes' push laps.",
  version: "1.0.0",
  // Fills its column: a taller chart separates close lap times better.
  height: { min: 240 },
  width: { min: 24, default: 40, max: 100 },
  sessions: ["practice"],
  settings: {},
  Component: TrackEvolution,
});
