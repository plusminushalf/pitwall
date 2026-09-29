// Lap comparison over distance-aligned lap traces (laps/<driver>.json, see LapTrace in types.ts):
// values at a distance, time deltas between laps, mini-sector dominance and ghost positions.
// Pure; shared by the qualifying compare view and scripts/check-quali.ts.

import type { LapTrace } from "../types";
import { catmullRom, indexAtOrBefore } from "./lookup";

export interface DecodedLap {
  driver: number;
  lap: number;
  t: Float64Array; // ms since the lap start (ascending)
  d: Float64Array; // metres from the timing line (non-decreasing)
  speed: Float32Array;
  throttle: Float32Array;
  brake: Uint8Array;
  gear: Uint8Array;
  x: Float32Array;
  y: Float32Array;
  duration: number; // ms: t at the finish line
  length: number; // m: d at the finish line
}

function cumulative(deltas: number[], scale = 1): Float64Array {
  const out = new Float64Array(deltas.length);
  let acc = 0;
  for (let i = 0; i < deltas.length; i++) out[i] = (acc += deltas[i]) / scale;
  return out;
}

export function decodeLapTrace(driver: number, tr: LapTrace): DecodedLap {
  const t = cumulative(tr.t);
  const d = cumulative(tr.d, 10);
  return {
    driver,
    lap: tr.lap,
    t,
    d,
    speed: Float32Array.from(tr.speed),
    throttle: Float32Array.from(tr.throttle),
    brake: Uint8Array.from(tr.brake),
    gear: Uint8Array.from(tr.gear),
    x: Float32Array.from(tr.x),
    y: Float32Array.from(tr.y),
    duration: t[t.length - 1] ?? 0,
    length: d[d.length - 1] ?? 0,
  };
}

/** Linear interpolation of ys over ascending xs at x, clamped to the ends. */
function interp(xs: ArrayLike<number>, ys: ArrayLike<number>, x: number): number {
  const n = xs.length;
  if (n === 0) return NaN;
  if (x <= xs[0]) return ys[0];
  if (x >= xs[n - 1]) return ys[n - 1];
  const i = indexAtOrBefore(xs, x);
  const span = xs[i + 1] - xs[i];
  return span > 0 ? ys[i] + ((x - xs[i]) / span) * (ys[i + 1] - ys[i]) : ys[i];
}

/** When (ms since the lap start) the car reached distance d (m). */
export const timeAtDistance = (lap: DecodedLap, d: number) => interp(lap.d, lap.t, d);

/** How far (m) the car had gone at t ms into the lap. */
export const distanceAtTime = (lap: DecodedLap, t: number) => interp(lap.t, lap.d, t);

export type Channel = "speed" | "throttle" | "brake" | "gear";

/** A channel's value at distance d: interpolated for speed and throttle, held for brake and gear. */
export function valueAtDistance(lap: DecodedLap, channel: Channel, d: number): number {
  if (channel === "speed" || channel === "throttle") return interp(lap.d, lap[channel], d);
  const i = Math.max(0, indexAtOrBefore(lap.d, d));
  return lap[channel][i];
}

/** Smoothed track position at t ms into the lap (clamped to the lap). */
export function positionAtTime(lap: DecodedLap, t: number): { x: number; y: number } {
  const { t: ts, x, y } = lap;
  const n = ts.length;
  if (t <= 0 || n < 2) return { x: x[0], y: y[0] };
  if (t >= ts[n - 1]) return { x: x[n - 1], y: y[n - 1] };
  const i = indexAtOrBefore(ts, t);
  const u = (t - ts[i]) / (ts[i + 1] - ts[i] || 1);
  const i0 = i > 0 ? i - 1 : i;
  const i3 = i + 2 < n ? i + 2 : i + 1;
  return { x: catmullRom(x[i0], x[i], x[i + 1], x[i3], u), y: catmullRom(y[i0], y[i], y[i + 1], y[i3], u) };
}

export const positionAtDistance = (lap: DecodedLap, d: number) => positionAtTime(lap, timeAtDistance(lap, d));

export interface DeltaSeries {
  d: Float64Array; // m
  delta: Float64Array; // s: other's time minus the reference's at the same distance (> 0: other is behind)
}

/** Cumulative time delta of `other` against `ref` every `step` metres, finishing exactly at the line. */
export function deltaSeries(ref: DecodedLap, other: DecodedLap, step = 5): DeltaSeries {
  const length = Math.min(ref.length, other.length);
  const n = Math.max(2, Math.ceil(length / step) + 1);
  const d = new Float64Array(n);
  const delta = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const di = i === n - 1 ? length : i * step;
    d[i] = di;
    delta[i] = (timeAtDistance(other, di) - timeAtDistance(ref, di)) / 1000;
  }
  return { d, delta };
}

/** Delta (s) at one distance. */
export const deltaAt = (ref: DecodedLap, other: DecodedLap, d: number) => (timeAtDistance(other, d) - timeAtDistance(ref, d)) / 1000;

export interface MiniSector {
  from: number; // m
  to: number; // m
  times: number[]; // s per lap (same order as the input laps)
  winner: number; // index of the fastest lap through it
}

/** Split the lap into `count` equal-distance mini-sectors and find the fastest lap through each. */
export function miniSectors(laps: DecodedLap[], count: number): MiniSector[] {
  if (!laps.length) return [];
  const length = Math.min(...laps.map((l) => l.length));
  const out: MiniSector[] = [];
  for (let k = 0; k < count; k++) {
    const from = (k / count) * length;
    const to = ((k + 1) / count) * length;
    const times = laps.map((l) => (timeAtDistance(l, to) - timeAtDistance(l, from)) / 1000);
    let winner = 0;
    for (let i = 1; i < times.length; i++) if (times[i] < times[winner]) winner = i;
    out.push({ from, to, times, winner });
  }
  return out;
}

/** Highest speed in [from, to] metres and where it was reached. */
export function topSpeed(lap: DecodedLap, from = 0, to = Infinity): { speed: number; d: number } {
  let best = { speed: -Infinity, d: 0 };
  for (let i = 0; i < lap.d.length; i++) {
    if (lap.d[i] < from || lap.d[i] > to) continue;
    if (lap.speed[i] > best.speed) best = { speed: lap.speed[i], d: lap.d[i] };
  }
  return best;
}
