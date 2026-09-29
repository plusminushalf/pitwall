import { useEffect, useRef, useState } from "react";
import type { CarSeries } from "../data/session";
import { indexAtOrBefore } from "../engine/lookup";

const MAX_SPEED = 360; // km/h at the top of the chart
const GAP_MS = 2_000; // break the trace across telemetry dropouts
const MAX_BRAKE_SPAN_MS = 1_000; // a single brake sample never paints more than this
const BRAKE_H = 3;
const FONT = "9px ui-sans-serif, system-ui, sans-serif";

function draw(canvas: HTMLCanvasElement, car: CarSeries, t: number, windowMs: number, w: number, h: number) {
  const dpr = window.devicePixelRatio || 1;
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

  const plotTop = 3;
  const plotBottom = h - BRAKE_H - 3;
  const plotH = plotBottom - plotTop;
  const from = t - windowMs;
  const xOf = (ts: number) => ((ts - from) / windowMs) * w;
  const ySpeed = (v: number) => plotBottom - (Math.min(Math.max(v, 0), MAX_SPEED) / MAX_SPEED) * plotH;
  const yThrottle = (v: number) => plotBottom - (Math.min(Math.max(v, 0), 100) / 100) * plotH;

  // Speed grid + labels, and a half-window divider.
  ctx.lineWidth = 1;
  ctx.strokeStyle = "#27272a";
  ctx.fillStyle = "#52525b";
  ctx.font = FONT;
  ctx.textBaseline = "bottom";
  for (const v of [100, 200, 300]) {
    const y = Math.round(ySpeed(v)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
    ctx.fillText(String(v), 3, y - 1);
  }
  ctx.setLineDash([2, 3]);
  ctx.beginPath();
  ctx.moveTo(Math.round(w / 2) + 0.5, plotTop);
  ctx.lineTo(Math.round(w / 2) + 0.5, plotBottom);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.strokeStyle = "#3f3f46";
  ctx.beginPath();
  ctx.moveTo(0, Math.round(plotBottom) + 0.5);
  ctx.lineTo(w, Math.round(plotBottom) + 0.5);
  ctx.stroke();

  const ts = car.t;
  const end = indexAtOrBefore(ts, t);
  if (end < 0 || ts[end] < from) return;
  const start = Math.max(0, indexAtOrBefore(ts, from));

  // Contiguous runs of samples (split at dropouts).
  const runs: [number, number][] = [];
  let runStart = start;
  for (let i = start + 1; i <= end; i++) {
    if (ts[i] - ts[i - 1] > GAP_MS) {
      runs.push([runStart, i - 1]);
      runStart = i;
    }
  }
  runs.push([runStart, end]);

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, w, h);
  ctx.clip();

  // Throttle: translucent area.
  ctx.fillStyle = "rgba(34, 197, 94, 0.22)";
  for (const [a, b] of runs) {
    if (b <= a) continue;
    ctx.beginPath();
    ctx.moveTo(xOf(ts[a]), plotBottom);
    for (let i = a; i <= b; i++) ctx.lineTo(xOf(ts[i]), yThrottle(car.throttle[i]));
    ctx.lineTo(xOf(ts[b]), plotBottom);
    ctx.closePath();
    ctx.fill();
  }

  // Brake: red marks along the bottom, one rect per continuous braking zone.
  ctx.fillStyle = "#ef4444";
  const brakeY = h - BRAKE_H;
  for (let i = start; i <= end; i++) {
    if (car.brake[i] <= 0) continue;
    const x0 = xOf(ts[i]);
    let zoneEnd = ts[i];
    while (i <= end && car.brake[i] > 0) {
      const next = i < end ? ts[i + 1] : t;
      zoneEnd = Math.min(next, ts[i] + MAX_BRAKE_SPAN_MS);
      if (next - ts[i] > MAX_BRAKE_SPAN_MS) break; // dropout: close the zone here
      i++;
    }
    ctx.fillRect(x0, brakeY, Math.max(1, xOf(zoneEnd) - x0), BRAKE_H);
  }

  // Speed: line on top.
  ctx.strokeStyle = "#f4f4f5";
  ctx.lineWidth = 1.5;
  ctx.lineJoin = "round";
  for (const [a, b] of runs) {
    if (b <= a) continue;
    ctx.beginPath();
    ctx.moveTo(xOf(ts[a]), ySpeed(car.speed[a]));
    for (let i = a + 1; i <= b; i++) ctx.lineTo(xOf(ts[i]), ySpeed(car.speed[i]));
    ctx.stroke();
  }

  ctx.restore();
}

/** Rolling chart of the last `windowMs` of speed (line), throttle (area) and braking (bottom marks). */
export function TelemetryChart({ car, t, windowMs = 60_000, height = 68 }: { car: CarSeries; t: number; windowMs?: number; height?: number }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = wrapRef.current!;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas && width > 0) draw(canvas, car, t, windowMs, width, height);
  }, [car, t, windowMs, width, height]);

  return (
    <div ref={wrapRef} className="overflow-hidden rounded bg-zinc-900/60" style={{ height }}>
      <canvas
        ref={canvasRef}
        role="img"
        aria-label={`Speed, throttle and brake over the last ${Math.round(windowMs / 1000)} seconds`}
        className="block"
        style={{ width: "100%", height }}
      />
    </div>
  );
}
