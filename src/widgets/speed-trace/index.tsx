import { useRef } from "react";
import { defineWidget, Label, useWidgetSize, useCarHistory, useDriver, useFrame, useSelectedDriver, useTime, type CarHistory, type DriverSetting } from "widget-kit";

const WINDOW_MS = 60_000;
const MAX_SPEED = 360; // km/h at the top of the chart
const GAP_MS = 2_000; // break the trace across telemetry dropouts
const MAX_BRAKE_SPAN_MS = 1_000; // a single brake sample never paints more than this
const BRAKE_H = 3;
const FONT = "9px ui-sans-serif, system-ui, sans-serif";
/** Throttle as drawn (the legend's swatch too). */
const THROTTLE_FILL = "rgba(34, 197, 94, 0.22)";
/** The chart's height, and the padding beside it (px-3). */
const CHART_H = 68;
const PAD_X = 24;
/** A line of 11 px text (the label) in a text-sm widget (line height 20/14). */
const LINE_11 = (11 * 20) / 14;

function draw(canvas: HTMLCanvasElement, car: CarHistory, t: number, w: number, h: number, dpr: number) {
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
  const from = t - WINDOW_MS;
  const xOf = (ts: number) => ((ts - from) / WINDOW_MS) * w;
  const ySpeed = (v: number) => plotBottom - (Math.min(Math.max(v, 0), MAX_SPEED) / MAX_SPEED) * plotH;
  const yThrottle = (v: number) => plotBottom - (Math.min(Math.max(v, 0), 100) / 100) * plotH;

  // Speed grid + labels, and a half-window divider.
  ctx.lineWidth = 1;
  ctx.strokeStyle = "#27272a";
  // zinc-400: text to read, not a hairline.
  ctx.fillStyle = "#9f9fa9";
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

  // The samples in the window, from the widget kit: [t - window, t].
  const ts = car.t;
  const end = ts.length - 1;
  if (end < 0) return;
  const start = 0;

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
  ctx.fillStyle = THROTTLE_FILL;
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

function Legend({ swatch, color, label }: { swatch: string; color?: string; label: string }) {
  return (
    <span className="flex items-center gap-1">
      <span className={`inline-block rounded-[1px] ${swatch}`} style={color ? { background: color } : undefined} />
      {label}
    </span>
  );
}

/** Rolling chart of the last 60 s of speed (line), throttle (area) and braking (bottom marks). */
function SpeedTrace() {
  const n = useSelectedDriver();
  const car = useCarHistory(n, WINDOW_MS);
  const t = useTime();
  const out = useDriver(n, (d) => d.status === "OUT");
  const size = useWidgetSize();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const w = size.width - PAD_X;
  const h = CHART_H;

  // Redrawn on the next animation frame, not in React's commit, and only when something changed.
  const drawn = useRef<unknown[]>([]);
  useFrame(() => {
    const canvas = canvasRef.current;
    const now = [car, t, w, h, size.pixelRatio];
    if (!canvas || w <= 0 || h <= 0 || now.every((v, i) => v === drawn.current[i])) return;
    drawn.current = now;
    draw(canvas, car, t, w, h, size.pixelRatio);
  });

  return (
    <div className={`h-full px-3 pb-2 pt-2.5 text-sm ${out ? "opacity-40" : ""}`}>
      <div className="mb-1 flex items-center justify-between">
        <Label>Last 60 s</Label>
        <span className="flex items-center gap-2.5 text-[11px] text-zinc-400">
          <Legend swatch="h-0.5 w-3 bg-zinc-100" label="Speed" />
          {/* The area's own colour, as drawn under the line. */}
          <Legend swatch="h-2.5 w-2.5" color={THROTTLE_FILL} label="Throttle" />
          <Legend swatch="h-1 w-2.5 bg-red-500" label="Brake" />
        </span>
      </div>
      <div className="overflow-hidden rounded bg-zinc-900/60" style={{ height: h }}>
        <canvas
          ref={canvasRef}
          role="img"
          aria-label="Speed, throttle and brake over the last 60 seconds"
          className="block"
          style={{ width: w, height: h }}
        />
      </div>
    </div>
  );
}

export default defineWidget({
  id: "speed-trace",
  name: "Last 60 s",
  group: "telemetry",
  description: "The last 60 seconds of the driver's speed, throttle and braking.",
  version: "1.0.0",
  // The title line and the chart, padded: pt-2.5, mb-1 and pb-2.
  height: 10 + LINE_11 + 4 + CHART_H + 8,
  width: { min: 12, default: 21, max: 60 },
  sessions: ["race", "practice", "qualifying"],
  settings: { driver: "follow-selection" as DriverSetting },
  Component: SpeedTrace,
});
