import { useEffect, useMemo, useRef, type MouseEvent } from "react";
import {
  COLUMN_WIDTH,
  defineBlock,
  teamColor,
  TRACK_STATUS,
  trackAspect,
  trackTransform,
  useBlockSize,
  useDrivers,
  useFrame,
  useLayoutPoint,
  usePositions,
  useRunningOrder,
  useSectorFlags,
  useSelection,
  useTrack,
  useTrackStatus,
  type DriverInfo,
  type SectorFlag,
  type Track,
  type TrackTransform,
} from "block-kit";

const PADDING = 56;
const HIT_RADIUS = 14;
const LABEL_H = 16;
const FLAG_COLORS: Record<SectorFlag, string> = { YELLOW: "#facc15", "DOUBLE YELLOW": "#f97316", RED: "#ef4444" };

const WIDTH = 4 * COLUMN_WIDTH;
/** Between a tall-ish and a wide box: very tall or very wide circuits are fitted with more padding. */
const MIN_SHAPE = 16 / 13; // 13 rows at 4 columns
const MAX_SHAPE = 1.6; // 10 rows

interface StaticLayer {
  canvas: HTMLCanvasElement;
  tf: TrackTransform;
  dpr: number;
}

function tracePath(ctx: CanvasRenderingContext2D, tf: TrackTransform, xs: number[], ys: number[], from = 0, to = xs.length - 1) {
  ctx.beginPath();
  for (let i = from; i <= to; i++) {
    const [px, py] = tf(xs[i], ys[i]);
    if (i === from) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
}

/** Stroke outline points from..to, wrapping past the end of the lap when to < from. */
function strokeOutlineRange(ctx: CanvasRenderingContext2D, tf: TrackTransform, track: Track, from: number, to: number) {
  const { x, y } = track.outline;
  if (to >= from) {
    tracePath(ctx, tf, x, y, from, to);
    ctx.stroke();
  } else {
    tracePath(ctx, tf, x, y, from, x.length - 1);
    const [px, py] = tf(x[0], y[0]);
    ctx.lineTo(px, py);
    ctx.stroke();
    tracePath(ctx, tf, x, y, 0, to);
    ctx.stroke();
  }
}

function drawStatic(track: Track, w: number, h: number, dpr: number): StaticLayer {
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext("2d")!;
  ctx.scale(dpr, dpr);
  const tf = trackTransform(track, w, h, PADDING);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  if (track.pitLane) {
    ctx.strokeStyle = "#52525b";
    ctx.lineWidth = 3;
    ctx.setLineDash([5, 4]);
    tracePath(ctx, tf, track.pitLane.x, track.pitLane.y);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  const { x, y } = track.outline;
  tracePath(ctx, tf, x, y);
  ctx.closePath();
  ctx.strokeStyle = "#18181b";
  ctx.lineWidth = 16;
  ctx.stroke();
  ctx.strokeStyle = "#3f3f46";
  ctx.lineWidth = 10;
  ctx.stroke();

  // Start/finish line across the track.
  const [sx, sy] = tf(x[0], y[0]);
  const [nx, ny] = tf(x[2], y[2]);
  const len = Math.hypot(nx - sx, ny - sy) || 1;
  const px = -(ny - sy) / len;
  const py = (nx - sx) / len;
  ctx.strokeStyle = "#fafafa";
  ctx.lineWidth = 3;
  ctx.lineCap = "butt";
  ctx.beginPath();
  ctx.moveTo(sx - px * 11, sy - py * 11);
  ctx.lineTo(sx + px * 11, sy + py * 11);
  ctx.stroke();

  // Timing sector boundaries.
  ctx.fillStyle = "#a1a1aa";
  ctx.font = "600 10px ui-sans-serif, system-ui";
  track.sectorMarks.forEach((m, i) => {
    const [mx, my] = tf(m.x, m.y);
    ctx.beginPath();
    ctx.arc(mx, my, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillText(`S${i + 2}`, mx + 6, my - 6);
  });

  // Corner numbers, pushed off the racing line along the circuit's label angle.
  ctx.fillStyle = "#71717a";
  ctx.font = "500 10px ui-sans-serif, system-ui";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const offset = 20 / tf.scale;
  for (const c of track.corners) {
    const a = (c.angle * Math.PI) / 180;
    const [cx, cy] = tf(c.x + offset * Math.cos(a), c.y + offset * Math.sin(a));
    ctx.fillText(String(c.number), cx, cy);
  }

  return { canvas, tf, dpr };
}

function TrackMap() {
  const track = useTrack();
  const drivers = useDrivers();
  const order = useRunningOrder();
  const positions = usePositions();
  const trackStatus = useTrackStatus();
  const sectorFlags = useSectorFlags();
  const { selected, focused, toggle } = useSelection();
  const { width: w, height: h, pixelRatio } = useBlockSize();
  const toLayout = useLayoutPoint();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const carsOnScreen = useRef<{ driver: number; x: number; y: number }[]>([]);
  const labelSlots = useRef(new Map<number, number>()); // driver -> label corner used last frame

  const layer = useMemo(() => (w > 0 && h > 0 ? drawStatic(track, w, h, pixelRatio) : null), [track, w, h, pixelRatio]);
  const info = useMemo(() => new Map<number, DriverInfo>(drivers.map((d) => [d.number, d])), [drivers]);
  // What the per-frame draw reads, updated at the hooks' rate.
  const latest = useRef({ order, positions, trackStatus, sectorFlags, selected, focused, info });
  latest.current = { order, positions, trackStatus, sectorFlags, selected, focused, info };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !layer) return;
    canvas.width = layer.canvas.width;
    canvas.height = layer.canvas.height;
  }, [layer]);

  useFrame((frame) => {
    const canvas = canvasRef.current;
    if (!canvas || !layer || canvas.width !== layer.canvas.width) return;
    const ctx = canvas.getContext("2d")!;
    const { order: running, positions, trackStatus, sectorFlags, selected, focused, info } = latest.current;
    const { tf, dpr } = layer;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(layer.canvas, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineJoin = "round";
    ctx.lineCap = "round";

    const tint = trackStatus === "RED" ? "#ef4444" : trackStatus.includes("SC") ? "#fbbf24" : null;
    if (tint) {
      ctx.globalAlpha = 0.45;
      ctx.strokeStyle = tint;
      ctx.lineWidth = 4;
      tracePath(ctx, tf, track.outline.x, track.outline.y);
      ctx.closePath();
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    ctx.lineWidth = 6;
    for (const [sector, flag] of sectorFlags) {
      const range = track.marshalSectors.find((m) => m.number === sector);
      if (!range) continue;
      ctx.strokeStyle = FLAG_COLORS[flag];
      strokeOutlineRange(ctx, tf, track, range.from, range.to);
    }

    // Draw back-markers first so the leader (and the focused car) end up on top.
    // With a selection, only the selected cars are drawn.
    const shown = selected.length > 0 ? new Set(selected) : null;
    const order = [...running].reverse().filter((n) => shown?.has(n) ?? true);
    const drawOrder = focused != null && order.includes(focused) ? [...order.filter((n) => n !== focused), focused] : order;
    const onScreen: { driver: number; x: number; y: number }[] = [];
    const cars: { n: number; d: DriverInfo; cx: number; cy: number; alpha: number }[] = [];

    for (const n of drawOrder) {
      const d = info.get(n);
      const p = d && frame.car(n);
      if (!d || !p) continue;
      const [cx, cy] = tf(p.x, p.y);
      const isFocused = n === focused;
      ctx.globalAlpha = p.opacity;
      onScreen.push({ driver: n, x: cx, y: cy });
      cars.push({ n, d, cx, cy, alpha: p.opacity });

      if (isFocused) {
        ctx.strokeStyle = "#fafafa";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(cx, cy, 11, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.fillStyle = teamColor(d.teamColour);
      ctx.strokeStyle = "#09090b";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(cx, cy, isFocused ? 7.5 : 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    // Labels in priority order (focused car, then the leader down), each in the first corner
    // around its dot that doesn't overlap a label already placed; cars in a tight pack may go unlabelled.
    ctx.font = "700 11px ui-sans-serif, system-ui";
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    const placed: { x: number; y: number; w: number }[] = [];
    const fits = (x: number, y: number, lw: number) =>
      x >= 0 &&
      y >= 0 &&
      x + lw <= w &&
      y + LABEL_H <= h &&
      placed.every((r) => x + lw + 2 <= r.x || r.x + r.w + 2 <= x || y + LABEL_H + 2 <= r.y || r.y + LABEL_H + 2 <= y);
    for (let i = cars.length - 1; i >= 0; i--) {
      const { n, d, cx, cy, alpha } = cars[i];
      const isFocused = n === focused;
      const pos = positions.get(n);
      const label = d.acronym;
      const prefix = pos != null ? `${pos} ` : "";
      const prefixW = ctx.measureText(prefix).width;
      const labelW = prefixW + ctx.measureText(label).width + 10;
      // Corners: 0 above right, 1 below right, 2 above left, 3 below left.
      const corner = (k: number): [number, number] => [k < 2 ? cx + 10 : cx - 10 - labelW, k % 2 === 0 ? cy - 19 : cy + 3];
      // Try last frame's corner first so labels don't flicker between corners.
      const previous = labelSlots.current.get(n) ?? 0;
      let slot = [previous, 0, 1, 2, 3].find((k) => fits(...corner(k), labelW));
      if (slot == null) {
        if (!isFocused) continue;
        slot = previous;
      }
      const [lx, top] = corner(slot);
      labelSlots.current.set(n, slot);
      placed.push({ x: lx, y: top, w: labelW });

      const ly = top + LABEL_H / 2;
      ctx.globalAlpha = alpha;
      ctx.fillStyle = isFocused ? "rgba(250,250,250,0.95)" : "rgba(9,9,11,0.8)";
      ctx.beginPath();
      ctx.roundRect(lx, top, labelW, LABEL_H, 3);
      ctx.fill();
      ctx.fillStyle = teamColor(d.teamColour);
      ctx.fillRect(lx, top, 2.5, LABEL_H);
      ctx.fillStyle = isFocused ? "#52525b" : "#a1a1aa";
      ctx.fillText(prefix, lx + 6, ly + 0.5);
      ctx.fillStyle = isFocused ? "#09090b" : "#fafafa";
      ctx.fillText(label, lx + 6 + prefixW, ly + 0.5);
    }
    ctx.globalAlpha = 1;
    carsOnScreen.current = onScreen;
  });

  const onClick = (e: MouseEvent<HTMLCanvasElement>) => {
    const { x: mx, y: my } = toLayout(e);
    let best: { driver: number; d: number } | null = null;
    for (const c of carsOnScreen.current) {
      const d = Math.hypot(c.x - mx, c.y - my);
      if (d <= HIT_RADIUS && (!best || d < best.d)) best = { driver: c.driver, d };
    }
    // Toggle the car in the selection; clicks on empty track leave the selection alone.
    if (best) toggle(best.driver);
  };

  const banner = trackStatus !== "GREEN" ? TRACK_STATUS[trackStatus] : null;

  return (
    <div className="relative h-full w-full overflow-hidden">
      <canvas ref={canvasRef} onClick={onClick} className="absolute inset-0 cursor-crosshair" style={{ width: w, height: h }} />
      {banner && (
        <div className={`absolute left-1/2 top-3 -translate-x-1/2 rounded px-4 py-1 text-sm font-bold uppercase tracking-wider shadow-lg ${banner.className}`}>
          {banner.label}
        </div>
      )}
    </div>
  );
}

export default defineBlock({
  id: "track-map",
  name: "Track map",
  version: "1.0.0",
  // The outline fitted inside the padding, kept between MIN_SHAPE and MAX_SHAPE.
  shape: ({ track }) => {
    const fitted = WIDTH / ((WIDTH - 2 * PADDING) / trackAspect(track) + 2 * PADDING);
    return Math.min(Math.max(fitted, MIN_SHAPE), MAX_SHAPE);
  },
  width: { min: 3, default: 4, max: 6 },
  sessions: ["race"],
  settings: {},
  Component: TrackMap,
});
