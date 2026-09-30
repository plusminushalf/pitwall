import { useLayoutEffect, useMemo, useRef, type MouseEvent } from "react";
import {
  defineBlock,
  teamColor,
  TRACK_STATUS,
  trackTransform,
  useBlockSize,
  useDrivers,
  useFrame,
  usePositions,
  useRunningOrder,
  useSectorFlags,
  useSelection,
  useTrack,
  useTrackStatus,
  type DriverInfo,
  type SectorFlag,
  type Track,
  type TrackStatus,
  type TrackTransform,
} from "block-kit";

const PADDING = 56;
const HIT_RADIUS = 14;
const LABEL_H = 16;
const FLAG_COLORS: Record<SectorFlag, string> = { YELLOW: "#facc15", "DOUBLE YELLOW": "#f97316", RED: "#ef4444" };
/** The car layer redraws only the boxes around cars that changed, unless they cover more than this share of it. */
const MAX_DIRTY_SHARE = 0.5;
/** A label that had to be hidden stays hidden at least this long (wall-clock ms), so it can't blink off and on. */
const LABEL_REST_MS = 200;

interface StaticLayer {
  canvas: HTMLCanvasElement;
  tf: TrackTransform;
  dpr: number;
}

/** A car as drawn on the car layer, in CSS px. */
interface DrawnCar {
  n: number;
  color: string;
  cx: number;
  cy: number;
  alpha: number;
  focused: boolean;
  label: { x: number; y: number; w: number; prefix: string; prefixW: number; text: string } | null;
  /** Device-px boxes around the dot and the label (see footprint()). */
  parts: [Box | null, Box | null];
}

/** What the car layer shows, to skip frames where nothing changed and to find what to redraw. */
interface Drawn {
  layer: StaticLayer;
  inputs: readonly unknown[];
  cars: DrawnCar[];
  byDriver: Map<number, DrawnCar>;
  /** A label was held back by LABEL_REST_MS: redraw until it's placed, even when nothing moves. */
  resting: boolean;
}

/** Device-px box [x0, y0, x1, y1]. */
type Box = [number, number, number, number];

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

/** The track layer: the static drawing plus the track-status tint and the sector flags. */
function drawTrackLayer(
  canvas: HTMLCanvasElement,
  layer: StaticLayer,
  track: Track,
  trackStatus: TrackStatus,
  sectorFlags: ReadonlyMap<number, SectorFlag>,
) {
  if (canvas.width !== layer.canvas.width) canvas.width = layer.canvas.width;
  if (canvas.height !== layer.canvas.height) canvas.height = layer.canvas.height;
  const ctx = canvas.getContext("2d")!;
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
}

function sameCar(a: DrawnCar, b: DrawnCar): boolean {
  if (a.cx !== b.cx || a.cy !== b.cy || a.alpha !== b.alpha || a.focused !== b.focused || a.color !== b.color) return false;
  const la = a.label;
  const lb = b.label;
  if (!la || !lb) return la === lb;
  return la.x === lb.x && la.y === lb.y && la.w === lb.w && la.prefix === lb.prefix && la.text === lb.text;
}

const overlaps = (a: Box, b: Box) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
const contains = (a: Box, b: Box) => a[0] <= b[0] && a[1] <= b[1] && b[2] <= a[2] && b[3] <= a[3];

/**
 * Whole device px around each part of car c the map paints, with room for antialiasing (null when off
 * the canvas): the dot and focus ring, and the label.
 */
function footprint(c: DrawnCar, dpr: number, width: number, height: number): DrawnCar["parts"] {
  const box = (x0: number, y0: number, x1: number, y1: number): Box | null => {
    const b: Box = [Math.max(0, Math.floor(x0 * dpr)), Math.max(0, Math.floor(y0 * dpr)), Math.min(width, Math.ceil(x1 * dpr)), Math.min(height, Math.ceil(y1 * dpr))];
    return b[0] < b[2] && b[1] < b[3] ? b : null;
  };
  const r = c.focused ? 13 : 8;
  const l = c.label;
  return [box(c.cx - r, c.cy - r, c.cx + r, c.cy + r), l ? box(l.x - 2, l.y - 2, l.x + l.w + 2, l.y + LABEL_H + 2) : null];
}

/** Adds b to disjoint boxes, merging it with every box it overlaps (transitively). */
function addBox(boxes: Box[], b: Box) {
  for (let i = 0; i < boxes.length; ) {
    if (overlaps(boxes[i], b)) {
      const o = boxes[i];
      b = [Math.min(o[0], b[0]), Math.min(o[1], b[1]), Math.max(o[2], b[2]), Math.max(o[3], b[3])];
      boxes.splice(i, 1);
      i = 0;
    } else i++;
  }
  boxes.push(b);
}

/**
 * The boxes to clear and redraw: around what changed, grown until every part (dot or label) they touch
 * lies wholly inside one. Parts are then drawn whole with no clip, so the pixels match a full redraw.
 */
function dirtyBoxes(before: Drawn, cars: DrawnCar[]): Box[] {
  const boxes: Box[] = [];
  for (const c of cars) {
    const b = before.byDriver.get(c.n)!;
    if (sameCar(b, c)) continue;
    for (const p of [...b.parts, ...c.parts]) if (p) addBox(boxes, p);
  }
  for (let grew = boxes.length > 0; grew; ) {
    grew = false;
    for (const c of cars)
      for (const p of c.parts)
        if (p && boxes.some((b) => overlaps(b, p)) && !boxes.some((b) => contains(b, p))) {
          addBox(boxes, p);
          grew = true;
        }
  }
  return boxes;
}

/** Dots in draw order, then labels in priority order (the reverse), as the map always drew them; only parts in `within`. */
function drawCars(ctx: CanvasRenderingContext2D, cars: DrawnCar[], dpr: number, within: Box[] | null) {
  const hits = (p: Box | null) => p != null && (!within || within.some((b) => overlaps(b, p)));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  for (const c of cars) {
    if (!hits(c.parts[0])) continue;
    ctx.globalAlpha = c.alpha;
    if (c.focused) {
      ctx.strokeStyle = "#fafafa";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(c.cx, c.cy, 11, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.fillStyle = c.color;
    ctx.strokeStyle = "#09090b";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(c.cx, c.cy, c.focused ? 7.5 : 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  ctx.font = "700 11px ui-sans-serif, system-ui";
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  for (let i = cars.length - 1; i >= 0; i--) {
    const c = cars[i];
    const l = c.label;
    if (!l || !hits(c.parts[1])) continue;
    const ly = l.y + LABEL_H / 2;
    ctx.globalAlpha = c.alpha;
    ctx.fillStyle = c.focused ? "rgba(250,250,250,0.95)" : "rgba(9,9,11,0.8)";
    ctx.beginPath();
    ctx.roundRect(l.x, l.y, l.w, LABEL_H, 3);
    ctx.fill();
    ctx.fillStyle = c.color;
    ctx.fillRect(l.x, l.y, 2.5, LABEL_H);
    ctx.fillStyle = c.focused ? "#52525b" : "#a1a1aa";
    ctx.fillText(l.prefix, l.x + 6, ly + 0.5);
    ctx.fillStyle = c.focused ? "#09090b" : "#fafafa";
    ctx.fillText(l.text, l.x + 6 + l.prefixW, ly + 0.5);
  }
  ctx.globalAlpha = 1;
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
  const trackRef = useRef<HTMLCanvasElement>(null);
  const carsRef = useRef<HTMLCanvasElement>(null);
  const carsOnScreen = useRef<{ driver: number; x: number; y: number }[]>([]);
  const labelSlots = useRef(new Map<number, number>()); // driver -> label corner used last frame
  const hiddenAt = useRef(new Map<number, number>()); // driver -> when its label last had to be hidden
  const drawn = useRef<Drawn | null>(null);

  const layer = useMemo(() => (w > 0 && h > 0 ? drawStatic(track, w, h, pixelRatio) : null), [track, w, h, pixelRatio]);
  const info = useMemo(() => new Map<number, DriverInfo>(drivers.map((d) => [d.number, d])), [drivers]);
  // What the per-frame draw reads, updated at the hooks' rate.
  const latest = useRef({ order, positions, selected, focused, info });
  latest.current = { order, positions, selected, focused, info };

  // The bottom canvas changes only with the size, the track, the track status and the sector flags.
  useLayoutEffect(() => {
    if (trackRef.current && layer) drawTrackLayer(trackRef.current, layer, track, trackStatus, sectorFlags);
  }, [layer, track, trackStatus, sectorFlags]);

  useFrame((frame) => {
    const canvas = carsRef.current;
    if (!canvas || !layer) return;
    const { tf, dpr } = layer;
    let last = drawn.current;
    if (canvas.width !== layer.canvas.width || canvas.height !== layer.canvas.height) {
      canvas.width = layer.canvas.width;
      canvas.height = layer.canvas.height;
      last = null;
    }
    if (last && last.layer !== layer) last = null;
    const { order: running, positions, selected, focused, info } = latest.current;
    const inputs = [running, positions, selected, focused, info];
    let changed = !last || last.resting || inputs.some((v, i) => v !== last.inputs[i]);

    // Draw back-markers first so the leader (and the focused car) end up on top.
    // With a selection, only the selected cars are drawn.
    const shown = selected.length > 0 ? new Set(selected) : null;
    const order = [...running].reverse().filter((n) => shown?.has(n) ?? true);
    const drawOrder = focused != null && order.includes(focused) ? [...order.filter((n) => n !== focused), focused] : order;

    // Every car at its exact position, every frame: holding back sub-pixel moves makes dots stutter.
    const cars: DrawnCar[] = [];
    for (const n of drawOrder) {
      const d = info.get(n);
      const p = d && frame.car(n);
      if (!d || !p) continue;
      const [cx, cy] = tf(p.x, p.y);
      const before = last?.byDriver.get(n);
      if (!before || cx !== before.cx || cy !== before.cy || before.alpha !== p.opacity) changed = true;
      cars.push({ n, color: teamColor(d.teamColour), cx, cy, alpha: p.opacity, focused: n === focused, label: null, parts: [null, null] });
    }
    // Nothing moved, appeared or disappeared, and the inputs are the same: the layer is up to date.
    if (!changed && cars.length === last!.cars.length) return;

    const ctx = canvas.getContext("2d")!;
    // Labels in priority order (focused car, then the leader down), each in the first corner
    // around its dot that doesn't overlap a label already placed; cars in a tight pack may go unlabelled.
    ctx.font = "700 11px ui-sans-serif, system-ui";
    const placed: { x: number; y: number; w: number }[] = [];
    const now = performance.now();
    let resting = false;
    // Inside the canvas and at least `gap` px clear of every label placed so far.
    const fits = (x: number, y: number, lw: number, gap: number) =>
      x >= 0 &&
      y >= 0 &&
      x + lw <= w &&
      y + LABEL_H <= h &&
      placed.every((r) => x + lw + gap <= r.x || r.x + r.w + gap <= x || y + LABEL_H + gap <= r.y || r.y + LABEL_H + gap <= y);
    for (let i = cars.length - 1; i >= 0; i--) {
      const car = cars[i];
      const { n, cx, cy } = car;
      const pos = positions.get(n);
      const text = info.get(n)!.acronym;
      const prefix = pos != null ? `${pos} ` : "";
      const prefixW = ctx.measureText(prefix).width;
      const labelW = prefixW + ctx.measureText(text).width + 10;
      // Corners: 0 above right, 1 below right, 2 above left, 3 below left.
      const corner = (k: number): [number, number] => [k < 2 ? cx + 10 : cx - 10 - labelW, k % 2 === 0 ? cy - 19 : cy + 3];
      // So labels don't blink: a label drawn last frame keeps its corner until it would overlap a label
      // placed before it, while placing a label, or moving one, needs a 2 px gap (last frame's corner
      // first); and a label that had to be hidden stays hidden for LABEL_REST_MS.
      const previous = labelSlots.current.get(n) ?? 0;
      const shownBefore = last?.byDriver.get(n)?.label != null;
      if (!shownBefore && !car.focused && now - (hiddenAt.current.get(n) ?? -Infinity) < LABEL_REST_MS) {
        resting = true;
        continue;
      }
      const kept = shownBefore && fits(...corner(previous), labelW, 0);
      let slot = kept ? previous : [previous, 0, 1, 2, 3].find((k) => fits(...corner(k), labelW, 2));
      if (slot == null) {
        if (!car.focused) {
          if (shownBefore) hiddenAt.current.set(n, now);
          continue;
        }
        slot = previous;
      }
      const [lx, top] = corner(slot);
      labelSlots.current.set(n, slot);
      placed.push({ x: lx, y: top, w: labelW });
      car.label = { x: lx, y: top, w: labelW, prefix, prefixW, text };
    }

    for (const c of cars) c.parts = footprint(c, dpr, canvas.width, canvas.height);
    const byDriver = new Map(cars.map((c) => [c.n, c]));
    // Redraw everything when the stacking may have changed (or there's nothing to go on).
    const restack = !last || last.cars.length !== cars.length || last.cars.some((c, i) => c.n !== cars[i].n);
    let boxes = last && !restack ? dirtyBoxes(last, cars) : null;
    if (boxes && boxes.reduce((sum, b) => sum + (b[2] - b[0]) * (b[3] - b[1]), 0) > MAX_DIRTY_SHARE * canvas.width * canvas.height) boxes = null;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (boxes) for (const b of boxes) ctx.clearRect(b[0], b[1], b[2] - b[0], b[3] - b[1]);
    else ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!boxes || boxes.length > 0) drawCars(ctx, cars, dpr, boxes);
    drawn.current = { layer, inputs, cars, byDriver, resting };
    carsOnScreen.current = cars.map((c) => ({ driver: c.n, x: c.cx, y: c.cy }));
  });

  const onClick = (e: MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    let best: { driver: number; d: number } | null = null;
    for (const c of carsOnScreen.current) {
      const d = Math.hypot(c.x - mx, c.y - my);
      if (d <= HIT_RADIUS && (!best || d < best.d)) best = { driver: c.driver, d };
    }
    // Toggle the car in the selection; clicks on empty track leave the selection alone.
    if (best) toggle(best.driver);
  };

  const banner = trackStatus !== "GREEN" ? TRACK_STATUS[trackStatus] : null;

  // Two canvases: the track (redrawn rarely) under the cars and labels (redrawn as they move).
  return (
    <div className="relative h-full w-full overflow-hidden">
      <canvas ref={trackRef} className="pointer-events-none absolute inset-0" style={{ width: w, height: h }} />
      <canvas ref={carsRef} onClick={onClick} className="absolute inset-0 cursor-crosshair" style={{ width: w, height: h }} />
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
  // Fills its column; the circuit is fitted inside, whatever the box's shape.
  height: { min: 200 },
  width: { min: 20, default: 55, max: 80 },
  sessions: ["race"],
  settings: {},
  Component: TrackMap,
});
