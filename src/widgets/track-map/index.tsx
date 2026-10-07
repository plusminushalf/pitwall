import { useLayoutEffect, useMemo, useRef, type PointerEvent } from "react";
import {
  defineWidget,
  drawCornerLabels,
  teamColor,
  TRACK_STATUS,
  trackTransform,
  useWidgetSize,
  useDrivers,
  useFrame,
  usePositions,
  useRunningOrder,
  useSectorFlags,
  useSelection,
  useSettings,
  useTrack,
  useTrackStatus,
  type DriverInfo,
  type SectorFlag,
  type Track,
  type TrackStatus,
  type TrackTransform,
} from "widget-kit";
import { labelOrder, stackOrder } from "./stacking";

const PADDING = 56;
const HIT_RADIUS = 14;
/** A fingertip's reach on a touch screen. */
const TOUCH_HIT_RADIUS = 24;
/** A press that moves further than this before lifting is a drag (a scroll), not a tap. */
const TAP_SLOP = 8;
const LABEL_H = 16;
const FLAG_COLORS: Record<SectorFlag, string> = { YELLOW: "#facc15", "DOUBLE YELLOW": "#f97316", RED: "#ef4444" };
/** The car layer redraws only the boxes around cars that changed, unless they cover more than this share of it. */
const MAX_DIRTY_SHARE = 0.5;
/** A label that had to be hidden stays hidden at least this long (wall-clock ms), so it can't blink off and on. */
const LABEL_REST_MS = 200;
/** A label that appears, or takes another corner, fades in over this long (wall-clock ms). */
const LABEL_FADE_IN_MS = 150;
/** A label that goes away, or leaves a corner, fades out there over this long (wall-clock ms). */
const LABEL_FADE_OUT_MS = 150;
/**
 * Dots closer than this (CSS px, centre to centre) overlap, so which is on top shows: they keep their stacking
 * while the running order says otherwise, until they part or for this long at most (wall-clock ms).
 */
const STACK_OVERLAP = 15;
const STACK_HOLD_MS = 2_000;
/** In the pit lane a dot (and focus ring) is this much smaller in radius, CSS px, and half as opaque ... */
const PIT_SHRINK = 1.5;
const PIT_OPACITY = 0.5;
/**
 * ... changing over this long (wall-clock ms) as the car enters or leaves the pit lane; a car moves onto
 * and off the drawn pit lane over as long (so where the location feed and the pit times disagree, it slides).
 */
const PIT_MS = 200;
/**
 * The pit lane is drawn at least this far from the track's centre line (CSS px): the track's half-width
 * (8), a 1 px gap and the pit lane's half-width (4). It runs within a few metres of the track, under it.
 */
const PIT_CLEAR = 13;
/** Pushed out to PIT_CLEAR gradually over this much of each end of the lane (CSS px, at most a quarter of it). */
const PIT_TAPER = 40;

/** cornerNames: corner names next to their numbers, where the circuit's corners have names. */
type Settings = { cornerNames: boolean };

interface StaticLayer {
  canvas: HTMLCanvasElement;
  tf: TrackTransform;
  dpr: number;
  pit: PitLane | null;
}

/** The pit lane on the map, CSS px. */
interface PitLane {
  /** Its points where the track transform puts them: where cars in the pit lane are. */
  x: number[];
  y: number[];
  /** How far each point is moved to draw the lane clear of the track (0 at both ends). */
  dx: number[];
  dy: number[];
}

/** A car's label as drawn, in CSS px. */
interface Label {
  x: number;
  y: number;
  w: number;
  prefix: string;
  prefixW: number;
  text: string;
  /** The corner around the dot (see labelAt()). */
  slot: number;
  /** Opacity this frame, 0-1, times the car's own. */
  alpha: number;
  /** Wall-clock ms (frame.now) when a placed label is fully faded in, or a fading-out one is gone. */
  until: number;
}

/** A car as drawn on the car layer, in CSS px. */
interface DrawnCar {
  n: number;
  color: string;
  cx: number;
  cy: number;
  alpha: number;
  focused: boolean;
  /** The dot's pit-lane look: 0 on track, 1 in the pit lane. */
  pit: Ease;
  /** How far the car is moved onto the pit lane as drawn: 0 not, 1 all the way (on the lane's stretch). */
  lane: Ease;
  /** The label placed this frame (maybe still fading in), or null. */
  label: Label | null;
  /**
   * Labels fading out at corners the label left (at most one per corner, so they never overlap each
   * other): they aren't placed, so they widget no label, and they're drawn under the placed ones.
   */
  ghosts: Label[];
  /** Device-px boxes around the dot, the label, then each ghost (see footprint()). */
  parts: (Box | null)[];
}

/** What the car layer shows, to skip frames where nothing changed and to find what to redraw. */
interface Drawn {
  layer: StaticLayer;
  inputs: readonly unknown[];
  cars: DrawnCar[];
  byDriver: Map<number, DrawnCar>;
  /** A label was held back by LABEL_REST_MS: redraw until it's placed, even when nothing moves. */
  resting: boolean;
  /** A label is fading in or out, or a dot changing to or from its pit-lane look: redraw until it's done, even when nothing moves (paused). */
  animating: boolean;
}

/** Device-px box [x0, y0, x1, y1]. */
type Box = [number, number, number, number];

/** A value a car eases to 1 while `on`, and back to 0 when not, over PIT_MS of wall clock. */
interface Ease {
  on: boolean;
  /** This frame's value, 0-1. */
  v: number;
  /** Wall-clock ms (frame.now) when v gets to where `on` sends it. */
  until: number;
}

/** From where it was (`was`, last frame), or already there for a car that just appeared. */
function ease(on: boolean, was: Ease | undefined, now: number): Ease {
  const until = !was ? now : was.on === on ? was.until : now + (on ? 1 - was.v : was.v) * PIT_MS;
  const left = Math.max(0, until - now) / PIT_MS;
  return { on, v: on ? 1 - left : left, until };
}

/** Top-left of a label w wide in corner k of the dot at (cx, cy): 0 above right, 1 below right, 2 above left, 3 below left. */
const labelAt = (cx: number, cy: number, w: number, k: number): [number, number] => [k < 2 ? cx + 10 : cx - 10 - w, k % 2 === 0 ? cy - 19 : cy + 3];

/** Label l in its corner of the dot at (cx, cy), with opacity alpha. */
function follow(l: Label, cx: number, cy: number, alpha: number): Label {
  const [x, y] = labelAt(cx, cy, l.w, l.slot);
  return { ...l, x, y, alpha };
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

const smoothstep = (u: number) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));

/**
 * The pit lane, and how to move it clear of the track: each point goes out along the track's normal, on
 * the side most of the lane is on, to PIT_CLEAR from the centre line (points already farther stay), easing
 * in from 0 over PIT_TAPER at both ends so it branches off the track and rejoins it without a kink. A lane
 * that can't be right (under 10 px long, or over a third of the lap) is drawn where it is.
 */
function pitLaneOf(track: Track, tf: TrackTransform): PitLane | null {
  if (!track.pitLane) return null;
  const x: number[] = [];
  const y: number[] = [];
  const s: number[] = [];
  const { x: px, y: py } = track.pitLane;
  for (let i = 0; i < px.length; i++) {
    const [sx, sy] = tf(px[i], py[i]);
    // One point per half px (a car standing in its box is many samples in one place), and the last one.
    const step = x.length ? Math.hypot(sx - x[x.length - 1], sy - y[y.length - 1]) : 0;
    if (x.length && step < 0.5 && i < px.length - 1) continue;
    x.push(sx);
    y.push(sy);
    s.push(s.length ? s[s.length - 1] + step : 0);
  }
  const len = s[s.length - 1];
  if (len < 10) return null;
  const dx = new Array<number>(x.length).fill(0);
  const dy = new Array<number>(x.length).fill(0);
  const ox: number[] = [];
  const oy: number[] = [];
  let lap = 0;
  for (let i = 0; i < track.outline.x.length; i++) {
    const [sx, sy] = tf(track.outline.x[i], track.outline.y[i]);
    if (i > 0) lap += Math.hypot(sx - ox[i - 1], sy - oy[i - 1]);
    ox.push(sx);
    oy.push(sy);
  }
  if (len > lap / 3) return { x, y, dx, dy };
  // Each point's distance from the centre line, its side of it (+1 or -1) and the normal towards +1.
  const near = x.map((_, i) => {
    let best = { d: Infinity, side: 0, nx: 0, ny: 0 };
    for (let j = 0; j < ox.length; j++) {
      const k = (j + 1) % ox.length;
      const ex = ox[k] - ox[j];
      const ey = oy[k] - oy[j];
      const l = Math.hypot(ex, ey);
      if (l === 0) continue;
      const u = Math.max(0, Math.min(1, ((x[i] - ox[j]) * ex + (y[i] - oy[j]) * ey) / (l * l)));
      const d = Math.hypot(x[i] - ox[j] - u * ex, y[i] - oy[j] - u * ey);
      if (d < best.d) best = { d, side: ex * (y[i] - oy[j]) - ey * (x[i] - ox[j]) >= 0 ? 1 : -1, nx: -ey / l, ny: ex / l };
    }
    return best;
  });
  // The side most of the lane is on, so points near the centre line can't flip it.
  const side = near.reduce((sum, p) => sum + p.side, 0) >= 0 ? 1 : -1;
  const taper = Math.min(PIT_TAPER, len / 4);
  for (let i = 0; i < x.length; i++) {
    const p = near[i];
    const push = Math.max(0, PIT_CLEAR - p.side * side * p.d) * smoothstep(Math.min(s[i], len - s[i]) / taper);
    dx[i] = side * p.nx * push;
    dy[i] = side * p.ny * push;
  }
  return { x, y, dx, dy };
}

/** Where a car at (x, y) on the pit lane's stretch is drawn: moved k (0-1) of the way the nearest point of the lane is, so it rides the drawn lane. */
function onPitLane(pit: PitLane, x: number, y: number, k: number): [number, number] {
  let best = Infinity;
  let mx = 0;
  let my = 0;
  for (let i = 0; i + 1 < pit.x.length; i++) {
    const ex = pit.x[i + 1] - pit.x[i];
    const ey = pit.y[i + 1] - pit.y[i];
    const l2 = ex * ex + ey * ey;
    const u = l2 > 0 ? Math.max(0, Math.min(1, ((x - pit.x[i]) * ex + (y - pit.y[i]) * ey) / l2)) : 0;
    const d = (x - pit.x[i] - u * ex) ** 2 + (y - pit.y[i] - u * ey) ** 2;
    if (d < best) {
      best = d;
      mx = pit.dx[i] + u * (pit.dx[i + 1] - pit.dx[i]);
      my = pit.dy[i] + u * (pit.dy[i + 1] - pit.dy[i]);
    }
  }
  return [x + k * mx, y + k * my];
}

function drawStatic(track: Track, w: number, h: number, dpr: number, names: boolean): StaticLayer {
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext("2d")!;
  ctx.scale(dpr, dpr);
  const tf = trackTransform(track, w, h, PADDING);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  // The pit lane, under the track: a small, muted version of it.
  const pit = pitLaneOf(track, tf);
  if (pit) {
    ctx.beginPath();
    for (let i = 0; i < pit.x.length; i++) {
      if (i === 0) ctx.moveTo(pit.x[i] + pit.dx[i], pit.y[i] + pit.dy[i]);
      else ctx.lineTo(pit.x[i] + pit.dx[i], pit.y[i] + pit.dy[i]);
    }
    ctx.strokeStyle = "#18181b";
    ctx.lineWidth = 8;
    ctx.stroke();
    ctx.strokeStyle = "#27272a";
    ctx.lineWidth = 4;
    ctx.stroke();
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

  // Corner numbers (and names, by setting): zinc-400, text to read.
  drawCornerLabels(ctx, tf, track.corners, w, { offset: 20, size: 10, color: "#9f9fa9", background: "#09090b", names });

  return { canvas, tf, dpr, pit };
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

function sameLabel(a: Label | null, b: Label | null): boolean {
  if (!a || !b) return a === b;
  return a.x === b.x && a.y === b.y && a.w === b.w && a.prefix === b.prefix && a.text === b.text && a.alpha === b.alpha;
}

function sameCar(a: DrawnCar, b: DrawnCar): boolean {
  if (a.cx !== b.cx || a.cy !== b.cy || a.alpha !== b.alpha || a.pit.v !== b.pit.v || a.focused !== b.focused || a.color !== b.color) return false;
  return sameLabel(a.label, b.label) && a.ghosts.length === b.ghosts.length && a.ghosts.every((g, i) => sameLabel(g, b.ghosts[i]));
}

const overlaps = (a: Box, b: Box) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
const contains = (a: Box, b: Box) => a[0] <= b[0] && a[1] <= b[1] && b[2] <= a[2] && b[3] <= a[3];

/**
 * Whole device px around each part of car c the map paints, with room for antialiasing (null when off
 * the canvas): the dot and focus ring (at their full size, which covers the pit-lane one), the label, and
 * the labels fading out.
 */
function footprint(c: DrawnCar, dpr: number, width: number, height: number): DrawnCar["parts"] {
  const box = (x0: number, y0: number, x1: number, y1: number): Box | null => {
    const b: Box = [Math.max(0, Math.floor(x0 * dpr)), Math.max(0, Math.floor(y0 * dpr)), Math.min(width, Math.ceil(x1 * dpr)), Math.min(height, Math.ceil(y1 * dpr))];
    return b[0] < b[2] && b[1] < b[3] ? b : null;
  };
  const around = (l: Label | null) => (l ? box(l.x - 2, l.y - 2, l.x + l.w + 2, l.y + LABEL_H + 2) : null);
  const r = c.focused ? 13 : 8;
  return [box(c.cx - r, c.cy - r, c.cx + r, c.cy + r), around(c.label), ...c.ghosts.map(around)];
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

/** Label l of car c, its opacity times the car's. */
function drawLabel(ctx: CanvasRenderingContext2D, c: DrawnCar, l: Label) {
  const ly = l.y + LABEL_H / 2;
  ctx.globalAlpha = c.alpha * l.alpha;
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

/**
 * Dots in draw order, then labels fading out, then placed labels, both in priority order (the reverse),
 * so every label shown in full is on top; only parts in `within`.
 */
function drawCars(ctx: CanvasRenderingContext2D, cars: DrawnCar[], dpr: number, within: Box[] | null) {
  const hits = (p: Box | null) => p != null && (!within || within.some((b) => overlaps(b, p)));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  for (const c of cars) {
    if (!hits(c.parts[0])) continue;
    // Smaller and fainter in the pit lane (the label stays as it is).
    const shrink = PIT_SHRINK * c.pit.v;
    ctx.globalAlpha = c.alpha * (1 - (1 - PIT_OPACITY) * c.pit.v);
    if (c.focused) {
      ctx.strokeStyle = "#fafafa";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(c.cx, c.cy, 11 - shrink, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.fillStyle = c.color;
    ctx.strokeStyle = "#09090b";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(c.cx, c.cy, (c.focused ? 7.5 : 6) - shrink, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  ctx.font = "700 11px ui-sans-serif, system-ui";
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  for (let i = cars.length - 1; i >= 0; i--) {
    const c = cars[i];
    for (let j = 0; j < c.ghosts.length; j++) if (hits(c.parts[2 + j])) drawLabel(ctx, c, c.ghosts[j]);
  }
  for (let i = cars.length - 1; i >= 0; i--) {
    const c = cars[i];
    if (c.label && hits(c.parts[1])) drawLabel(ctx, c, c.label);
  }
  ctx.globalAlpha = 1;
}

function TrackMap() {
  const [{ cornerNames }] = useSettings<Settings>();
  const track = useTrack();
  const drivers = useDrivers();
  const order = useRunningOrder();
  const positions = usePositions();
  const trackStatus = useTrackStatus();
  const sectorFlags = useSectorFlags();
  const { selected, focused, toggle } = useSelection();
  const { width: w, height: h, pixelRatio } = useWidgetSize();
  const trackRef = useRef<HTMLCanvasElement>(null);
  const carsRef = useRef<HTMLCanvasElement>(null);
  const carsOnScreen = useRef<{ driver: number; x: number; y: number }[]>([]);
  const labelSlots = useRef(new Map<number, number>()); // driver -> label corner used last frame
  const hiddenAt = useRef(new Map<number, number>()); // driver -> when its label last had to be hidden
  const stackHeldSince = useRef<number | null>(null); // since when a swap of overlapping dots is held back
  const drawn = useRef<Drawn | null>(null);

  const layer = useMemo(() => (w > 0 && h > 0 ? drawStatic(track, w, h, pixelRatio, cornerNames) : null), [track, w, h, pixelRatio, cornerNames]);
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
    const { tf, dpr, pit: pitLane } = layer;
    let last = drawn.current;
    if (canvas.width !== layer.canvas.width || canvas.height !== layer.canvas.height) {
      canvas.width = layer.canvas.width;
      canvas.height = layer.canvas.height;
      last = null;
    }
    if (last && last.layer !== layer) last = null;
    const { order: running, positions, selected, focused, info } = latest.current;
    const inputs = [running, positions, selected, focused, info];
    let changed = !last || last.resting || last.animating || inputs.some((v, i) => v !== last.inputs[i]);

    // Draw back-markers first so the leader (and the focused car) end up on top; dots that overlap keep their
    // stacking through changes of the running order (below). With a selection, only the selected cars are drawn.
    const shown = selected.length > 0 ? new Set(selected) : null;
    const target = [...running].reverse().filter((n) => shown?.has(n) ?? true);

    // Every car at its exact position, every frame: holding back sub-pixel moves makes dots stutter.
    const at = new Map<number, DrawnCar>();
    const { now } = frame;
    let animating = false;
    for (const n of target) {
      const d = info.get(n);
      const p = d && frame.car(n);
      if (!d || !p) continue;
      const before = last?.byDriver.get(n);
      // Into or out of the pit lane, the dot changes look; on the lane's stretch, the car rides the lane as
      // drawn (no other car moves).
      const pit = ease(p.pit, before?.pit, now);
      const lane = ease(p.pitLane && pitLane != null, before?.lane, now);
      if (pit.until > now || lane.until > now) animating = true;
      const [cx, cy] = lane.v > 0 && pitLane ? onPitLane(pitLane, ...tf(p.x, p.y), lane.v) : tf(p.x, p.y);
      if (!before || cx !== before.cx || cy !== before.cy || before.alpha !== p.opacity || before.pit.on !== pit.on || before.lane.on !== lane.on) changed = true;
      at.set(n, { n, color: teamColor(d.teamColour), cx, cy, alpha: p.opacity, focused: n === focused, pit, lane, label: null, ghosts: [], parts: [] });
    }
    const overlap = (a: number, b: number) => {
      const p = at.get(a);
      const q = at.get(b);
      return p != null && q != null && Math.hypot(p.cx - q.cx, p.cy - q.cy) < STACK_OVERLAP;
    };
    const since = stackHeldSince.current;
    const stack = stackOrder(last ? last.cars.map((c) => c.n) : null, target, focused, overlap, since != null && now - since >= STACK_HOLD_MS);
    stackHeldSince.current = stack.holding ? (since ?? now) : null;
    // (Holding: redraw until the order catches up, also when nothing moves.)
    if (stack.holding) animating = true;
    const cars = stack.order.flatMap((n) => at.get(n) ?? []);
    // Nothing moved, appeared or disappeared, and the inputs are the same: the layer is up to date.
    if (!changed && cars.length === last!.cars.length) return;

    const ctx = canvas.getContext("2d")!;
    // Labels in priority order (focused car, then the cars labelled last frame, then the rest, each from the top of
    // the stack down), each in the first corner around its dot that doesn't overlap a label already placed; cars
    // in a tight pack may go unlabelled, and a label stays with its car while it fits.
    ctx.font = "700 11px ui-sans-serif, system-ui";
    const placed: { x: number; y: number; w: number }[] = [];
    let resting = false;
    // Inside the canvas and at least `gap` px clear of every label placed so far.
    const fits = (x: number, y: number, lw: number, gap: number) =>
      x >= 0 &&
      y >= 0 &&
      x + lw <= w &&
      y + LABEL_H <= h &&
      placed.every((r) => x + lw + gap <= r.x || r.x + r.w + gap <= x || y + LABEL_H + gap <= r.y || r.y + LABEL_H + gap <= y);
    for (const car of labelOrder(cars, (c) => c.focused, (c) => last?.byDriver.get(c.n)?.label != null)) {
      const { n, cx, cy } = car;
      const pos = positions.get(n);
      const text = info.get(n)!.acronym;
      const prefix = pos != null ? `${pos} ` : "";
      const prefixW = ctx.measureText(prefix).width;
      const labelW = prefixW + ctx.measureText(text).width + 10;
      const corner = (k: number) => labelAt(cx, cy, labelW, k);
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
      car.label = { x: lx, y: top, w: labelW, prefix, prefixW, text, slot, alpha: 1, until: now };
    }

    // Labels fade rather than pop, on the wall clock so they look the same at any replay speed and finish
    // while paused. Placing is as above: a label counts as placed from the moment it starts fading in,
    // and stops counting the moment it starts fading out.
    for (const car of cars) {
      const { cx, cy } = car;
      const before = last?.byDriver.get(car.n);
      const was = before?.label ?? null;
      const ghosts = car.ghosts;
      for (const g of before?.ghosts ?? []) if (g.until > now) ghosts.push(follow(g, cx, cy, (g.until - now) / LABEL_FADE_OUT_MS));
      const l = car.label;
      if (l) {
        if (was?.slot === l.slot) l.until = was.until;
        else {
          // Appears, or takes another corner: fades in, from where a label fading out of that corner had got.
          const back = ghosts.findIndex((g) => g.slot === l.slot);
          const from = back < 0 ? 0 : ghosts.splice(back, 1)[0].alpha;
          l.until = now + (1 - from) * LABEL_FADE_IN_MS;
        }
        l.alpha = Math.min(1, 1 - (l.until - now) / LABEL_FADE_IN_MS);
      }
      // Hidden, or moved: fades out at the corner it left, from as far as it had faded in.
      if (was && was.slot !== l?.slot && was.alpha > 0) ghosts.push({ ...follow(was, cx, cy, was.alpha), until: now + was.alpha * LABEL_FADE_OUT_MS });
      if (ghosts.length > 0 || (l && l.alpha < 1)) animating = true;
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
    drawn.current = { layer, inputs, cars, byDriver, resting, animating };
    carsOnScreen.current = cars.map((c) => ({ driver: c.n, x: c.cx, y: c.cy }));
  });

  /** The car under the pointer, if any; a finger is wider than a mouse pointer, so a touch reaches further. */
  const carAt = (e: PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const radius = e.pointerType === "touch" ? TOUCH_HIT_RADIUS : HIT_RADIUS;
    let best: { driver: number; d: number } | null = null;
    for (const c of carsOnScreen.current) {
      const d = Math.hypot(c.x - mx, c.y - my);
      if (d <= radius && (!best || d < best.d)) best = { driver: c.driver, d };
    }
    return best?.driver ?? null;
  };
  // A tap or click (down and up without moving) toggles the car in the selection; one on empty track leaves
  // the selection alone. Pointer events rather than click, so a touch that turns into a scroll (the browser
  // cancels the pointer) never selects a car.
  const press = useRef<{ x: number; y: number } | null>(null);
  const onPointerDown = (e: PointerEvent<HTMLCanvasElement>) => {
    press.current = e.button === 0 ? { x: e.clientX, y: e.clientY } : null;
  };
  const onPointerUp = (e: PointerEvent<HTMLCanvasElement>) => {
    const p = press.current;
    press.current = null;
    if (!p || Math.hypot(e.clientX - p.x, e.clientY - p.y) > TAP_SLOP) return;
    const n = carAt(e);
    if (n != null) toggle(n);
  };
  // Only a car can be clicked, so only a car gets the pointer (the mouse pointer: touch has none).
  const onPointerMove = (e: PointerEvent<HTMLCanvasElement>) => {
    if (e.pointerType !== "mouse") return;
    const cursor = carAt(e) != null ? "pointer" : "";
    if (e.currentTarget.style.cursor !== cursor) e.currentTarget.style.cursor = cursor;
  };

  const banner = trackStatus !== "GREEN" ? TRACK_STATUS[trackStatus] : null;

  // Two canvases: the track (redrawn rarely) under the cars and labels (redrawn as they move).
  return (
    <div className="relative h-full w-full overflow-hidden">
      <canvas ref={trackRef} className="pointer-events-none absolute inset-0" style={{ width: w, height: h }} />
      {/* touch-pan-y: the map doesn't pan, so a finger dragged over it scrolls the page as anywhere else. */}
      <canvas
        ref={carsRef}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerCancel={() => (press.current = null)}
        onPointerMove={onPointerMove}
        className="absolute inset-0 touch-pan-y"
        style={{ width: w, height: h }}
      />
      {banner && (
        <div className={`absolute left-1/2 top-3 -translate-x-1/2 rounded px-4 py-1 text-sm font-bold uppercase tracking-wider shadow-lg ${banner.className}`}>
          {banner.label}
        </div>
      )}
    </div>
  );
}

export default defineWidget({
  id: "track-map",
  name: "Track map",
  group: "session",
  description: "Every car on the circuit, and the sectors under a flag. Click a car to add it to the selection.",
  version: "1.0.0",
  // Fills its column; the circuit is fitted inside, whatever the box's shape.
  height: { min: 200 },
  width: { min: 20, default: 55, max: 80 },
  sessions: ["race", "practice"],
  settings: { cornerNames: false },
  Component: TrackMap,
});
