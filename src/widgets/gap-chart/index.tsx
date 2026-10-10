import { useMemo, useRef, type KeyboardEvent, type MouseEvent } from "react";
import {
  defineWidget,
  gap,
  LABEL_CLASS,
  TAP_CLASS,
  teamColor,
  useAllLaps,
  useCardState,
  useDrivers,
  useFrame,
  useLapWindow,
  useNeutralPeriods,
  usePlayback,
  useSelection,
  useSessionInfo,
  useSettings,
  useTotalLaps,
  useWidgetSize,
  type DriverInfo,
  type Lap,
} from "widget-kit";
import {
  crossingsOf,
  gapScale,
  gapSeries,
  leaderCrossings,
  neutralisedLaps,
  orderAtLine,
  type Crossings,
  type Gap,
  type GapMode,
  type GapSeries,
  type Neutralised,
} from "./gaps";

type Settings = { gapMode: GapMode };

/** With nothing selected, the chart shows the first this many at the line. */
const FALLBACK = 4;
const FONT = "10px ui-sans-serif, system-ui, sans-serif";
const LABEL_FONT = "600 10px ui-sans-serif, system-ui, sans-serif";
/** The padding around the chart (px-3, pt-2, pb-2) and the title line over it. */
const PAD_X = 24;
const PAD_Y = 16;
const HEAD_H = 20;
/** Inside the canvas: the SC labels' row on top, the lap numbers under the plot, the line-end labels on the right. */
const TOP = 14;
const BOTTOM = 16;
const RIGHT = 32;
/** Gridlines at least this far apart (px) and at most this many; lap numbers at least this far apart. */
const ROW_PX = 32;
const MAX_ROWS = 6;
const LAP_PX = 30;
const LAP_STEPS = [1, 2, 5, 10, 20, 25, 50];
/** The second car of a team (in session order) is dashed: teammates share a colour. */
const DASH = [5, 3];
const GROUND = "#09090b";
const NEUTRALISED: Record<Neutralised, { fill: string; label: string; title: string }> = {
  SC: { fill: "rgba(255, 210, 48, 0.12)", label: "SC", title: "Safety car" },
  VSC: { fill: "rgba(255, 210, 48, 0.06)", label: "VSC", title: "Virtual safety car" },
};

/** Every car's crossings, by car number: compared by value, so the chart re-renders only when someone completes a lap. */
const allCrossings = (laps: ReadonlyMap<number, readonly Lap[]>): ReadonlyMap<number, Crossings> =>
  new Map([...laps].map(([n, l]) => [n, crossingsOf(l)]));

/** A line as drawn: its car, colour and dash. */
interface Line {
  series: GapSeries;
  info: DriverInfo;
  color: string;
  dashed: boolean;
}

/** Where things go on the canvas, CSS px. */
interface Layout {
  w: number;
  h: number;
  plotW: number;
  plotBottom: number;
  /** The lap at the left edge (0: the start) and laps across the chart: the race distance, or the timeline's lap window. */
  from: number;
  laps: number;
  max: number;
  step: number;
  capped: boolean;
}

const xOf = (L: Layout, lap: number) => ((lap - L.from) / L.laps) * L.plotW;
const yOf = (L: Layout, g: number) => TOP + (Math.min(g, L.max) / L.max) * (L.plotBottom - TOP);
const lapAt = (L: Layout, x: number) => L.from + Math.round((x / L.plotW) * L.laps);
/** The laps with a gap that the chart shows: gaps are at the end of a lap, from lap 1. */
const shownLaps = (L: Layout): [number, number] => [Math.max(L.from, 1), L.from + L.laps];
const seconds = (g: Gap): g is number => typeof g === "number";

function draw(canvas: HTMLCanvasElement, L: Layout, lines: Line[], sc: (Neutralised | null)[], hover: number | null, dpr: number) {
  const pw = Math.round(L.w * dpr);
  const ph = Math.round(L.h * dpr);
  if (canvas.width !== pw || canvas.height !== ph) {
    canvas.width = pw;
    canvas.height = ph;
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, L.w, L.h);
  ctx.font = FONT;

  // Safety car laps: a wash over each run of laps, labelled on top.
  for (let n = 1; n < sc.length; n++) {
    const kind = sc[n];
    if (!kind || sc[n - 1] === kind) continue;
    let end = n;
    while (sc[end + 1] === kind) end++;
    const x0 = Math.max(xOf(L, n - 1), 0);
    const x1 = Math.min(xOf(L, end), L.plotW);
    if (x1 <= x0) continue;
    ctx.fillStyle = NEUTRALISED[kind].fill;
    ctx.fillRect(x0, TOP, x1 - x0, L.plotBottom - TOP);
    ctx.fillStyle = "#fee685";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText(NEUTRALISED[kind].label, (x0 + x1) / 2, 1);
  }

  // Gridlines, labelled in seconds at the left; the bottom one says "+" when gaps go past it. None
  // before the first lap is done (nothing to scale).
  ctx.lineWidth = 1;
  ctx.strokeStyle = "#27272a";
  ctx.fillStyle = "#9f9fa9";
  ctx.textAlign = "left";
  ctx.textBaseline = "bottom";
  const any = lines.some((l) => l.series.gaps.some(seconds));
  for (let v = 0; any && v <= L.max + 1e-9; v += L.step) {
    const y = Math.round(yOf(L, v)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(L.plotW, y);
    ctx.stroke();
    if (v > 0) ctx.fillText(`${+v.toFixed(1)}s${L.capped && v + L.step > L.max + 1e-9 ? "+" : ""}`, 2, y - 1);
  }

  // Lap numbers.
  const every = LAP_STEPS.find((s) => (s / L.laps) * L.plotW >= LAP_PX) ?? L.laps;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  for (let n = (Math.floor(L.from / every) + 1) * every; n <= L.from + L.laps; n += every) ctx.fillText(String(n), xOf(L, n), L.plotBottom + 3);

  // The lines: 2 px, broken where a car has no gap (lapped, retired, missing lap).
  const [lo, hi] = shownLaps(L);
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, L.plotW + RIGHT, L.plotBottom + 1);
  ctx.clip();
  ctx.lineWidth = 2;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  for (const line of lines) {
    const { gaps } = line.series;
    ctx.strokeStyle = line.color;
    ctx.fillStyle = line.color;
    ctx.setLineDash(line.dashed ? DASH : []);
    ctx.beginPath();
    for (let n = lo; n < gaps.length && n <= hi; n++) {
      const g = gaps[n];
      if (!seconds(g)) continue;
      const x = xOf(L, n);
      const y = yOf(L, g);
      if (n > lo && seconds(gaps[n - 1])) ctx.lineTo(x, y);
      else if (n === hi || !seconds(gaps[n + 1])) ctx.fillRect(x - 1.5, y - 1.5, 3, 3); // a lap on its own: a dot
      else ctx.moveTo(x, y);
    }
    ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.restore();

  // The end of each line: a dot and the driver's code, unless it would cover one already placed.
  const placed: [number, number][] = [];
  ctx.font = LABEL_FONT;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  for (const line of lines) {
    const { gaps } = line.series;
    let n = Math.min(gaps.length - 1, hi);
    while (n >= lo && !seconds(gaps[n])) n--;
    if (n < lo) continue;
    const x = xOf(L, n);
    const y = yOf(L, gaps[n] as number);
    dot(ctx, x, y, 3, line.color);
    if (placed.some(([px, py]) => Math.abs(px - x) < 30 && Math.abs(py - y) < 11)) continue;
    placed.push([x, y]);
    ctx.fillStyle = "#d4d4d8";
    ctx.fillText(line.info.acronym, x + 6, y);
  }

  // The hovered lap: a crosshair, and each car's point on it.
  if (hover != null) {
    const x = Math.round(xOf(L, hover)) + 0.5;
    ctx.strokeStyle = "#71717b";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, TOP);
    ctx.lineTo(x, L.plotBottom);
    ctx.stroke();
    for (const line of lines) {
      const g = line.series.gaps[hover];
      if (seconds(g)) dot(ctx, xOf(L, hover), yOf(L, g), 4, line.color);
    }
  }
}

/** A dot with a 2 px ring in the ground colour, so it stays clear of the lines it sits on. */
function dot(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string) {
  ctx.beginPath();
  ctx.arc(x, y, r + 2, 0, Math.PI * 2);
  ctx.fillStyle = GROUND;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
}

/** A short stroke of the line's colour (dashed for a second teammate), as the key for a driver. */
function LineKey({ line }: { line: Line }) {
  return (
    <svg width="12" height="4" viewBox="0 0 12 4" className="shrink-0" aria-hidden>
      <line x1="1" y1="2" x2="11" y2="2" stroke={line.color} strokeWidth="2" strokeLinecap="round" strokeDasharray={line.dashed ? "3 2.5" : undefined} />
    </svg>
  );
}

const gapText = (g: Gap) => (g === "lapped" ? "Lapped" : g === "leading" || g === 0 ? "Leader" : seconds(g) ? gap(g) : "");

function Tooltip({ lap, lines, sc, left }: { lap: number; lines: Line[]; sc: Neutralised | null; left: boolean }) {
  const rows = lines
    .map((line) => ({ line, g: line.series.gaps[lap] ?? null }))
    .filter((r) => r.g != null)
    .sort((a, b) => (seconds(a.g) ? a.g : Infinity) - (seconds(b.g) ? b.g : Infinity));
  return (
    <div
      className={`pointer-events-none absolute top-0 z-10 min-w-32 rounded-md border border-zinc-800 bg-zinc-900 px-2.5 py-2 text-xs shadow-lg ${left ? "-translate-x-full" : ""}`}
    >
      <div className={LABEL_CLASS}>
        Lap {lap}
        {sc && <span className="font-normal normal-case tracking-normal text-amber-200"> · {NEUTRALISED[sc].title}</span>}
      </div>
      {rows.map(({ line, g }) => (
        <div key={line.info.number} className="mt-1 flex items-center gap-2">
          <LineKey line={line} />
          <span className="font-semibold tabular-nums text-zinc-100">{gapText(g)}</span>
          <span className="ml-auto text-zinc-400">{line.info.acronym}</span>
        </div>
      ))}
      <div className="mt-1.5 whitespace-nowrap text-[11px] text-zinc-400">Click to watch from lap {lap}</div>
    </div>
  );
}

/** Gaps lap by lap for the selected drivers (else the first few at the line), to the leader or the car ahead. */
function GapChart() {
  // Every car's crossings, not just the shown ones: the leader at each lap can be anyone.
  const all = useAllLaps(allCrossings);
  const drivers = useDrivers();
  const selected = useSelection((s) => s.selected);
  const [{ gapMode }, update] = useSettings<Settings>();
  const periods = useNeutralPeriods();
  const lightsOut = useSessionInfo((i) => i.lightsOut);
  const totalLaps = useTotalLaps();
  const seekToLap = usePlayback((p) => p.seekToLap);
  const size = useWidgetSize();
  const [hover, setHover] = useCardState<number | null>("hover", null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const markerRef = useRef<HTMLDivElement>(null);

  const leader = useMemo(() => leaderCrossings([...all.values()]), [all]);
  const sc = useMemo(() => neutralisedLaps(periods, leader, lightsOut), [periods, leader, lightsOut]);
  const shown = useMemo(
    () => (selected.length > 0 ? selected.filter((n) => all.has(n)) : orderAtLine(all).slice(0, FALLBACK)),
    [selected, all],
  );
  const lines = useMemo((): Line[] => {
    const info = new Map(drivers.map((d) => [d.number, d]));
    // The first car of each team in session order is solid, the second dashed.
    const second = new Set(drivers.filter((d, i) => drivers.findIndex((o) => o.teamColour === d.teamColour) < i).map((d) => d.number));
    return gapSeries(all, shown, gapMode)
      .filter((s) => info.has(s.driver))
      .map((series) => {
        const d = info.get(series.driver)!;
        const mate = shown.some((n) => n !== d.number && info.get(n)?.teamColour === d.teamColour);
        return { series, info: d, color: teamColor(d.teamColour), dashed: mate && second.has(d.number) };
      });
  }, [all, shown, gapMode, drivers]);

  const completed = leader.length - 1;
  const win = useLapWindow(Math.max(totalLaps, completed, 1));
  const w = size.width - PAD_X;
  const h = size.height - PAD_Y - HEAD_H;
  const layout = useMemo((): Layout => {
    const plotBottom = h - BOTTOM;
    // Scaled to the gaps in the window: zoomed in past lap 1's spread, the gaps that matter fill the chart.
    const from = win.from - 1;
    let largest = 0;
    for (const l of lines) {
      for (let n = Math.max(from, 1); n <= win.to && n < l.series.gaps.length; n++) {
        const g = l.series.gaps[n];
        if (seconds(g) && g > largest) largest = g;
      }
    }
    const scale = gapScale(largest, gapMode, Math.min(Math.floor((plotBottom - TOP) / ROW_PX), MAX_ROWS));
    return { w, h, plotW: Math.max(w - RIGHT, 1), plotBottom, from, laps: win.to - from, ...scale };
  }, [w, h, lines, gapMode, win]);
  const [firstLap, lastLap] = shownLaps(layout);
  const lastHover = Math.min(lastLap, completed);

  // The chart is redrawn on the next animation frame when something changed; the marker for where the
  // leader is now moves every frame (estimated from their last lap, as the tyre strip does).
  const drawn = useRef<unknown[]>([]);
  useFrame(({ t }) => {
    const marker = markerRef.current;
    if (marker) {
      const lastEnd = leader[completed];
      const from = completed > 1 ? leader[completed - 1] : lightsOut;
      const lapMs = lastEnd != null && from != null ? lastEnd - from : 0;
      const frac = lastEnd != null && lapMs > 0 ? Math.min(Math.max((t - lastEnd) / lapMs, 0), 0.99) : 0;
      const at = completed + frac;
      marker.style.transform = `translateX(${xOf(layout, Math.min(at, layout.from + layout.laps))}px)`;
      marker.style.visibility = t >= lightsOut && at >= layout.from && at <= layout.from + layout.laps ? "visible" : "hidden";
    }
    const canvas = canvasRef.current;
    const now = [layout, lines, sc, hover, size.pixelRatio];
    if (!canvas || w <= 0 || h <= 0 || now.every((v, i) => v === drawn.current[i])) return;
    drawn.current = now;
    draw(canvas, layout, lines, sc, hover, size.pixelRatio);
  });

  const lapFrom = (e: MouseEvent<HTMLCanvasElement>) => {
    const x = e.clientX - e.currentTarget.getBoundingClientRect().left;
    return lastHover >= firstLap ? Math.min(Math.max(lapAt(layout, x), firstLap), lastHover) : null;
  };
  const onKeyDown = (e: KeyboardEvent<HTMLCanvasElement>) => {
    if (lastHover < firstLap) return;
    const step = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0;
    if (step) {
      e.preventDefault();
      setHover((l) => Math.min(Math.max((l ?? lastHover + (step < 0 ? 1 : 0)) + step, firstLap), lastHover));
    } else if (e.key === "Enter" && hover != null) seekToLap(hover);
    else if (e.key === "Escape") setHover(null);
  };

  const title = gapMode === "leader" ? "Gap to leader" : "Interval";
  const names = lines.map((l) => l.info.acronym).join(", ");
  const hoverX = hover != null ? xOf(layout, hover) : 0;

  return (
    <div className="h-full px-3 pb-2 pt-2 text-sm">
      <div className="flex items-center justify-between gap-3" style={{ height: HEAD_H }}>
        <span className={`${LABEL_CLASS} shrink-0`}>
          <button
            onClick={() => update({ gapMode: gapMode === "leader" ? "interval" : "leader" })}
            className={`${TAP_CLASS} rounded-sm uppercase hover:text-zinc-100`}
            title={gapMode === "leader" ? "Show the interval to the car ahead" : "Show the gap to the leader"}
          >
            {title}
          </button>
          {selected.length === 0 && lines.length > 0 && <span className="font-normal normal-case tracking-normal text-zinc-400"> · top {lines.length}</span>}
          {win.zoomed && (
            <span className="font-normal normal-case tracking-normal text-zinc-400">
              {" "}
              · laps {win.from}–{win.to}
            </span>
          )}
        </span>
        <span className="flex min-w-0 items-center gap-2.5 overflow-hidden whitespace-nowrap text-[11px] text-zinc-400">
          {lines.map((l) => (
            <span key={l.info.number} className="flex items-center gap-1">
              <LineKey line={l} />
              {l.info.acronym}
            </span>
          ))}
        </span>
      </div>
      <div className="relative" style={{ width: w, height: h }}>
        <canvas
          ref={canvasRef}
          role="img"
          tabIndex={0}
          aria-label={`${title}, lap by lap${names ? `, for ${names}` : ""}. Arrow keys pick a lap, Enter watches it.`}
          // touch-pan-y: a finger dragged along the chart scrubs the readout, while an up-and-down drag scrolls the page.
          className="block cursor-crosshair touch-pan-y rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-300"
          style={{ width: w, height: h }}
          onPointerMove={(e) => setHover(lapFrom(e))}
          // A finger leaves as soon as it lifts: the readout it stopped on stays until the next touch or a tap elsewhere.
          onPointerLeave={(e) => e.pointerType !== "touch" && setHover(null)}
          onBlur={() => setHover(null)}
          onKeyDown={onKeyDown}
          onClick={(e) => {
            const lap = lapFrom(e);
            if (lap != null) seekToLap(lap);
          }}
        />
        <div ref={markerRef} className="pointer-events-none absolute left-0 w-px bg-zinc-300" style={{ top: TOP, height: layout.plotBottom - TOP }} />
        {completed === 0 && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-xs text-zinc-400">
            Gaps show from the end of lap 1.
          </div>
        )}
        {completed > 0 && lastHover < firstLap && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-xs text-zinc-400">
            Laps {win.from}–{win.to} haven't been run yet.
          </div>
        )}
        {hover != null && (
          <div className="pointer-events-none absolute top-0" style={{ left: hoverX + (hoverX > layout.plotW / 2 ? -10 : 10) }}>
            <Tooltip lap={hover} lines={lines} sc={sc[hover] ?? null} left={hoverX > layout.plotW / 2} />
          </div>
        )}
      </div>
    </div>
  );
}

export default defineWidget({
  id: "gap-chart",
  name: "Gaps",
  group: "analysis",
  description: "Gap to the leader or the car ahead, lap by lap. Click a lap to watch it.",
  version: "1.0.0",
  // Fills its column: the title line and a chart with room for a few gridlines.
  height: { min: PAD_Y + HEAD_H + 120 },
  width: { min: 21, default: 42, max: 100 },
  sessions: ["race"],
  settings: { gapMode: "leader" as GapMode },
  fields: {
    gapMode: {
      kind: "choice",
      label: "Gap",
      options: [
        { value: "leader", label: "Gap to leader" },
        { value: "interval", label: "Interval to the car ahead" },
      ],
    },
  },
  Component: GapChart,
});
