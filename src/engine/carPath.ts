// Where a car is between its location samples: moved along the sampled racing line at telemetry speed.
//
// OpenF1 location stamps are jittered (about a quarter of the batches are stamped 60-150 ms early, for every
// car at once), so a spline through each sample at its stamp makes the dot surge and stall while the speed
// trace is flat. Instead the dot moves along the racing line (a chordal Catmull-Rom through the samples) by
// arc length s(t) = D(t) + c(t): D is the distance integrated from the car's speed, c a robust low-pass of
// (arc length - D) at the samples. So it moves at telemetry speed and stays within a few metres of the samples.
//
// The samples also have glitches the path must not follow: a single sample far ahead that the next ones
// catch up with, or a burst of stale samples well behind. A sample whose distance from the last kept one
// disagrees with the telemetry (or that goes backwards) is held back; if the next ones agree again it was a
// glitch and is dropped, if a run of them stays elsewhere it's a real relocation (pit-lane coordinates, the
// feed jumping ahead) and the path jumps there, with the filter restarted on each side.
//
// Everything is precomputed once per driver (carPathOf, cached on the driver and its arrays; the session
// builder warms it) and extended at the tail when live telemetry is appended. Replays smooth the offset over
// samples on both sides. Live sessions only look back (the anchors of what's already arrived never change, so
// appended data never moves a car that's been shown): as smooth, about as close to the samples as a spline
// through them, not as close as a replay. Units: location in decimetres, times in ms, speed in km/h
// (km/h x ms / 360 = dm).

import type { CarSeries, DriverData, LocSeries } from "../data/session";

// ---------------------------------------------------------------- tuning

/**
 * Offset filter, in samples: a median over q-back..q+ahead, then the mean of those medians. Replays: 3 on each
 * side for both (~1.7 s in all); the last 6 samples before the data end hold the last offset. Live: the median
 * of the last 5 and the mean of the last 3 (a lag of ~0.8 s, never revised).
 */
interface Filter {
  live: boolean;
  medBack: number;
  medAhead: number;
  meanBack: number;
  meanAhead: number;
}
const REPLAY: Filter = { live: false, medBack: 3, medAhead: 3, meanBack: 3, meanAhead: 3 };
const LIVE: Filter = { live: true, medBack: 4, medAhead: 0, meanBack: 2, meanAhead: 0 };
/** Live: a location sample waits for the car samples around it this long at most (then: no telemetry there). */
const TEL_WAIT_MS = 2_000;
/** Live: below this the car is never put ahead of its newest sample (it may be stopping there). */
const SLOW_KMH = 30;
/** Never more than 25 m (~0.35 s at 250 km/h) along the path from where the sample's stamp puts the car. */
const MAX_OFF = 250;
/**
 * A sample is suspect if its distance from the last kept one differs from the telemetry distance by more
 * than 25 m + 30% of the latter (stamp jitter stays under ~15 m even at 330 km/h), if it's under a quarter of
 * a telemetry distance over 10 m (a stale repeat), or if it's more than 0.5 m behind it while the car is
 * moving (> 30 km/h: it covers 2 m or more between samples).
 */
const SUSPECT = 250;
const SUSPECT_FRAC = 0.3;
const BACK_TOL = 5;
const STALE_DD = 100;
const STALE_FRAC = 0.25;
const MOVING_KMH = 30;
/** Suspect samples are dropped if a good one follows within 6 samples / 1.5 s; otherwise the car moved there. */
const DROP_MAX = 6;
const DROP_MAX_MS = 1_500;
/**
 * Replays, around pit entry: OpenF1 puts a car turning into the pit lane on the lane at the wrong distance
 * along it (from the branch-off, a few seconds before the stop's entry time) and corrects it at the pit-entry
 * line. A held-back run that starts within 10 s before to 3 s after an entry time is held until that window
 * ends, not 6 samples / 1.5 s: if a sample agrees with the last kept entry before then (25 m + 10% of the
 * telemetry distance), the whole run is dropped and the car drives the chord at telemetry speed; otherwise it
 * relocates, as anywhere else. Live sessions don't wait (pitWin is empty).
 */
const PIT_PRE_MS = 10_000;
const PIT_POST_MS = 3_000;
const PIT_FRAC = 0.1;
/** Travel direction from the last chord at least 2 m long. */
const DIR_MIN = 20;
/** Stationary (< 10 cm of telemetry distance over a sample interval): samples within 3 m snap to the first. */
const STILL_DD = 1;
const SNAP_R = 30;
/** Car samples further apart than this: no speed in between (telemetry dropout), follow the samples by time. */
const TEL_GAP_MS = 1_500;

// Per-entry flags. VALID and STILL describe the interval from this entry to the next.
const VALID = 1; // telemetry covers the interval
const STILL = 2; // the car is stationary over it (the next entry is snapped onto this one)
const BREAK = 4; // this entry starts a new run: the car relocated here, the filter doesn't cross it

// ---------------------------------------------------------------- the per-driver path

export interface CarPath {
  filter: Filter;
  /** Replays: the pit-entry windows (see PIT_PRE_MS) as [from, to, from, to, ...] (ms), sorted. */
  pitWin: number[];
  /** Kept samples (entries) [0, m); arrays have spare capacity. */
  m: number;
  T: Float64Array; // stamp
  X: Float32Array; // position (stationary runs snapped onto their first sample)
  Y: Float32Array;
  S: Float64Array; // arc length along the chords (dm)
  OFF: Float32Array; // anchor - S: where along the path the car is at T (anchor = S + OFF, non-decreasing)
  DLS: Float32Array; // telemetry distance at T, minus S
  FL: Uint8Array;
  /** Cumulative telemetry distance at each car sample [0, nCar). */
  Dc: Float64Array;
  // The streams this was built from: identity, how much was used, and a fingerprint to detect appends.
  lt: Float64Array;
  ct: Float64Array;
  nLoc: number;
  nCar: number;
  fp: number[];
  /**
   * Entries [0, final) can't change when data is appended; `tail` keeps the filter state from tail.base on.
   * Live, every entry is final: a location sample only becomes one once the car samples around it are in.
   */
  final: number;
  tail: Tail;
  /** Lookup hints (the last entry, car sample and chord used): playback asks for nearby times. */
  hq: number;
  hj: number;
  hk: number;
}

interface Tail {
  base: number;
  E: Float64Array; // effective distance: telemetry distance, or chord length where there's no telemetry
  R: Float32Array; // S - E: the offset the filter smooths
  MED: Float32Array;
  C: Float32Array; // the smoothed offset
  RAW: Int32Array; // index of the entry's location sample
}

/** No telemetry: the car follows its samples by time. */
const NO_CAR: CarSeries = {
  t: new Float64Array(0),
  speed: new Float32Array(0),
  rpm: new Float32Array(0),
  gear: new Uint8Array(0),
  throttle: new Float32Array(0),
  brake: new Float32Array(0),
  drs: null,
};

const byDriver = new WeakMap<DriverData, CarPath>();
const byLoc = new WeakMap<Float64Array, CarPath>();

/**
 * The driver's path, computed once per data version: cached on the driver and on its location times (a live
 * session rebuilt around a new meta reuses the arrays). Arrays that grew (live telemetry) extend it in place.
 * `live` picks the filter of a path built now (see REPLAY / LIVE); an existing path keeps its own.
 */
export function carPathOf(d: DriverData, live = false): CarPath {
  const loc = d.loc;
  const car = d.car ?? NO_CAR;
  let p = byDriver.get(d);
  if (p !== undefined && p.lt === loc.t && p.ct === car.t) return p;
  if (p === undefined || !extends_(p, loc, car)) {
    const q = byLoc.get(loc.t);
    p = q !== undefined && (q.ct === car.t || extends_(q, loc, car)) ? q : undefined;
  }
  if (p === undefined) p = build(loc, car, live ? LIVE : REPLAY, live ? [] : pitWindows(d));
  else if (p.lt !== loc.t || p.ct !== car.t) extend(p, loc, car);
  byDriver.set(d, p);
  byLoc.set(loc.t, p);
  return p;
}

/**
 * The car at t along its path; null outside the kept samples (live: also on the newest chord), unless `park`
 * (then the path's end).
 */
export function carPathPosition(d: DriverData, t: number, park: boolean): { x: number; y: number } | null {
  const p = carPathOf(d);
  const m = p.m;
  if (m === 0) return null;
  const T = p.T;
  let q = p.hq;
  if (!(q >= 0 && q < m && T[q] <= t && (q + 1 >= m || t < T[q + 1]))) {
    q = q + 1 < m && q >= 0 && T[q + 1] <= t && (q + 2 >= m || t < T[q + 2]) ? q + 1 : search(T, m, t);
    p.hq = q;
  }
  if (q < 0) return null;
  const S = p.S;
  const OFF = p.OFF;
  if (q >= m - 1) return park ? pointAt(p, S[m - 1] + OFF[m - 1], m - 1) : null;
  const a0 = S[q] + OFF[q];
  const a1 = S[q + 1] + OFF[q + 1];
  let s = a0;
  if (a1 > a0) {
    let f = (t - T[q]) / (T[q + 1] - T[q]);
    if (p.FL[q] & VALID) {
      const d0 = S[q] + p.DLS[q];
      const dd = S[q + 1] + p.DLS[q + 1] - d0;
      if (dd > STILL_DD) f = (distAt(p, d.car ?? NO_CAR, t) - d0) / dd;
    }
    s = a0 + (f <= 0 ? 0 : f >= 1 ? 1 : f) * (a1 - a0);
  }
  // Live: the last chord's curve (and anything past it) depends on the next sample, not in yet: not shown,
  // unless the car is stationary there.
  if (p.filter.live && m >= 3 && s > S[m - 2] && !(p.FL[m - 2] & STILL)) return null;
  return pointAt(p, s, q);
}

// ---------------------------------------------------------------- per-call helpers

/** Index of the last of times[0, n) <= t, or -1. */
function search(times: ArrayLike<number>, n: number, t: number): number {
  let lo = 0;
  let hi = n - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

/** Telemetry distance at t: the integral of the speed, linear between car samples. */
function distAt(p: CarPath, car: CarSeries, t: number): number {
  const n = p.nCar;
  const ct = car.t;
  let j = p.hj;
  if (!(j >= 0 && j < n && ct[j] <= t && (j + 1 >= n || t < ct[j + 1]))) {
    j = j + 1 < n && j >= 0 && ct[j + 1] <= t && (j + 2 >= n || t < ct[j + 2]) ? j + 1 : search(ct, n, t);
    p.hj = j;
  }
  if (j < 0) return 0;
  if (j >= n - 1) return p.Dc[n - 1];
  const v = car.speed;
  const tau = t - ct[j];
  return p.Dc[j] + (v[j] * tau + ((v[j + 1] - v[j]) * tau * tau) / (2 * (ct[j + 1] - ct[j]))) / 360;
}

/** The point at arc length s: on the chord containing s (searched from `hint`), by chordal Catmull-Rom. */
function pointAt(p: CarPath, s: number, hint: number): { x: number; y: number } {
  const { S, X, Y, m } = p;
  if (m === 1) return { x: X[0], y: Y[0] };
  let k = p.hk;
  if (!(k >= 0 && k < m - 1 && Math.abs(k - hint) < 64)) k = Math.min(hint, m - 2);
  while (k > 0 && S[k] > s) k--;
  while (k < m - 2 && S[k + 1] <= s) k++;
  p.hk = k;
  const L = S[k + 1] - S[k];
  const x1 = X[k];
  const y1 = Y[k];
  const x2 = X[k + 1];
  const y2 = Y[k + 1];
  if (s > S[k + 1]) {
    // Past the last sample (the end of the data): straight on along the last chord that has a length.
    let j = k;
    while (j > 0 && !(S[j + 1] - S[j] >= 1)) j--;
    const Lj = S[j + 1] - S[j];
    if (!(Lj >= 1)) return { x: x2, y: y2 };
    const e = (s - S[k + 1]) / Lj;
    return { x: x2 + e * (X[j + 1] - X[j]), y: y2 + e * (Y[j + 1] - Y[j]) };
  }
  if (!(L > 0)) return { x: x2, y: y2 };
  const u = s <= S[k] ? 0 : (s - S[k]) / L;
  // Neighbours; a missing or zero-length one is mirrored (a straight continuation).
  let x0: number;
  let y0: number;
  let d01 = k > 0 ? S[k] - S[k - 1] : 0;
  if (d01 >= 1) {
    x0 = X[k - 1];
    y0 = Y[k - 1];
  } else {
    x0 = 2 * x1 - x2;
    y0 = 2 * y1 - y2;
    d01 = L;
  }
  let x3: number;
  let y3: number;
  let d23 = k + 2 < m ? S[k + 2] - S[k + 1] : 0;
  if (d23 >= 1) {
    x3 = X[k + 2];
    y3 = Y[k + 2];
  } else {
    // The last chord (a live tail): continue turning as the path did into it, so the next sample, when it
    // arrives, changes the curve as little as possible. Straight on after a zero-length chord or a sharp turn.
    const ax = x1 - x0;
    const ay = y1 - y0;
    const bx = x2 - x1;
    const by = y2 - y1;
    const n = d01 * L;
    const cos = (ax * bx + ay * by) / n;
    const sin = (ax * by - ay * bx) / n;
    if (k + 2 >= m && k > 0 && S[k] - S[k - 1] >= 1 && cos > 0.7) {
      x3 = x2 + bx * cos - by * sin;
      y3 = y2 + bx * sin + by * cos;
    } else {
      x3 = x2 + bx;
      y3 = y2 + by;
    }
    d23 = L;
  }
  // Chordal (alpha = 1) Catmull-Rom tangents at p1 and p2, scaled to the segment, in Hermite form.
  const a = L / d01;
  const b = L / (d01 + L);
  const c = L / (L + d23);
  const e = L / d23;
  const u2 = u * u;
  const u3 = u2 * u;
  const h00 = 2 * u3 - 3 * u2 + 1;
  const h10 = u3 - 2 * u2 + u;
  const h01 = -2 * u3 + 3 * u2;
  const h11 = u3 - u2;
  const m1x = (x1 - x0) * a - (x2 - x0) * b + (x2 - x1);
  const m1y = (y1 - y0) * a - (y2 - y0) * b + (y2 - y1);
  const m2x = x2 - x1 - (x3 - x1) * c + (x3 - x2) * e;
  const m2y = y2 - y1 - (y3 - y1) * c + (y3 - y2) * e;
  return { x: h00 * x1 + h10 * m1x + h01 * x2 + h11 * m2x, y: h00 * y1 + h10 * m1y + h01 * y2 + h11 * m2y };
}

// ---------------------------------------------------------------- building and extending

function fingerprint(loc: LocSeries, car: CarSeries, nLoc: number, nCar: number): number[] {
  return nLoc && nCar
    ? [loc.t[0], loc.t[nLoc - 1], loc.x[nLoc - 1], loc.y[nLoc - 1], car.t[0], car.t[nCar - 1], car.speed[nCar - 1]]
    : nLoc
      ? [loc.t[0], loc.t[nLoc - 1], loc.x[nLoc - 1], loc.y[nLoc - 1]]
      : nCar
        ? [car.t[0], car.t[nCar - 1], car.speed[nCar - 1]]
        : [];
}

/** Whether (loc, car) are the streams `p` was built from, possibly with samples appended. */
function extends_(p: CarPath, loc: LocSeries, car: CarSeries): boolean {
  if (loc.t.length < p.nLoc || car.t.length < p.nCar) return false;
  const now = fingerprint(loc, car, p.nLoc, p.nCar);
  return now.length === p.fp.length && now.every((v, i) => v === p.fp[i]);
}

function pitWindows(d: DriverData): number[] {
  const out: number[] = [];
  for (const s of [...d.pits].sort((a, b) => a.entry - b.entry)) out.push(s.entry - PIT_PRE_MS, s.entry + PIT_POST_MS);
  return out;
}

function build(loc: LocSeries, car: CarSeries, filter: Filter, pitWin: number[]): CarPath {
  const cap = loc.t.length + 1;
  const p: CarPath = {
    filter,
    pitWin,
    m: 0,
    T: new Float64Array(cap),
    X: new Float32Array(cap),
    Y: new Float32Array(cap),
    S: new Float64Array(cap),
    OFF: new Float32Array(cap),
    DLS: new Float32Array(cap),
    FL: new Uint8Array(cap),
    Dc: new Float64Array(Math.max(16, car.t.length)),
    lt: loc.t,
    ct: car.t,
    nLoc: 0,
    nCar: 0,
    fp: [],
    final: 0,
    tail: { base: 0, E: new Float64Array(0), R: new Float32Array(0), MED: new Float32Array(0), C: new Float32Array(0), RAW: new Int32Array(0) },
    hq: 0,
    hj: 0,
    hk: 0,
  };
  run(p, loc, car, 0);
  return p;
}

function extend(p: CarPath, loc: LocSeries, car: CarSeries): void {
  // Recompute from the first entry that may change (its look-back window must be in the kept tail state).
  const from = p.final;
  const f = p.filter;
  if (from > 0 && p.tail.base > Math.max(0, from - (f.medBack + f.meanBack + 1))) {
    Object.assign(p, build(loc, car, f, p.pitWin));
    return;
  }
  run(p, loc, car, from);
}

// Scratch for the filter state (entries [base, base + length)), shared by every build.
let scratchE = new Float64Array(0);
let scratchR = new Float32Array(0);
let scratchMED = new Float32Array(0);
let scratchC = new Float32Array(0);
let scratchRAW = new Int32Array(0);
const win = new Float64Array(Math.max(REPLAY.medBack + REPLAY.medAhead, LIVE.medBack + LIVE.medAhead) + 1);

function grow<A extends Float64Array | Float32Array | Uint8Array | Int32Array>(a: A, need: number): A {
  if (a.length >= need) return a;
  const out = new (a.constructor as new (n: number) => A)(Math.max(need, 2 * a.length, 16));
  out.set(a);
  return out;
}

/**
 * (Re)compute entries from `from` on, using the samples appended since. Entries before `from` are final, and
 * the filter state of the ones just before it is in p.tail.
 */
function run(p: CarPath, loc: LocSeries, car: CarSeries, from: number): void {
  const { live, medBack, medAhead, meanBack, meanAhead } = p.filter;
  const back = medBack + meanBack;
  const ahead = medAhead + meanAhead;
  const nLoc = loc.t.length;
  const nCar = car.t.length;
  const ct = car.t;
  const cv = car.speed;

  // Telemetry distance at each car sample (cumulative, never changes once computed).
  if (p.Dc.length < nCar) p.Dc = grow(p.Dc, nCar);
  const Dc = p.Dc;
  for (let j = Math.max(1, p.nCar); j < nCar; j++) Dc[j] = Dc[j - 1] + ((cv[j - 1] + cv[j]) * (ct[j] - ct[j - 1])) / 720;
  if (nCar > 0 && p.nCar === 0) Dc[0] = 0;

  // Scratch filter state, indexed from base, restored from the tail.
  const base = from === 0 ? 0 : p.tail.base;
  const need = nLoc - base + 1 + (from - base);
  if (scratchE.length < need) {
    const cap = Math.max(need, 2 * scratchE.length);
    scratchE = new Float64Array(cap);
    scratchR = new Float32Array(cap);
    scratchMED = new Float32Array(cap);
    scratchC = new Float32Array(cap);
    scratchRAW = new Int32Array(cap);
  }
  // Locals, not the module's `let`s, in the loops below (much faster in V8).
  const sE = scratchE;
  const sR = scratchR;
  const sMED = scratchMED;
  const sC = scratchC;
  const sRAW = scratchRAW;
  const tl = p.tail;
  for (let q = base; q < from; q++) {
    const i = q - tl.base;
    sE[q - base] = tl.E[i];
    sR[q - base] = tl.R[i];
    sMED[q - base] = tl.MED[i];
    sC[q - base] = tl.C[i];
    sRAW[q - base] = tl.RAW[i];
  }

  const cap = Math.max(p.T.length, from + (nLoc - (from > 0 ? sRAW[from - 1 - base] + 1 : 0)) + 1);
  if (p.T.length < cap) {
    p.T = grow(p.T, cap);
    p.X = grow(p.X, cap);
    p.Y = grow(p.Y, cap);
    p.S = grow(p.S, cap);
    p.OFF = grow(p.OFF, cap);
    p.DLS = grow(p.DLS, cap);
    p.FL = grow(p.FL, cap);
  }
  const { T, X, Y, S, DLS, FL } = p;
  const lt = loc.t;
  const lx = loc.x;
  const ly = loc.y;

  // ---- pass 1: keep, drop or hold back each location sample after the last final entry
  let m = from;
  let cj = 0; // car sample at or before the current location sample (moves both ways: relocations re-examine)
  let jL = -1; // same, for the last entry
  if (m > 0 && nCar > 0) {
    jL = search(ct, nCar, T[m - 1]);
    cj = Math.max(0, jL);
  }
  const PW = p.pitWin;
  let pend = -1; // first held-back (suspect) sample, -1 if none
  let pendEnd = -Infinity; // the end of the pit-entry window the held-back run started in, if it did
  let nPend = 0;
  let brk = false;
  // Live: only samples with telemetry on both sides (or that have waited long enough for it).
  const cutoff = !live || nLoc === 0 ? Infinity : Math.max(nCar > 0 ? ct[nCar - 1] : -Infinity, lt[nLoc - 1] - TEL_WAIT_MS);
  for (let j = from > 0 ? sRAW[from - 1 - base] + 1 : 0; j < nLoc; j++) {
    const tj = lt[j];
    if (tj > cutoff) break;
    // Car sample at or before tj, and the telemetry distance there.
    let jb = -1;
    let dl = 0;
    if (nCar > 0) {
      while (cj > 0 && ct[cj] > tj) cj--;
      while (cj + 1 < nCar && ct[cj + 1] <= tj) cj++;
      if (ct[cj] <= tj) {
        jb = cj;
        if (cj < nCar - 1) {
          const tau = tj - ct[cj];
          dl = Dc[cj] + (cv[cj] * tau + ((cv[cj + 1] - cv[cj]) * tau * tau) / (2 * (ct[cj + 1] - ct[cj]))) / 360;
        } else dl = Dc[cj];
      }
    }
    const xj = lx[j];
    const yj = ly[j];
    if (m === 0) {
      T[0] = tj;
      X[0] = xj;
      Y[0] = yj;
      S[0] = 0;
      FL[0] = 0;
      DLS[0] = dl;
      sE[-base] = 0;
      sR[-base] = 0;
      sRAW[-base] = j;
      m = 1;
      jL = jb;
      continue;
    }
    const L = m - 1;
    // Speed known all the way from the last entry to here: car samples on both sides, no long gap.
    let valid = jL >= 0 && jb >= 0 && (jb < nCar - 1 || ct[jb] === tj);
    if (valid) {
      const until = jb < nCar - 1 ? jb + 1 : jb;
      for (let k = jL; k < until; k++) {
        if (ct[k + 1] - ct[k] > TEL_GAP_MS) {
          valid = false;
          break;
        }
      }
    }
    const ex = xj - X[L];
    const ey = yj - Y[L];
    const ch = Math.sqrt(ex * ex + ey * ey);
    const dD = dl - (S[L] + DLS[L]);
    if (!brk && valid) {
      let suspect = false;
      const e = ch - dD;
      const tol = SUSPECT + (pendEnd > -Infinity ? PIT_FRAC : SUSPECT_FRAC) * dD;
      // Too far from where the telemetry says, or stale (it hardly moved while the car drove over 10 m).
      if (e > tol || -e > tol || (dD > STALE_DD && ch < STALE_FRAC * dD)) suspect = true;
      else if (dD * 360 > MOVING_KMH * (tj - T[L])) {
        // Travel direction: the last chord of at least DIR_MIN (a few entries back at most).
        for (let k = L; k > 0 && k > L - 8; k--) {
          const dx = X[k] - X[k - 1];
          const dy = Y[k] - Y[k - 1];
          const len = Math.sqrt(dx * dx + dy * dy);
          if (len >= DIR_MIN) {
            suspect = ex * dx + ey * dy < -BACK_TOL * len;
            break;
          }
        }
      }
      if (suspect) {
        if (pend < 0) {
          pend = j;
          for (let k = 0; k < PW.length; k += 2) {
            if (tj >= PW[k] && tj <= PW[k + 1]) {
              pendEnd = PW[k + 1];
              break;
            }
          }
        }
        nPend++;
        if (pendEnd > -Infinity ? tj > pendEnd : nPend > DROP_MAX || tj - lt[pend] > DROP_MAX_MS) {
          // Not a glitch: the car is over there now. Jump to the first held-back sample, then re-examine the rest.
          j = pend - 1;
          brk = true;
          pendEnd = -Infinity;
        }
        continue;
      }
    }
    // Keep j as entry q (held-back samples before it were glitches: dropped).
    pend = -1;
    nPend = 0;
    pendEnd = -Infinity;
    const q = m++;
    T[q] = tj;
    sRAW[q - base] = j;
    let fl = FL[L] & BREAK;
    const ePrev = sE[L - base];
    if (valid && dD < STILL_DD && ch < SNAP_R && !brk) {
      // Stationary: stay exactly where the car stopped (no creeping over the location noise).
      fl |= VALID | STILL;
      X[q] = X[L];
      Y[q] = Y[L];
      S[q] = S[L];
      sE[q - base] = ePrev + dD;
    } else {
      X[q] = xj;
      Y[q] = yj;
      S[q] = S[L] + ch;
      // Telemetry says still but the car moved: the speed is stuck, follow the samples instead.
      if (valid && !(dD < STILL_DD)) {
        fl |= VALID;
        sE[q - base] = ePrev + dD;
      } else sE[q - base] = ePrev + ch;
    }
    FL[L] = fl;
    FL[q] = brk ? BREAK : 0;
    brk = false;
    DLS[q] = dl - S[q];
    sR[q - base] = S[q] - sE[q - base];
    jL = jb;
  }

  // ---- pass 2: the smoothed offset and the anchors of entries [from, m)
  // The run (entries between relocations) containing `from`: its start as far back as the windows look.
  const OFF = p.OFF;
  let rs = from;
  while (rs > 0 && rs > from - (back + 1) && !(FL[rs] & BREAK)) rs--;
  let re = runEnd(FL, rs, m);
  // Medians of R over q-medBack..q+medAhead within the run, as a sliding sorted window.
  let w = 0;
  let lo = 0;
  let hi = -1;
  for (let q = from; q < m; q++) {
    if (q > re) {
      rs = q;
      re = runEnd(FL, q, m);
    }
    const nlo = Math.max(rs, q - medBack);
    const nhi = Math.min(re, q + medAhead);
    if (q === from || nlo > hi || nlo < lo) {
      w = 0;
      for (let k = nlo; k <= nhi; k++) w = insert(w, sR[k - base]);
    } else {
      for (let k = lo; k < nlo; k++) w = remove(w, sR[k - base]);
      for (let k = hi + 1; k <= nhi; k++) w = insert(w, sR[k - base]);
    }
    lo = nlo;
    hi = nhi;
    sMED[q - base] = win[w >> 1];
  }
  // The mean of those medians over q-meanBack..q+meanAhead (a running sum: exact, the terms are float32).
  rs = from;
  while (rs > 0 && rs > from - (back + 1) && !(FL[rs] & BREAK)) rs--;
  re = runEnd(FL, rs, m);
  let sum = 0;
  lo = 0;
  hi = -1;
  for (let q = from; q < m; q++) {
    if (q > re) {
      rs = q;
      re = runEnd(FL, q, m);
    }
    const nlo = Math.max(rs, q - meanBack);
    const nhi = Math.min(re, q + meanAhead);
    if (q === from || nlo > hi || nlo < lo) {
      sum = 0;
      for (let k = nlo; k <= nhi; k++) sum += sMED[k - base];
    } else {
      for (let k = lo; k < nlo; k++) sum -= sMED[k - base];
      for (let k = hi + 1; k <= nhi; k++) sum += sMED[k - base];
    }
    lo = nlo;
    hi = nhi;
    // Not enough samples ahead yet (the data ends before the run does): hold the offset (dead reckoning).
    const c = re === m - 1 && q + ahead > m - 1 ? (q > rs ? sC[q - 1 - base] : sR[q - base]) : sum / (nhi - nlo + 1);
    sC[q - base] = c;
    let off = Math.max(-MAX_OFF, Math.min(MAX_OFF, c - sR[q - base]));
    // Live, slow (stopping in the pit box, on the grid): never ahead of the newest sample, where the path
    // isn't known yet, so a car that stops there stays put when the samples after the stop arrive.
    if (live && q > 0 && (S[q] + DLS[q] - S[q - 1] - DLS[q - 1]) * 360 < SLOW_KMH * (T[q] - T[q - 1])) off = Math.min(off, 0);
    let a = S[q] + off;
    if (q > 0) {
      const prev = S[q - 1] + OFF[q - 1];
      if (FL[q - 1] & STILL || a < prev) a = prev;
    }
    OFF[q] = a - S[q];
  }

  // ---- bookkeeping: what's final, the tail state, the streams used
  p.m = m;
  // Entries whose telemetry isn't in yet (after the last car sample) will change, and the `ahead` before them.
  let qTel = m;
  if (nCar > 0) while (qTel > 0 && T[qTel - 1] >= ct[nCar - 1]) qTel--;
  else qTel = 0;
  p.final = live ? m : Math.max(from, Math.min(m - ahead - 2, qTel - ahead - 2));
  const tb = Math.max(0, p.final - (back + 2));
  const len = m - tb;
  const tail: Tail = {
    base: tb,
    E: sE.slice(tb - base, tb - base + len),
    R: sR.slice(tb - base, tb - base + len),
    MED: sMED.slice(tb - base, tb - base + len),
    C: sC.slice(tb - base, tb - base + len),
    RAW: sRAW.slice(tb - base, tb - base + len),
  };
  p.tail = tail;
  p.lt = loc.t;
  p.ct = car.t;
  p.nLoc = nLoc;
  p.nCar = nCar;
  p.fp = fingerprint(loc, car, nLoc, nCar);
  if (p.hq >= m) p.hq = 0;
  if (p.hk >= m) p.hk = 0;
}

/** Last entry of the run containing q (the entry before the next BREAK, or the last one). */
function runEnd(FL: Uint8Array, q: number, m: number): number {
  let k = q + 1;
  while (k < m && !(FL[k] & BREAK)) k++;
  return k - 1;
}

/** Sorted insert into win[0, w); returns the new count. */
function insert(w: number, v: number): number {
  let i = w;
  while (i > 0 && win[i - 1] > v) {
    win[i] = win[i - 1];
    i--;
  }
  win[i] = v;
  return w + 1;
}

/** Remove one v from the sorted win[0, w); returns the new count. */
function remove(w: number, v: number): number {
  let i = 0;
  while (i < w - 1 && win[i] !== v) i++;
  for (; i < w - 1; i++) win[i] = win[i + 1];
  return w - 1;
}
