import { useEffect, useMemo, useRef, useState } from "react";
import { deltaSeries, distanceAtTime, valueAtDistance, timeAtDistance, type DecodedLap, type DeltaSeries } from "../../engine/compare";
import type { CompareEntry } from "../../hooks/useCompare";
import { useQuali } from "../../qualiStore";

const M = { left: 48, right: 14, top: 20, bottom: 22 };
const STRIP_GAP = 12;
const LANE_H = 5; // brake lane per driver
const GAP_MS = 1_500; // break a line across missing car data
const FONT = "10px ui-sans-serif, system-ui, sans-serif";
const GRID = "#27272a";
const AXIS = "#3f3f46";
const INK_MUTED = "#71717a";
const INK = "#a1a1aa";

type StripKey = "speed" | "delta" | "throttle" | "brake" | "gear";

interface Strip {
  key: StripKey;
  label: string;
  top: number;
  height: number;
  min: number;
  max: number;
  ticks: number[];
  fmt: (v: number) => string;
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
const signed = (s: number) => `${s > 0 ? "+" : s < 0 ? "−" : "±"}${Math.abs(s).toFixed(3)}`;

/** Visible index range of a trace for [x0, x1], one sample either side. */
function visible(lap: DecodedLap, x0: number, x1: number): [number, number] {
  let a = 0;
  while (a < lap.d.length - 1 && lap.d[a + 1] < x0) a++;
  let b = lap.d.length - 1;
  while (b > 0 && lap.d[b - 1] > x1) b--;
  return [a, b];
}

interface Props {
  entries: CompareEntry[];
  lapLength: number;
  sectorDistances: [number, number];
  corners: { number: number; d: number }[];
}

export function CompareCharts({ entries, lapLength, sectorDistances, corners }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const hover = useQuali((s) => s.hover);
  const zoom = useQuali((s) => s.zoom);
  const ghostT = useQuali((s) => s.ghostT);
  const { setHover, setZoom } = useQuali.getState();
  const [brush, setBrush] = useState<[number, number] | null>(null);
  const drag = useRef<{ x: number; moved: boolean } | null>(null);

  useEffect(() => {
    const el = wrapRef.current!;
    const ro = new ResizeObserver(([e]) => setSize({ w: Math.floor(e.contentRect.width), h: Math.floor(e.contentRect.height) }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const withTrace = useMemo(() => entries.filter((e) => e.trace != null), [entries]);
  const ref = withTrace[0]?.trace ?? null;
  const deltas = useMemo(() => {
    const out = new Map<number, DeltaSeries>();
    if (!ref) return out;
    for (const e of withTrace.slice(1)) out.set(e.driver, deltaSeries(ref, e.trace!, Math.max(2, lapLength / 2000)));
    return out;
  }, [withTrace, ref, lapLength]);

  const [x0, x1] = zoom ?? [0, lapLength];
  const plotW = Math.max(1, size.w - M.left - M.right);
  const xOf = (d: number) => M.left + ((d - x0) / (x1 - x0)) * plotW;
  const dOf = (x: number) => x0 + ((x - M.left) / plotW) * (x1 - x0);

  // Strip layout and scales for the visible distance window.
  const strips = useMemo((): Strip[] => {
    if (size.h <= 0) return [];
    let lo = Infinity;
    let hi = -Infinity;
    let dmax = 0;
    for (const e of withTrace) {
      const lap = e.trace!;
      const [a, b] = visible(lap, x0, x1);
      for (let i = a; i <= b; i++) {
        lo = Math.min(lo, lap.speed[i]);
        hi = Math.max(hi, lap.speed[i]);
      }
    }
    for (const s of deltas.values()) {
      for (let i = 0; i < s.d.length; i++) if (s.d[i] >= x0 && s.d[i] <= x1) dmax = Math.max(dmax, Math.abs(s.delta[i]));
    }
    if (!Number.isFinite(lo)) [lo, hi] = [0, 350];
    const sMin = Math.max(0, Math.floor((lo - 12) / 10) * 10);
    const sMax = Math.ceil((hi + 12) / 10) * 10;
    const dRange = Math.max(0.05, dmax * 1.15);
    const brakeH = Math.max(1, withTrace.length) * LANE_H + 4;
    const fixed = brakeH + STRIP_GAP * 4;
    const avail = Math.max(120, size.h - M.top - M.bottom - fixed);
    const hasDelta = withTrace.length > 1;
    const weights = { speed: 5, delta: hasDelta ? 2.6 : 0, throttle: 1.6, gear: 1.7 };
    const total = weights.speed + weights.delta + weights.throttle + weights.gear;
    const hOf = (k: keyof typeof weights) => Math.round((avail * weights[k]) / total);
    const out: Strip[] = [];
    let top = M.top;
    const push = (s: Omit<Strip, "top">) => {
      out.push({ ...s, top });
      top += s.height + STRIP_GAP;
    };
    push({ key: "speed", label: "Speed", height: hOf("speed"), min: sMin, max: sMax, ticks: ticksFor(sMin, sMax, Math.max(2, hOf("speed") / 34)), fmt: (v) => String(v) });
    if (hasDelta) push({ key: "delta", label: "Delta", height: hOf("delta"), min: -dRange, max: dRange, ticks: ticksFor(-dRange, dRange, Math.max(2, hOf("delta") / 26)), fmt: (v) => (v === 0 ? "0" : `${v > 0 ? "+" : "−"}${Math.abs(v).toFixed(dRange < 0.5 ? 2 : 1)}`) });
    push({ key: "throttle", label: "Throttle", height: hOf("throttle"), min: 0, max: 100, ticks: [0, 100], fmt: (v) => `${v}` });
    push({ key: "brake", label: "Brake", height: brakeH, min: 0, max: 1, ticks: [], fmt: () => "" });
    push({ key: "gear", label: "Gear", height: hOf("gear"), min: 1, max: 8, ticks: [2, 4, 6, 8], fmt: (v) => String(v) });
    return out;
  }, [size.h, withTrace, deltas, x0, x1]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || size.w <= 0 || size.h <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = size.w * dpr;
    canvas.height = size.h * dpr;
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.w, size.h);
    ctx.font = FONT;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    const plotBottom = size.h - M.bottom;
    const right = size.w - M.right;

    // Distance axis, sector boundaries and corners.
    const xStep = niceStep(x1 - x0, Math.max(2, plotW / 90));
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillStyle = INK_MUTED;
    for (const d of ticksFor(x0, x1, Math.max(2, plotW / 90))) {
      const x = Math.round(xOf(d)) + 0.5;
      ctx.strokeStyle = GRID;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, M.top);
      ctx.lineTo(x, plotBottom);
      ctx.stroke();
      ctx.fillText(fmtDistance(d, xStep), x, plotBottom + 6);
    }
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = "#52525b";
    sectorDistances.forEach((d, i) => {
      if (d < x0 || d > x1) return;
      const x = Math.round(xOf(d)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, M.top);
      ctx.lineTo(x, plotBottom);
      ctx.stroke();
      ctx.fillStyle = INK;
      ctx.textBaseline = "bottom";
      ctx.fillText(`S${i + 2}`, x, M.top - 3);
    });
    ctx.setLineDash([]);
    ctx.textBaseline = "bottom";
    ctx.fillStyle = INK_MUTED;
    let lastLabel = -Infinity;
    for (const c of corners) {
      if (c.d < x0 || c.d > x1) continue;
      const x = xOf(c.d);
      if (x - lastLabel < 16 || sectorDistances.some((s) => Math.abs(xOf(s) - x) < 12)) continue;
      ctx.fillText(`T${c.number}`, x, M.top - 3);
      lastLabel = x;
    }

    const yOf = (s: Strip, v: number) => s.top + s.height - ((Math.min(Math.max(v, s.min), s.max) - s.min) / (s.max - s.min)) * s.height;

    for (const s of strips) {
      // Frame, grid and labels.
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
        ctx.fillText(s.fmt(v), M.left - 6, y);
      }
      ctx.strokeStyle = AXIS;
      ctx.beginPath();
      ctx.moveTo(M.left + 0.5, s.top);
      ctx.lineTo(M.left + 0.5, s.top + s.height);
      ctx.stroke();
      ctx.save();
      ctx.translate(10, s.top + s.height / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.textAlign = "center";
      ctx.fillStyle = INK;
      ctx.font = "600 9px ui-sans-serif, system-ui, sans-serif";
      ctx.fillText(s.label.toUpperCase(), 0, 0);
      ctx.restore();
      ctx.font = FONT;

      ctx.save();
      ctx.beginPath();
      ctx.rect(M.left, s.top - 2, plotW, s.height + 4);
      ctx.clip();
      // Series: the reference drawn last, on top.
      for (let k = withTrace.length - 1; k >= 0; k--) {
        const e = withTrace[k];
        const lap = e.trace!;
        ctx.strokeStyle = e.style.color;
        ctx.fillStyle = e.style.color;
        ctx.setLineDash(e.style.dash);
        ctx.lineWidth = 2;
        if (s.key === "brake") {
          const y = s.top + 2 + k * LANE_H;
          const [a, b] = visible(lap, x0, x1);
          for (let i = a; i < b; i++) {
            if (lap.brake[i] <= 0 || lap.t[i + 1] - lap.t[i] > GAP_MS) continue;
            const xa = xOf(lap.d[i]);
            ctx.fillRect(xa, y, Math.max(1, xOf(lap.d[i + 1]) - xa), LANE_H - 1.5);
          }
          continue;
        }
        if (s.key === "delta") {
          // The reference is the delta's zero.
          if (k === 0) {
            ctx.beginPath();
            ctx.moveTo(M.left, yOf(s, 0));
            ctx.lineTo(right, yOf(s, 0));
            ctx.stroke();
            continue;
          }
          const series = deltas.get(e.driver);
          if (!series) continue;
          ctx.beginPath();
          let started = false;
          for (let i = 0; i < series.d.length; i++) {
            if (series.d[i] < x0 - 50 || series.d[i] > x1 + 50) continue;
            const x = xOf(series.d[i]);
            const y = yOf(s, series.delta[i]);
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

    // Ghost cars' distances along the top edge.
    if (ghostT > 0 && strips.length) {
      for (const e of withTrace) {
        const d = distanceAtTime(e.trace!, ghostT);
        if (d < x0 || d > x1) continue;
        const x = xOf(d);
        ctx.fillStyle = e.style.color;
        ctx.beginPath();
        ctx.moveTo(x - 4, M.top - 9);
        ctx.lineTo(x + 4, M.top - 9);
        ctx.lineTo(x, M.top - 2);
        ctx.closePath();
        ctx.fill();
      }
    }

    // Hover crosshair.
    if (hover != null && hover >= x0 && hover <= x1) {
      const x = Math.round(xOf(hover)) + 0.5;
      ctx.strokeStyle = "#d4d4d8";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, M.top);
      ctx.lineTo(x, plotBottom);
      ctx.stroke();
      for (const s of strips) {
        if (s.key === "brake") continue;
        withTrace.forEach((e, k) => {
          let v: number | null;
          if (s.key === "delta") v = k === 0 ? 0 : ref ? (timeAtDistance(e.trace!, hover) - timeAtDistance(ref, hover)) / 1000 : null;
          else v = valueAtDistance(e.trace!, s.key, hover);
          if (v == null) return;
          ctx.fillStyle = e.style.color;
          ctx.strokeStyle = "#09090b";
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(x, yOf(s, v), 3.5, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        });
      }
    }
  }, [size, strips, withTrace, deltas, hover, ghostT, x0, x1, sectorDistances, corners, ref, plotW]);

  // Pointer: hover, drag to zoom, wheel to zoom, double-click to reset.
  const inPlot = (x: number) => x >= M.left && x <= size.w - M.right;
  const localX = (e: React.PointerEvent | React.WheelEvent | React.MouseEvent) => e.clientX - e.currentTarget.getBoundingClientRect().left;
  const clampD = (d: number) => Math.min(Math.max(d, 0), lapLength);

  const tipEntries = hover != null ? withTrace : [];
  const tipLeft = hover != null ? xOf(hover) : 0;
  const tipFlip = tipLeft > size.w - 220;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={wrapRef} className="relative min-h-0 flex-1 select-none">
        <canvas
          ref={canvasRef}
          className="absolute inset-0 cursor-crosshair"
          style={{ width: size.w, height: size.h }}
          role="img"
          aria-label="Speed, delta, throttle, brake and gear against distance for the compared laps"
          onPointerDown={(e) => {
            const x = localX(e);
            if (!inPlot(x) || e.button !== 0) return;
            e.currentTarget.setPointerCapture(e.pointerId);
            drag.current = { x, moved: false };
          }}
          onPointerMove={(e) => {
            const x = localX(e);
            const d = clampD(dOf(x));
            if (drag.current) {
              if (Math.abs(x - drag.current.x) > 4) drag.current.moved = true;
              if (drag.current.moved) setBrush([drag.current.x, Math.min(Math.max(x, M.left), size.w - M.right)]);
            }
            setHover(inPlot(x) ? d : null);
          }}
          onPointerUp={() => {
            if (drag.current?.moved && brush) {
              const [a, b] = [clampD(dOf(Math.min(...brush))), clampD(dOf(Math.max(...brush)))];
              if (b - a > 20) setZoom([a, b]);
            }
            drag.current = null;
            setBrush(null);
          }}
          onPointerCancel={() => {
            drag.current = null;
            setBrush(null);
          }}
          onPointerLeave={() => {
            if (!drag.current) setHover(null);
          }}
          onDoubleClick={() => setZoom(null)}
          onWheel={(e) => {
            const x = localX(e);
            if (!inPlot(x)) return;
            const at = dOf(x);
            const span = Math.min(lapLength, Math.max(60, (x1 - x0) * Math.exp(e.deltaY * 0.0015)));
            if (span >= lapLength - 1) return setZoom(null);
            const f = (at - x0) / (x1 - x0);
            let a = at - f * span;
            a = Math.min(Math.max(a, 0), lapLength - span);
            setZoom([a, a + span]);
          }}
        />
        {brush && (
          <div
            className="pointer-events-none absolute bg-zinc-200/10 ring-1 ring-zinc-400/40"
            style={{ left: Math.min(...brush), width: Math.abs(brush[1] - brush[0]), top: M.top, bottom: M.bottom }}
          />
        )}
        {tipEntries.length > 0 && hover != null && (
          <div
            className="pointer-events-none absolute top-6 z-10 min-w-44 rounded border border-zinc-700 bg-zinc-900/95 px-2 py-1.5 text-[11px] shadow-xl"
            style={tipFlip ? { right: size.w - tipLeft + 10 } : { left: tipLeft + 10 }}
          >
            <div className="mb-1 flex items-baseline justify-between gap-3 text-zinc-400">
              <span className="tabular-nums">{Math.round(hover).toLocaleString("en-US")} m</span>
              {ref && <span className="tabular-nums text-zinc-500">{(timeAtDistance(ref, hover) / 1000).toFixed(2)} s</span>}
            </div>
            <div className="grid grid-cols-[auto_auto_auto_auto_auto] items-center gap-x-2 gap-y-0.5 tabular-nums">
              {tipEntries.map((e, k) => {
                const lap = e.trace!;
                const brake = valueAtDistance(lap, "brake", hover) > 0;
                const delta = k > 0 && ref ? (timeAtDistance(lap, hover) - timeAtDistance(ref, hover)) / 1000 : null;
                return (
                  <div key={e.driver} className="contents">
                    <span className="flex items-center gap-1 font-bold text-zinc-100">
                      <Swatch color={e.style.color} dashed={e.style.dash.length > 0} />
                      {e.info.acronym}
                    </span>
                    <span className="text-right text-zinc-200">{Math.round(valueAtDistance(lap, "speed", hover))}</span>
                    <span className="text-zinc-400">G{valueAtDistance(lap, "gear", hover)}</span>
                    <span className="text-right text-zinc-400">
                      {Math.round(valueAtDistance(lap, "throttle", hover))}%{brake ? <span className="ml-1 font-semibold text-red-400">BRK</span> : null}
                    </span>
                    <span className={`text-right ${delta == null ? "text-zinc-500" : delta > 0 ? "text-red-300" : "text-emerald-300"}`}>{delta == null ? "ref" : signed(delta)}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** A short line sample in a series' colour and dash. */
export function Swatch({ color, dashed, width = 14 }: { color: string; dashed?: boolean; width?: number }) {
  return (
    <svg width={width} height="6" aria-hidden className="shrink-0">
      <line x1="1" y1="3" x2={width - 1} y2="3" stroke={color} strokeWidth="2.5" strokeLinecap="round" strokeDasharray={dashed ? "4 3" : undefined} />
    </svg>
  );
}
