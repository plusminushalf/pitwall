// The lap compare chart: strips of speed, delta to the reference lap, throttle, brake and gear against distance
// from the timing line, in the compared drivers' colours; sector boundaries and corners along the top. Pure canvas
// drawing, sized by the caller (the component owns the pointer: hover, zoom, seek).

import { timeAtDistance, valueAtDistance, type CompareStyle, type DeltaSeries, type LapTrace } from "widget-kit";

/** Margins around the strips: the y labels on the left, the distance axis under. */
export const M = { left: 36, right: 8, top: 14, bottom: 16 } as const;
const STRIP_GAP = 8;
const LANE_H = 4; // brake lane per driver
const GAP_MS = 1_500; // break a line across missing car data
const FONT = "9px ui-sans-serif, system-ui, sans-serif";
const GRID = "#27272a";
const AXIS = "#3f3f46";
const INK_MUTED = "#71717a";
const INK = "#a1a1aa";

export type StripKey = "speed" | "delta" | "throttle" | "brake" | "gear";

export interface Strip {
  key: StripKey;
  label: string;
  top: number;
  height: number;
  min: number;
  max: number;
  ticks: number[];
  fmt: (v: number) => string;
}

export interface Series {
  trace: LapTrace;
  style: CompareStyle;
  /** Delta to the reference (the first series has none). */
  delta: DeltaSeries | null;
}

export interface ChartModel {
  series: readonly Series[];
  lapLength: number;
  sectorDistances: readonly [number, number];
  corners: readonly { label: string; d: number }[];
  /** Distance window (m). */
  x0: number;
  x1: number;
  hover: number | null;
  throttle: boolean;
  gear: boolean;
}

/** A "nice" tick step (1, 2 or 5 × 10^k) giving about `count` ticks over `range`. */
function niceStep(range: number, count: number): number {
  const raw = range / Math.max(1, count);
  const p = 10 ** Math.floor(Math.log10(raw));
  const f = raw / p;
  return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * p;
}

function ticksFor(min: number, max: number, count: number): number[] {
  const step = niceStep(max - min, count);
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) out.push(Math.round(v / step) * step);
  return out;
}

const fmtDistance = (m: number, step: number) => (step >= 1000 ? `${(m / 1000).toFixed(0)} km` : step >= 100 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`);

/** Visible index range of a trace for [x0, x1], one sample either side. */
function visible(lap: LapTrace, x0: number, x1: number): [number, number] {
  let a = 0;
  while (a < lap.d.length - 1 && lap.d[a + 1] < x0) a++;
  let b = lap.d.length - 1;
  while (b > 0 && lap.d[b - 1] > x1) b--;
  return [a, b];
}

/** The strips and their scales for the visible window, in `h` px of canvas. */
export function layoutStrips(h: number, m: ChartModel): Strip[] {
  if (h <= 0) return [];
  let lo = Infinity;
  let hi = -Infinity;
  let dmax = 0;
  for (const s of m.series) {
    const [a, b] = visible(s.trace, m.x0, m.x1);
    for (let i = a; i <= b; i++) {
      lo = Math.min(lo, s.trace.speed[i]);
      hi = Math.max(hi, s.trace.speed[i]);
    }
    if (s.delta) for (let i = 0; i < s.delta.d.length; i++) if (s.delta.d[i] >= m.x0 && s.delta.d[i] <= m.x1) dmax = Math.max(dmax, Math.abs(s.delta.delta[i]));
  }
  if (!Number.isFinite(lo)) [lo, hi] = [0, 350];
  const sMin = Math.max(0, Math.floor((lo - 12) / 10) * 10);
  const sMax = Math.ceil((hi + 12) / 10) * 10;
  const dRange = Math.max(0.05, dmax * 1.15);
  const brakeH = Math.max(1, m.series.length) * LANE_H + 3;
  const hasDelta = m.series.length > 1;
  const count = 2 + (hasDelta ? 1 : 0) + (m.throttle ? 1 : 0) + (m.gear ? 1 : 0);
  const avail = Math.max(60, h - M.top - M.bottom - brakeH - STRIP_GAP * (count - 1));
  const weights = { speed: 5, delta: hasDelta ? 3 : 0, throttle: m.throttle ? 1.6 : 0, gear: m.gear ? 1.6 : 0 };
  const total = weights.speed + weights.delta + weights.throttle + weights.gear;
  const hOf = (k: keyof typeof weights) => Math.round((avail * weights[k]) / total);
  const out: Strip[] = [];
  let top = M.top;
  const push = (s: Omit<Strip, "top">) => {
    out.push({ ...s, top });
    top += s.height + STRIP_GAP;
  };
  push({ key: "speed", label: "Speed", height: hOf("speed"), min: sMin, max: sMax, ticks: ticksFor(sMin, sMax, Math.max(2, hOf("speed") / 30)), fmt: (v) => String(v) });
  if (hasDelta) push({ key: "delta", label: "Delta", height: hOf("delta"), min: -dRange, max: dRange, ticks: ticksFor(-dRange, dRange, Math.max(2, hOf("delta") / 24)), fmt: (v) => (v === 0 ? "0" : `${v > 0 ? "+" : "−"}${Math.abs(v).toFixed(dRange < 0.5 ? 2 : 1)}`) });
  if (m.throttle) push({ key: "throttle", label: "Thr", height: hOf("throttle"), min: 0, max: 100, ticks: [0, 100], fmt: (v) => `${v}` });
  push({ key: "brake", label: "Brk", height: brakeH, min: 0, max: 1, ticks: [], fmt: () => "" });
  if (m.gear) push({ key: "gear", label: "Gear", height: hOf("gear"), min: 1, max: 8, ticks: [2, 4, 6, 8], fmt: (v) => String(v) });
  return out;
}

export const yOf = (s: Strip, v: number) => s.top + s.height - ((Math.min(Math.max(v, s.min), s.max) - s.min) / (s.max - s.min)) * s.height;

/** Draws the chart into `canvas` at w × h CSS px. */
export function drawChart(canvas: HTMLCanvasElement, m: ChartModel, strips: Strip[], w: number, h: number, dpr: number) {
  const pw = Math.round(w * dpr);
  const ph = Math.round(h * dpr);
  if (canvas.width !== pw || canvas.height !== ph) {
    canvas.width = pw;
    canvas.height = ph;
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.font = FONT;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  const { x0, x1, series } = m;
  const plotW = Math.max(1, w - M.left - M.right);
  const plotBottom = h - M.bottom;
  const right = w - M.right;
  const xOf = (d: number) => M.left + ((d - x0) / (x1 - x0)) * plotW;

  // Distance axis, sector boundaries and corners.
  const xStep = niceStep(x1 - x0, Math.max(2, plotW / 80));
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.fillStyle = INK_MUTED;
  for (const d of ticksFor(x0, x1, Math.max(2, plotW / 80))) {
    const x = Math.round(xOf(d)) + 0.5;
    ctx.strokeStyle = GRID;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, M.top);
    ctx.lineTo(x, plotBottom);
    ctx.stroke();
    ctx.fillText(fmtDistance(d, xStep), x, plotBottom + 4);
  }
  ctx.setLineDash([3, 3]);
  ctx.strokeStyle = "#52525b";
  m.sectorDistances.forEach((d, i) => {
    if (!(d >= x0 && d <= x1)) return;
    const x = Math.round(xOf(d)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(x, M.top);
    ctx.lineTo(x, plotBottom);
    ctx.stroke();
    ctx.fillStyle = INK;
    ctx.textBaseline = "bottom";
    ctx.fillText(`S${i + 2}`, x, M.top - 2);
  });
  ctx.setLineDash([]);
  ctx.textBaseline = "bottom";
  ctx.fillStyle = INK_MUTED;
  let lastLabel = -Infinity;
  for (const c of m.corners) {
    if (c.d < x0 || c.d > x1) continue;
    const x = xOf(c.d);
    if (x - lastLabel < 16 || m.sectorDistances.some((s) => Math.abs(xOf(s) - x) < 12)) continue;
    ctx.fillText(`T${c.label}`, x, M.top - 2);
    lastLabel = x;
  }

  for (const s of strips) {
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.fillStyle = INK_MUTED;
    ctx.strokeStyle = GRID;
    ctx.lineWidth = 1;
    for (const v of s.ticks) {
      const y = Math.round(yOf(s, v)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(M.left, y);
      ctx.lineTo(right, y);
      ctx.stroke();
      ctx.fillText(s.fmt(v), M.left - 4, y);
    }
    ctx.strokeStyle = AXIS;
    ctx.beginPath();
    ctx.moveTo(M.left + 0.5, s.top);
    ctx.lineTo(M.left + 0.5, s.top + s.height);
    ctx.stroke();
    ctx.save();
    ctx.translate(7, s.top + s.height / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = "center";
    ctx.fillStyle = INK;
    ctx.font = "600 8px ui-sans-serif, system-ui, sans-serif";
    ctx.fillText(s.label.toUpperCase(), 0, 0);
    ctx.restore();
    ctx.font = FONT;

    ctx.save();
    ctx.beginPath();
    ctx.rect(M.left, s.top - 2, plotW, s.height + 4);
    ctx.clip();
    // The reference drawn last, on top.
    for (let k = series.length - 1; k >= 0; k--) {
      const { trace: lap, style, delta } = series[k];
      ctx.strokeStyle = style.color;
      ctx.fillStyle = style.color;
      ctx.setLineDash(style.dash);
      ctx.lineWidth = 1.5;
      if (s.key === "brake") {
        const y = s.top + 1.5 + k * LANE_H;
        const [a, b] = visible(lap, x0, x1);
        for (let i = a; i < b; i++) {
          if (lap.brake[i] <= 0 || lap.t[i + 1] - lap.t[i] > GAP_MS) continue;
          const xa = xOf(lap.d[i]);
          ctx.fillRect(xa, y, Math.max(1, xOf(lap.d[i + 1]) - xa), LANE_H - 1);
        }
        continue;
      }
      if (s.key === "delta") {
        if (k === 0) {
          ctx.beginPath();
          ctx.moveTo(M.left, yOf(s, 0));
          ctx.lineTo(right, yOf(s, 0));
          ctx.stroke();
          continue;
        }
        if (!delta) continue;
        ctx.beginPath();
        let started = false;
        for (let i = 0; i < delta.d.length; i++) {
          if (delta.d[i] < x0 - 50 || delta.d[i] > x1 + 50) continue;
          const x = xOf(delta.d[i]);
          const y = yOf(s, delta.delta[i]);
          if (!started) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
          started = true;
        }
        ctx.stroke();
        continue;
      }
      const values = s.key === "speed" ? lap.speed : s.key === "throttle" ? lap.throttle : lap.gear;
      const [a, b] = visible(lap, x0, x1);
      ctx.beginPath();
      for (let i = a; i <= b; i++) {
        const x = xOf(lap.d[i]);
        const y = yOf(s, values[i]);
        const broken = i === a || lap.t[i] - lap.t[i - 1] > GAP_MS;
        if (broken) ctx.moveTo(x, y);
        else if (s.key === "gear") {
          ctx.lineTo(x, yOf(s, values[i - 1]));
          ctx.lineTo(x, y);
        } else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.restore();
  }

  // Hover crosshair with a dot per series.
  const { hover } = m;
  if (hover != null && hover >= x0 && hover <= x1) {
    const x = Math.round(xOf(hover)) + 0.5;
    ctx.strokeStyle = "#d4d4d8";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, M.top);
    ctx.lineTo(x, plotBottom);
    ctx.stroke();
    const ref = series[0]?.trace;
    for (const s of strips) {
      if (s.key === "brake") continue;
      series.forEach(({ trace, style }, k) => {
        const v = s.key === "delta" ? (k === 0 ? 0 : ref ? (timeAtDistance(trace, hover) - timeAtDistance(ref, hover)) / 1000 : null) : valueAtDistance(trace, s.key, hover);
        if (v == null) return;
        ctx.fillStyle = style.color;
        ctx.strokeStyle = "#09090b";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(x, yOf(s, v), 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      });
    }
  }
}
