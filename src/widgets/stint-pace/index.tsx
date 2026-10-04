import { useMemo, useRef, useState, type PointerEvent } from "react";
import {
  COMPOUND,
  defineWidget,
  LABEL_CLASS,
  lapTime,
  teamColor,
  TyreBadge,
  useAllLaps,
  useAllStints,
  useWidgetSize,
  useDrivers,
  useFrame,
  useLeaderLap,
  useNeutralPeriods,
  usePlayback,
  useSelectedDriver,
  useSelection,
  useSettings,
  useTotalLaps,
  type DriverInfo,
  type DriverSetting,
  type Lap,
  type StintView,
} from "widget-kit";
import { EXCLUDED_TEXT, MIN_FIT_LAPS, pacePoints, stintFits, trendText, type PaceLap, type PacePoint, type PaceStint, type StintFit } from "./pace";

type XAxis = "lap" | "age";
type Colour = "auto" | "tyre" | "team";
type Settings = { driver: DriverSetting; x: XAxis; colour: Colour };

/** Drivers drawn at once: past this the points stop reading as separate stints. */
const MAX_DRIVERS = 4;
const FONT = "10px ui-sans-serif, system-ui, sans-serif";
const SURFACE = "#09090b";
const GRID = "#27272a";
const AXIS = "#3f3f46";
const TICK_TEXT = "#9f9fa9";
const LABEL_TEXT = "#d4d4d8";
const EXCLUDED_DOT = "#52525b";
const NOW_LINE = "#f4f4f5";
/** The header line, and the padding around the chart (px-3, pb-2). */
const HEAD_H = 28;
const PAD_X = 24;
const PAD_B = 8;
/** Room for the time labels (left), stint trend labels (right) and lap numbers (bottom). */
const M = { left: 40, right: 44, top: 6, bottom: 16 };
const DOT_R = 3;
const HIT_R = 12;

/** One driver as drawn: who, in what colour, and their points and stint trends. */
interface Series {
  n: number;
  info: DriverInfo;
  team: string;
  /** The second car of a team shown: hollow dots and a dashed trend, so teammates part. */
  hollow: boolean;
  points: PacePoint[];
  fits: StintFit[];
}

const slimLaps = (laps: readonly Lap[]): PaceLap[] => laps.map((l) => ({ lap: l.lap, start: l.start, end: l.end, duration: l.duration, pitOut: l.pitOut }));
const slimStints = (stints: readonly StintView[]): PaceStint[] =>
  stints.map((s) => ({ stint: s.stint, lapStart: s.lapStart, lapEnd: s.lapEnd, compound: s.compound, ageAtStart: s.ageAtStart, open: s.open }));

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

interface View {
  /** Null by tyre age when the set's age isn't known. */
  xOf: (p: { lap: number; age: number | null }) => number | null;
  yOf: (time: number) => number;
}

interface Hit {
  x: number;
  y: number;
  series: Series;
  point: PacePoint;
}

interface DrawInput {
  series: Series[];
  axis: XAxis;
  byTyre: boolean;
  totalLaps: number;
  leaderLap: number;
  hover: Hit | null;
}

/** Draws the chart; returns where each point landed, for hover and click. */
function draw(canvas: HTMLCanvasElement, input: DrawInput, w: number, h: number, dpr: number): Hit[] {
  const pw = Math.round(w * dpr);
  const ph = Math.round(h * dpr);
  if (canvas.width !== pw || canvas.height !== ph) {
    canvas.width = pw;
    canvas.height = ph;
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return [];
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const { series, axis, byTyre, totalLaps, leaderLap, hover } = input;
  const all = series.flatMap((s) => s.points);
  const clean = all.filter((p) => p.excluded == null);
  if (clean.length === 0) return [];

  const plotL = M.left;
  const plotR = w - M.right;
  const plotT = M.top;
  const plotB = h - M.bottom;
  const plotW = plotR - plotL;
  const plotH = plotB - plotT;
  if (plotW <= 20 || plotH <= 20) return [];

  // y: lap time, slower up, fitted to the clean laps (excluded ones outside it aren't drawn).
  let lo = Math.min(...clean.map((p) => p.time));
  let hi = Math.max(...clean.map((p) => p.time));
  const pad = Math.max((hi - lo) * 0.08, 0.2);
  lo -= pad;
  hi += pad;
  const yOf = (t: number) => plotB - ((t - lo) / (hi - lo)) * plotH;
  // x: the race distance by lap (so the chart fills in as the race goes), or tyre age.
  const maxAge = Math.max(0, ...all.flatMap((p) => (p.age == null ? [] : [p.age])));
  const xMax = axis === "lap" ? Math.max(totalLaps, ...all.map((p) => p.lap)) : Math.max(20, Math.ceil((maxAge + 1) / 5) * 5);
  const xMin = axis === "lap" ? 1 : 0;
  const xAt = (v: number) => plotL + ((v - xMin + 0.5) / (xMax - xMin + 1)) * plotW;
  const view: View = { xOf: (p) => (axis === "lap" ? xAt(p.lap) : p.age == null ? null : xAt(p.age)), yOf };

  ctx.font = FONT;
  ctx.lineWidth = 1;

  // Time grid and labels.
  const yStep = tickStep(hi - lo, plotH, 30, [0.1, 0.2, 0.5, 1, 2, 5, 10, 30]);
  const decimals = yStep < 1 ? 1 : 0;
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (let v = Math.ceil(lo / yStep) * yStep; v <= hi; v += yStep) {
    const y = Math.round(yOf(v)) + 0.5;
    ctx.strokeStyle = GRID;
    ctx.beginPath();
    ctx.moveTo(plotL, y);
    ctx.lineTo(plotR, y);
    ctx.stroke();
    ctx.fillStyle = TICK_TEXT;
    ctx.fillText(tickTime(v, decimals), plotL - 5, y);
  }

  // Lap (or age) axis.
  ctx.strokeStyle = AXIS;
  ctx.beginPath();
  ctx.moveTo(plotL, Math.round(plotB) + 0.5);
  ctx.lineTo(plotR, Math.round(plotB) + 0.5);
  ctx.stroke();
  const xStep = tickStep(xMax - xMin + 1, plotW, 28, [1, 2, 5, 10, 20, 50]);
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.fillStyle = TICK_TEXT;
  for (let v = Math.ceil(Math.max(xMin, 1) / xStep) * xStep; v <= xMax; v += xStep) ctx.fillText(String(v), xAt(v), plotB + 3);
  if (axis === "age") ctx.fillText("0", xAt(0), plotB + 3);

  // Now: the lap the leader is on.
  if (axis === "lap" && leaderLap >= 1) {
    const x = Math.round(xAt(Math.min(leaderLap, xMax))) + 0.5;
    ctx.strokeStyle = NOW_LINE;
    ctx.beginPath();
    ctx.moveTo(x, plotT);
    ctx.lineTo(x, plotB);
    ctx.stroke();
  }

  ctx.save();
  ctx.beginPath();
  ctx.rect(plotL, plotT - DOT_R - 2, plotW + M.right, plotH + 2 * DOT_R + 4);
  ctx.clip();

  const hits: Hit[] = [];
  const inRange = (p: PacePoint) => p.time >= lo && p.time <= hi;
  const lineColor = (s: Series, compound: string) => (byTyre && series.length === 1 ? compoundColor(compound) : s.team);

  // Laps that don't count: small grey dots, under everything.
  ctx.fillStyle = EXCLUDED_DOT;
  for (const s of series) {
    for (const p of s.points) {
      const x = view.xOf(p);
      if (p.excluded == null || !inRange(p) || x == null) continue;
      const y = yOf(p.time);
      ctx.beginPath();
      ctx.arc(x, y, 2, 0, Math.PI * 2);
      ctx.fill();
      hits.push({ x, y, series: s, point: p });
    }
  }

  // Stint trends, then the clean laps on top of them (each dot ringed in the surface colour).
  ctx.lineCap = "round";
  for (const s of series) {
    for (const f of s.fits) {
      const x0 = view.xOf({ lap: f.fromLap, age: f.fromAge });
      const x1 = view.xOf({ lap: f.toLap, age: f.toAge });
      if (x0 == null || x1 == null) continue;
      ctx.strokeStyle = lineColor(s, f.compound);
      ctx.lineWidth = 2;
      ctx.setLineDash(s.hollow ? [5, 3] : []);
      ctx.beginPath();
      ctx.moveTo(x0, yOf(f.intercept + f.slope * f.fromLap));
      ctx.lineTo(x1, yOf(f.intercept + f.slope * f.toLap));
      ctx.stroke();
    }
  }
  ctx.setLineDash([]);
  for (const s of series) {
    for (const p of s.points) {
      const x = view.xOf(p);
      if (p.excluded != null || x == null) continue;
      const y = yOf(p.time);
      const color = byTyre ? compoundColor(p.compound) : s.team;
      ctx.fillStyle = SURFACE;
      ctx.beginPath();
      ctx.arc(x, y, DOT_R + 1.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x, y, s.hollow ? DOT_R - 0.75 : DOT_R, 0, Math.PI * 2);
      if (s.hollow) {
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      } else {
        ctx.fillStyle = color;
        ctx.fill();
      }
      hits.push({ x, y, series: s, point: p });
    }
  }

  // Each stint's trend at its end, where there's room: the number people want.
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillStyle = LABEL_TEXT;
  const placed: [number, number, number, number][] = [];
  for (const s of series) {
    for (const f of s.fits) {
      const text = `${(COMPOUND[f.compound] ?? COMPOUND.UNKNOWN).letter} ${trendText(f.slope).replace(" s/lap", "")}`;
      const end = view.xOf({ lap: f.toLap, age: f.toAge });
      if (end == null) continue;
      const x = end + DOT_R + 4;
      const y = yOf(f.intercept + f.slope * f.toLap);
      const box: [number, number, number, number] = [x, y - 6, x + ctx.measureText(text).width, y + 6];
      if (box[2] > w || placed.some((b) => b[0] < box[2] && box[0] < b[2] && b[1] < box[3] && box[1] < b[3])) continue;
      if (hits.some((hp) => hp.x > box[0] - DOT_R && hp.x < box[2] + DOT_R && Math.abs(hp.y - y) < 6 + DOT_R)) continue;
      placed.push(box);
      ctx.fillText(text, x, y);
    }
  }

  // The hovered lap: a ring around it.
  if (hover) {
    const h = hits.find((x) => x.series.n === hover.series.n && x.point.lap === hover.point.lap);
    if (h) {
      ctx.strokeStyle = NOW_LINE;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(h.x, h.y, DOT_R + 3, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  ctx.restore();
  return hits;
}

/** A short key for a driver: a dot in the team colour, hollow for the second car of a team. */
function Key({ color, hollow }: { color: string; hollow: boolean }) {
  return <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={hollow ? { boxShadow: `inset 0 0 0 1.5px ${color}` } : { background: color }} />;
}

/** The lap under the pointer: its time first, then whose lap it is and on what tyre. */
function Tooltip({ hit, fit, w }: { hit: Hit; fit: StintFit | undefined; w: number }) {
  const { point: p, series: s } = hit;
  const left = hit.x + PAD_X / 2;
  const flip = left > w * 0.6;
  return (
    <div
      className="pointer-events-none absolute z-10 whitespace-nowrap rounded-md bg-zinc-900 px-2 py-1.5 text-xs shadow-lg ring-1 ring-zinc-800"
      style={{ top: HEAD_H + hit.y - 8, left: flip ? undefined : left + 10, right: flip ? w - left + 10 : undefined, transform: "translateY(-50%)" }}
    >
      <div className="text-sm font-semibold tabular-nums text-zinc-50">{lapTime(p.time)}</div>
      <div className="flex items-center gap-1.5 text-zinc-300">
        <span className="inline-block h-0.5 w-2.5 rounded-full" style={{ background: s.team }} />
        <span className="font-semibold">{s.info.acronym}</span>
        <span className="tabular-nums text-zinc-400">Lap {p.lap}</span>
      </div>
      <div className="flex items-center gap-1.5 text-zinc-400">
        <TyreBadge compound={p.compound} size={12} />
        <span className="tabular-nums">
          {p.age == null ? "Tyre and age not known" : `${compoundName(p.compound)}, ${p.age} ${p.age === 1 ? "lap" : "laps"} old`}
        </span>
      </div>
      {p.excluded ? (
        <div className="text-zinc-400">{EXCLUDED_TEXT[p.excluded]}: not in the trend</div>
      ) : fit ? (
        <div className="tabular-nums text-zinc-400">Stint trend {trendText(fit.slope)}</div>
      ) : null}
      <div className="text-zinc-400">Click to watch this lap</div>
    </div>
  );
}

/** Lap times per stint for the selected drivers, with each stint's trend in seconds per lap. */
function StintPace() {
  const [{ driver, x: axis, colour }] = useSettings<Settings>();
  const selected = useSelection((s) => s.selected);
  const focus = useSelection((s) => s.focus);
  const fallback = useSelectedDriver();
  const pinned = typeof driver === "number";
  const shown = !pinned && selected.length > 0 ? selected.slice(0, MAX_DRIVERS) : fallback != null ? [fallback] : [];
  const more = pinned ? 0 : Math.max(selected.length - MAX_DRIVERS, 0);

  // The shown drivers' laps and stints, in `shown` order: a re-render when one of them completes a lap
  // (or starts a stint), not when the rest of the field does.
  const laps = useAllLaps((all) => shown.map((n) => slimLaps(all.get(n) ?? [])));
  const stints = useAllStints((all) => shown.map((n) => slimStints(all.get(n) ?? [])));
  const neutral = useNeutralPeriods();
  const drivers = useDrivers();
  const totalLaps = useTotalLaps();
  const leaderLap = useLeaderLap();
  const seek = usePlayback((p) => p.seek);
  const size = useWidgetSize();

  const series = useMemo((): Series[] => {
    const order = new Map(drivers.map((d, i) => [d.number, i]));
    const out: Series[] = [];
    shown.forEach((n, i) => {
      const info = drivers.find((d) => d.number === n);
      if (!info) return;
      // Hollow: a teammate earlier in the session's order is shown too.
      const hollow = shown.some((m) => m !== n && drivers.find((d) => d.number === m)?.team === info.team && order.get(m)! < order.get(n)!);
      const points = pacePoints(laps[i], stints[i], neutral);
      out.push({ n, info, team: teamColor(info.teamColour), hollow, points, fits: stintFits(points, stints[i]) });
    });
    return out;
    // `laps` and `stints` keep their identity until a shown driver completes a lap (or a stint starts).
  }, [drivers, shown.join(), laps, stints, neutral]);

  const byTyre = colour === "tyre" || (colour === "auto" && series.length === 1);
  const [hover, setHover] = useState<Hit | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hits = useRef<Hit[]>([]);
  const w = size.width - PAD_X;
  const h = size.height - HEAD_H - PAD_B;

  // Redrawn on the next animation frame, and only when something it shows changed.
  const drawn = useRef<unknown[]>([]);
  useFrame(() => {
    const canvas = canvasRef.current;
    const now = [series, axis, byTyre, totalLaps, leaderLap, hover, w, h, size.pixelRatio];
    if (!canvas || w <= 0 || h <= 0 || now.every((v, i) => v === drawn.current[i])) return;
    drawn.current = now;
    hits.current = draw(canvas, { series, axis, byTyre, totalLaps, leaderLap, hover }, w, h, size.pixelRatio);
  });

  const nearest = (e: PointerEvent<HTMLCanvasElement>): Hit | null => {
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    let best: Hit | null = null;
    let bestD = HIT_R;
    for (const hp of hits.current) {
      const d = Math.hypot(hp.x - mx, hp.y - my);
      // Clean laps win a tie with the grey ones under them.
      if (d < bestD || (best?.point.excluded && !hp.point.excluded && d <= HIT_R)) {
        best = hp;
        bestD = d;
      }
    }
    return best;
  };
  const onMove = (e: PointerEvent<HTMLCanvasElement>) => {
    const hit = nearest(e);
    if (hit?.series.n !== hover?.series.n || hit?.point.lap !== hover?.point.lap) setHover(hit);
  };
  // Watch the lap: to its start, with its driver focused (so the driver widgets show them).
  const onClick = (e: PointerEvent<HTMLCanvasElement>) => {
    const hit = nearest(e);
    if (!hit) return;
    seek(hit.point.start);
    focus(hit.series.n);
    setHover(null);
  };

  const hoverFit = hover?.series.fits.find((f) => f.stint === hover.point.stint);
  const empty = series.every((s) => s.points.every((p) => p.excluded != null));

  return (
    <div className="relative h-full px-3 pb-2 text-sm">
      <div className="flex items-center justify-between gap-3 overflow-hidden" style={{ height: HEAD_H }}>
        <span className={`${LABEL_CLASS} shrink-0`}>
          Stint pace <span className="font-normal normal-case tracking-normal text-zinc-400">· {axis === "lap" ? "by lap" : "by tyre age"}</span>
        </span>
        <span className="flex min-w-0 items-center gap-3 text-[11px] text-zinc-400">
          {series.map((s) => {
            const current = s.fits.find((f) => f.open);
            const compound = s.points.at(-1)?.compound ?? null;
            return (
              <span key={s.n} className="flex shrink-0 items-center gap-1.5" title={current ? `${s.info.acronym}, this stint: ${trendText(current.slope)} over ${current.laps} clean laps (fuel burning off is in it too)` : `${s.info.acronym}: a trend after ${MIN_FIT_LAPS} clean laps on this set`}>
                {!byTyre || series.length > 1 ? <Key color={s.team} hollow={s.hollow} /> : null}
                <span className="font-semibold text-zinc-200">{s.info.acronym}</span>
                {compound && <TyreBadge compound={compound} size={14} />}
                <span className="tabular-nums">{current ? trendText(current.slope) : "–"}</span>
              </span>
            );
          })}
          {more > 0 && <span className="shrink-0">+{more} not shown</span>}
        </span>
      </div>
      <canvas
        ref={canvasRef}
        role="img"
        aria-label="Lap times by stint for the drivers shown, with each stint's trend"
        className={`block ${hover ? "cursor-pointer" : ""}`}
        style={{ width: w, height: h }}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
        onClick={onClick}
      />
      {empty && (
        <div className="pointer-events-none absolute inset-x-0 flex items-center justify-center text-xs text-zinc-400" style={{ top: HEAD_H, height: h }}>
          No clean laps yet
        </div>
      )}
      {hover && <Tooltip hit={hover} fit={hoverFit} w={size.width} />}
    </div>
  );
}

export default defineWidget({
  id: "stint-pace",
  name: "Stint pace",
  description: "Lap times per stint for the selected drivers, with how much slower each stint gets per lap.",
  version: "1.0.0",
  // Fills its column: a taller chart separates close lap times better.
  height: { min: 160 },
  width: { min: 21, default: 42, max: 100 },
  sessions: ["race", "practice"],
  settings: { driver: "follow-selection" as DriverSetting, x: "lap" as XAxis, colour: "auto" as Colour },
  fields: {
    x: {
      kind: "choice",
      label: "Plot laps by",
      options: [
        { value: "lap", label: "Lap number" },
        { value: "age", label: "Tyre age" },
      ],
    },
    colour: {
      kind: "choice",
      label: "Colour",
      options: [
        { value: "auto", label: "Tyre for one driver, team for more" },
        { value: "tyre", label: "Tyre" },
        { value: "team", label: "Team" },
      ],
    },
  },
  Component: StintPace,
});
