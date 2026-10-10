// Distance-aligned traces of a race's laps, built in the browser from the car telemetry, so two drivers' race
// laps can be overlaid as qualifying laps are (engine/compare.ts works on the result). Qualifying and finished
// practice ship traces in laps/<driver>.json (scripts/lib/lapTraces.ts); races have only the raw car streams,
// so the same alignment is done here, lap by lap, when a widget asks:
//
//   1. Lap starts. OpenF1's `date_start` jitters by up to ~1 s; lap durations are exact official times, so within
//      a run of consecutive timed laps each start is the run's anchor (the median of start - the durations
//      before it) plus those durations.
//   2. Distance is the speed trace integrated over the lap, pinned at the anchors whose times are exact: the
//      line (0), the sector 2 and 3 boundaries (official sector times) and the line again (the lap length). The
//      anchor distances are session constants: medians over the clean laps at pace (worked out once per session).
//
// Everything is cached on the session (WeakMap): a trace is built once and shared by every widget showing it.

import type { CarSeries, DriverData, Session } from "../data/session";
import type { Lap } from "../types";
import { cornerLabel } from "../data/circuits";
import type { DecodedLap } from "./compare";
import { indexAtOrBefore, lerpAt } from "./lookup";

const GAP_MS = 1_500; // car data missing between two samples this far apart
const MAX_GAP_MS = 8_000; // no trace for a lap with a longer gap...
const MAX_GAP_SHARE = 0.15; // ...or with more of it missing than this
/** Laps that measure the lap length: within 107% of the session's fastest, no pit lane, clean data. */
const PACE_RATIO = 1.07;

export interface LapGeometry {
  /** Metres, timing line to timing line (NaN until a session has clean laps to measure). */
  lapLength: number;
  /** Metres from the timing line to the sector 2 and 3 boundaries (NaN when unknown). */
  sectorDistances: [number, number];
  /** Corners along the lap: label ("1", "5A") and distance from the line (from the circuit's corner marks). */
  corners: { label: string; d: number }[];
}

const median = (xs: number[]) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// ---------------------------------------------------------------- lap starts (step 1)

/** A driver's lap starts (ms) by lap number, chained through the official durations (step 1). */
function chainStarts(laps: readonly Lap[]): Map<number, number> {
  const out = new Map<number, number>();
  const runs: Lap[][] = [];
  let run: Lap[] = [];
  for (const l of laps) {
    const prev = run.at(-1);
    if (prev && l.lap === prev.lap + 1 && prev.duration != null && !prev.pitOut && !l.pitOut) run.push(l);
    else {
      if (run.length) runs.push(run);
      run = [l];
    }
  }
  if (run.length) runs.push(run);
  for (const r of runs) {
    const cum: number[] = [];
    let acc = 0;
    for (const l of r) {
      cum.push(acc);
      acc += (l.duration ?? 0) * 1000;
    }
    const anchor = median(r.map((l, i) => l.start - cum[i]));
    // Durations that don't chain (a lost record in between): the laps keep their own starts.
    const broken = r.some((l, i) => Math.abs(l.start - (anchor + cum[i])) > 2_500);
    r.forEach((l, i) => out.set(l.lap, broken ? l.start : Math.round(anchor + cum[i])));
  }
  return out;
}

const startsCache = new WeakMap<DriverData, Map<number, number>>();

function startsOf(d: DriverData): Map<number, number> {
  let s = startsCache.get(d);
  if (!s) startsCache.set(d, (s = chainStarts(d.laps)));
  return s;
}

/** A lap's window [start, end] with the chained start; null without a lap time. */
function windowOf(d: DriverData, l: Lap): { start: number; end: number } | null {
  if (l.duration == null) return null;
  const start = startsOf(d).get(l.lap) ?? l.start;
  return { start, end: start + Math.round(l.duration * 1000) };
}

// ---------------------------------------------------------------- integration (step 2)

interface Integrated {
  t: Float64Array; // ms: the lap's car samples, plus exact samples on the line at both ends
  v: Float64Array; // km/h
  gap: Uint8Array; // gap[k]: no car data between samples k - 1 and k
  D: Float64Array; // m, integrated from the speed trace
}

/**
 * The lap's samples from line to line with integrated distance, or null if too much is missing. `pins` (the
 * sector boundary times) are inserted as samples, so an anchor never has to snap to the nearest sample.
 */
function integrate(car: CarSeries, start: number, end: number, pins: readonly number[] = []): Integrated | null {
  if (car.t.length < 3 || end <= start) return null;
  const before = indexAtOrBefore(car.t, start);
  if (before < 0) return null;
  let after = indexAtOrBefore(car.t, end);
  // `after`: the first sample at or past the end.
  if (after < 0 || car.t[after] < end) after++;
  if (after >= car.t.length) return null;
  const first = car.t[before] === start ? before : before + 1;
  const last = car.t[after] === end ? after : after - 1;
  // Around the line the neighbouring samples count too.
  if (car.t[first] - car.t[before] > MAX_GAP_MS || car.t[after] - car.t[last] > MAX_GAP_MS) return null;
  const vAt = (x: number) => {
    const i = indexAtOrBefore(car.t, x);
    if (i < 0) return car.speed[0];
    if (i >= car.t.length - 1) return car.speed[i];
    const span = car.t[i + 1] - car.t[i];
    return span > 0 ? car.speed[i] + ((x - car.t[i]) / span) * (car.speed[i + 1] - car.speed[i]) : car.speed[i];
  };
  const times: number[] = [start];
  const inside = [...pins].filter((p) => p > start && p < end).sort((a, b) => a - b);
  let p = 0;
  for (let i = first; i <= last; i++) {
    while (p < inside.length && inside[p] < car.t[i]) times.push(inside[p++]);
    if (car.t[i] > start && car.t[i] < end && car.t[i] !== times[times.length - 1]) times.push(car.t[i]);
    if (p < inside.length && inside[p] === car.t[i]) p++;
  }
  while (p < inside.length) times.push(inside[p++]);
  times.push(end);
  const n = times.length;
  const t = Float64Array.from(times);
  const v = Float64Array.from(times, vAt);
  const gap = new Uint8Array(n);
  let gapTime = 0;
  for (let k = 1; k < n; k++) {
    // A gap is between two car samples: a pin inside it doesn't close it.
    const i = indexAtOrBefore(car.t, t[k - 1]);
    const j = i < car.t.length - 1 ? i + 1 : i;
    const dt = car.t[j] - car.t[i];
    if (dt > MAX_GAP_MS) return null;
    if (dt > GAP_MS) {
      gap[k] = 1;
      gapTime += t[k] - t[k - 1];
    }
  }
  if (gapTime > MAX_GAP_SHARE * (end - start)) return null;
  const D = new Float64Array(n);
  for (let k = 1; k < n; k++) D[k] = D[k - 1] + (((v[k - 1] + v[k]) / 2 / 3.6) * (t[k] - t[k - 1])) / 1000;
  return { t, v, gap, D };
}

/**
 * Distance per sample, pinned at the anchors (time, distance): between two anchors the integrated distance is
 * scaled to fit. Where data is missing the good samples keep their integrated distance and the gap gets the rest,
 * unless that's implausible (then everything is scaled).
 */
function align(it: Integrated, anchors: [number, number][]): Float64Array {
  const n = it.t.length;
  const inc = new Float64Array(n);
  for (let k = 1; k < n; k++) inc[k] = it.D[k] - it.D[k - 1];
  const idx = anchors.map(([ta]) => {
    let best = 0;
    for (let k = 0; k < n; k++) if (Math.abs(it.t[k] - ta) < Math.abs(it.t[best] - ta)) best = k;
    return best;
  });
  const out = new Float64Array(n);
  for (let j = 0; j + 1 < anchors.length; j++) {
    const [from, to] = [idx[j], idx[j + 1]];
    const span = anchors[j + 1][1] - anchors[j][1];
    let good = 0;
    let missing = 0;
    for (let k = from + 1; k <= to; k++) it.gap[k] ? (missing += inc[k]) : (good += inc[k]);
    let goodScale = good + missing > 0 ? span / (good + missing) : 0;
    let gapScale = goodScale;
    if (missing > 0 && good < span && (span - good) / missing >= 0.25 && (span - good) / missing <= 2.5) {
      goodScale = 1;
      gapScale = (span - good) / missing;
    }
    out[from] = anchors[j][1];
    for (let k = from + 1; k <= to; k++) out[k] = out[k - 1] + inc[k] * (it.gap[k] ? gapScale : goodScale);
  }
  // Past the last anchor (an end sample the search put before the line): hold.
  for (let k = idx[idx.length - 1] + 1; k < n; k++) out[k] = out[k - 1];
  for (let k = 1; k < n; k++) out[k] = Math.max(out[k], out[k - 1]);
  return out;
}

/** The official sector boundary times inside the lap's window, or null for each not known. */
function sectorTimes(l: Lap, start: number, end: number): [number | null, number | null] {
  const [s1, s2] = l.sectors;
  const a = s1 != null ? start + s1 * 1000 : null;
  const b = s1 != null && s2 != null ? start + (s1 + s2) * 1000 : null;
  return [a != null && a < end ? a : null, b != null && b < end ? b : null];
}

// ---------------------------------------------------------------- session constants

const geometryCache = new WeakMap<Session, LapGeometry>();

/**
 * The lap length and sector boundaries measured on the session's clean laps at pace (within 107% of the fastest,
 * no pit lane, complete data), with the corners' distances along the lap. Measured over every lap in the session:
 * the shape of the circuit isn't a spoiler. NaN while there are no laps to measure (early in a live session).
 */
export function lapGeometryOf(session: Session): LapGeometry {
  let g = geometryCache.get(session);
  if (g) return g;
  const timed = session.meta.laps.filter((l) => l.duration != null && !l.pitOut && l.lap > 1);
  const fastest = Math.min(...timed.map((l) => l.duration!));
  const lengths: number[] = [];
  const f1s: number[] = [];
  const f2s: number[] = [];
  // The fastest clean lap: its path puts the corners along the lap.
  let reference: { d: DriverData; l: Lap; it: Integrated; start: number; end: number } | null = null;
  // Laps without a gap in their car data; failing that (a live stream with small gaps), laps integrate() accepts.
  for (const strict of [true, false]) {
    for (const l of timed) {
      if (l.duration! > fastest * PACE_RATIO) continue;
      const d = session.drivers.get(l.driver);
      const w = d && windowOf(d, l);
      if (!d || !w) continue;
      const [a, b] = sectorTimes(l, w.start, w.end);
      const it = integrate(d.car, w.start, w.end, [a, b].filter((x): x is number => x != null));
      if (!it || (strict && it.gap.some(Boolean))) continue;
      const total = it.D[it.D.length - 1];
      lengths.push(total);
      if (a != null) f1s.push(lerpClamped(it.t, it.D, a) / total);
      if (b != null) f2s.push(lerpClamped(it.t, it.D, b) / total);
      if (!reference || l.duration! < reference.l.duration!) reference = { d, l, it, start: w.start, end: w.end };
    }
    if (lengths.length) break;
  }
  const lapLength = median(lengths);
  const sectorDistances: [number, number] = [median(f1s) * lapLength, median(f2s) * lapLength];
  const corners: LapGeometry["corners"] = [];
  if (reference && Number.isFinite(lapLength)) {
    // Corner distances: the reference lap's location at each sample against the corner marks.
    const { d, l, it } = reference;
    const anchors: [number, number][] = [[reference.start, 0]];
    const [a, b] = sectorTimes(l, reference.start, reference.end);
    if (a != null && Number.isFinite(sectorDistances[0])) anchors.push([a, sectorDistances[0]]);
    if (b != null && Number.isFinite(sectorDistances[1])) anchors.push([b, sectorDistances[1]]);
    anchors.push([reference.end, lapLength]);
    const dist = align(it, anchors);
    const xs = Float64Array.from(it.t, (t) => lerpClamped(d.loc.t, d.loc.x, t));
    const ys = Float64Array.from(it.t, (t) => lerpClamped(d.loc.t, d.loc.y, t));
    for (const c of session.meta.track.corners) {
      let best = 0;
      let bestD = Infinity;
      for (let i = 0; i < xs.length; i++) {
        const dd = (xs[i] - c.x) ** 2 + (ys[i] - c.y) ** 2;
        if (dd < bestD) {
          bestD = dd;
          best = i;
        }
      }
      corners.push({ label: cornerLabel(c), d: dist[best] });
    }
    corners.sort((a, b) => a.d - b.d);
  }
  g = { lapLength, sectorDistances, corners };
  geometryCache.set(session, g);
  return g;
}

/** lerpAt, clamped to the ends (lerpAt is null outside the range). */
function lerpClamped(xs: ArrayLike<number>, ys: ArrayLike<number>, x: number): number {
  const n = xs.length;
  if (!n) return NaN;
  if (x <= xs[0]) return ys[0];
  if (x >= xs[n - 1]) return ys[n - 1];
  return lerpAt(xs, ys, x) ?? NaN;
}

// ---------------------------------------------------------------- traces

const traceCache = new WeakMap<Session, Map<string, DecodedLap | null>>();

/**
 * Car n's lap `lapNo` as a distance-aligned trace (engine/compare's DecodedLap: x and y are the car's track
 * position), or null when the lap has no time, no lap length is known yet, or too much of its car data is missing.
 * The caller decides whether the lap may be shown (it's spoiler-free only once the lap is over at t).
 */
export function lapTraceOf(session: Session, n: number, lapNo: number): DecodedLap | null {
  let byKey = traceCache.get(session);
  if (!byKey) traceCache.set(session, (byKey = new Map()));
  const key = `${n}:${lapNo}`;
  const hit = byKey.get(key);
  if (hit !== undefined) return hit;
  const trace = build(session, n, lapNo);
  byKey.set(key, trace);
  return trace;
}

function build(session: Session, n: number, lapNo: number): DecodedLap | null {
  const d = session.drivers.get(n);
  const l = d?.laps.find((x) => x.lap === lapNo);
  if (!d || !l) return null;
  const w = windowOf(d, l);
  if (!w) return null;
  const { lapLength, sectorDistances } = lapGeometryOf(session);
  if (!Number.isFinite(lapLength)) return null;
  const [a, b] = sectorTimes(l, w.start, w.end);
  const it = integrate(d.car, w.start, w.end, [a, b].filter((x): x is number => x != null));
  if (!it) return null;
  const anchors: [number, number][] = [[w.start, 0]];
  if (a != null && Number.isFinite(sectorDistances[0])) anchors.push([a, sectorDistances[0]]);
  if (b != null && Number.isFinite(sectorDistances[1])) anchors.push([b, sectorDistances[1]]);
  anchors.push([w.end, lapLength]);
  const dist = align(it, anchors);
  dist[dist.length - 1] = lapLength;
  const m = it.t.length;
  const car = d.car;
  const step = (arr: ArrayLike<number>, t: number) => arr[Math.max(0, indexAtOrBefore(car.t, t))];
  const t = new Float64Array(m);
  const speed = new Float32Array(m);
  const throttle = new Float32Array(m);
  const brake = new Uint8Array(m);
  const gear = new Uint8Array(m);
  const x = new Float32Array(m);
  const y = new Float32Array(m);
  const hasLoc = d.loc.t.length > 0;
  for (let k = 0; k < m; k++) {
    const tk = it.t[k];
    t[k] = tk - w.start;
    speed[k] = it.v[k];
    throttle[k] = lerpClamped(car.t, car.throttle, tk);
    brake[k] = step(car.brake, tk) > 0 ? 100 : 0;
    gear[k] = step(car.gear, tk);
    x[k] = hasLoc ? lerpClamped(d.loc.t, d.loc.x, tk) : 0;
    y[k] = hasLoc ? lerpClamped(d.loc.t, d.loc.y, tk) : 0;
  }
  return { driver: n, lap: lapNo, t, d: dist, speed, throttle, brake, gear, x, y, duration: t[m - 1], length: lapLength };
}

// ---------------------------------------------------------------- the lap in progress

/** A car's lap in progress at t, as far as it has got: what a live push lap is followed with. */
export interface LiveLap {
  driver: number;
  lap: number;
  /** When it started (ms since t0, chained as a finished lap's start is). */
  start: number;
  /** An out-lap (from the pit exit): not a push lap. */
  pitOut: boolean;
  /**
   * Distance-aligned up to the car's latest sample at or before t (`duration`: ms into the lap there, `length`: metres
   * covered). Pinned at the sector 2 and 3 boundaries once their official times are in; past the last pin, the
   * integrated speed.
   */
  trace: DecodedLap;
}

const liveCache = new WeakMap<CarSeries, LiveLap & { last: number }>();

/**
 * Car n's lap in progress at t (null between laps, before its first, or without car data since the line). Spoiler-free: reads nothing after t. Cached per car until a new sample or lap.
 */
export function liveLapOf(session: Session, n: number, t: number): LiveLap | null {
  const d = session.drivers.get(n);
  if (!d) return null;
  const li = indexAtOrBefore(d.lapStarts, t);
  if (li < 0) return null;
  const l = d.laps[li];
  if (l.end != null && l.end <= t) return null;
  const { lapLength: measured, sectorDistances } = lapGeometryOf(session);
  // Before a lap length is known the lap still counts, its distance just isn't capped.
  const lapLength = Number.isFinite(measured) ? measured : Infinity;
  const start = startsOf(d).get(l.lap) ?? l.start;
  const car = d.car;
  const last = indexAtOrBefore(car.t, t);
  if (last < 0 || car.t[last] <= start) return null;
  const hit = liveCache.get(car);
  if (hit && hit.lap === l.lap && hit.driver === n && hit.last === last && hit.start === start) return hit;

  let first = indexAtOrBefore(car.t, start) + 1;
  if (first < 0) first = 0;
  const times = [start];
  for (let i = first; i <= last; i++) if (car.t[i] > start) times.push(car.t[i]);
  const m = times.length;
  const tt = Float64Array.from(times);
  const v = Float64Array.from(times, (x) => lerpClamped(car.t, car.speed, x));
  const D = new Float64Array(m);
  for (let k = 1; k < m; k++) D[k] = D[k - 1] + (((v[k - 1] + v[k]) / 2 / 3.6) * (tt[k] - tt[k - 1])) / 1000;
  // Pins: the sector boundaries the official times have placed so far; past the last, the integrated distance.
  const pins: [number, number][] = [[start, 0]];
  const [a, b] = sectorTimes(l, start, tt[m - 1] + 1);
  if (a != null && Number.isFinite(sectorDistances[0])) pins.push([a, sectorDistances[0]]);
  if (b != null && Number.isFinite(sectorDistances[1])) pins.push([b, sectorDistances[1]]);
  const dAt = (x: number) => lerpClamped(tt, D, x);
  const dist = new Float64Array(m);
  for (let k = 0; k < m; k++) {
    const x = tt[k];
    let j = 0;
    while (j + 1 < pins.length && pins[j + 1][0] <= x) j++;
    const [t0, d0] = pins[j];
    const next = pins[j + 1];
    const raw = dAt(x) - dAt(t0);
    const span = next ? dAt(next[0]) - dAt(t0) : 0;
    dist[k] = Math.min(lapLength, next && span > 0 ? d0 + (raw / span) * (next[1] - d0) : d0 + raw);
    if (k > 0) dist[k] = Math.max(dist[k], dist[k - 1]);
  }
  const step = (arr: ArrayLike<number>, x: number) => arr[Math.max(0, indexAtOrBefore(car.t, x))];
  const hasLoc = d.loc.t.length > 0;
  const trace: DecodedLap = {
    driver: n,
    lap: l.lap,
    t: Float64Array.from(tt, (x) => x - start),
    d: dist,
    speed: Float32Array.from(v),
    throttle: Float32Array.from(tt, (x) => lerpClamped(car.t, car.throttle, x)),
    brake: Uint8Array.from(tt, (x) => (step(car.brake, x) > 0 ? 100 : 0)),
    gear: Uint8Array.from(tt, (x) => step(car.gear, x)),
    x: Float32Array.from(tt, (x) => (hasLoc ? lerpClamped(d.loc.t, d.loc.x, x) : 0)),
    y: Float32Array.from(tt, (x) => (hasLoc ? lerpClamped(d.loc.t, d.loc.y, x) : 0)),
    duration: tt[m - 1] - start,
    length: dist[m - 1],
  };
  const out = { driver: n, lap: l.lap, start, pitOut: l.pitOut, trace, last };
  liveCache.set(car, out);
  return out;
}
