// Distance-aligned lap traces (laps/<driver>.json, LapTrace in src/types.ts), so two drivers' laps can be
// overlaid: shared by qualifying (quali.ts) and finished free practice sessions (practice.ts). Pure: no file or
// network I/O.
//
// Distance alignment. Each full lap (timing line to timing line) gets a distance per car sample:
//   1. Lap starts. OpenF1's `date_start` jitters by up to ~1 s, but lap durations are exact official
//      times, so within a run of consecutive laps each start is the run's anchor plus the preceding
//      durations; the anchor is the median of the laps' own starts and their GPS timing-line
//      crossings (each shifted back by the preceding durations).
//   2. Distance comes from integrating the speed trace (smooth, and immune to location-feed gaps),
//      normalized piecewise between four anchors whose times are exact: the line (0), the sector 2
//      and 3 boundaries (from the official sector times) and the line again (the lap length). The
//      anchor distances are session constants: medians over the full-speed laps.
//   3. The location trace is only used for the car's position, and to validate step 2: GPS positions
//      projected onto the track outline are compared with the aligned distance (see the report).

import type { CleanTelemetry } from "./normalize";
import type { DriverLapTraces, Lap, LapTrace, Ms, TrackGeometry } from "../../src/types";

const GAP_MS = 1_500; // car data missing between two samples this far apart
const TRACE_MAX_GAP_MS = 8_000; // no trace for laps with a longer car-data gap...
const MAX_GAP_SHARE = 0.15; // ...or with more of the lap missing than this
const FROZEN_MS = 1_000; // identical samples for this long while moving: a stuck feed
const FROZEN_MIN_SPEED = 50; // km/h

export const median = (xs: number[]) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
export const quantile = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * s.length)))] ?? NaN;
};
const encodeDeltas = (xs: number[]) => xs.map((x, i) => (i === 0 ? x : x - xs[i - 1]));

/** Index of the last element <= t in ascending `xs`, or -1. */
export function lastAtOrBefore(xs: ArrayLike<number>, t: number): number {
  let lo = 0;
  let hi = xs.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

/** Linear interpolation of ys over ascending xs at x (clamped to the ends). */
export function lerpAt(xs: ArrayLike<number>, ys: ArrayLike<number>, x: number): number {
  const n = xs.length;
  if (!n) return NaN;
  const i = lastAtOrBefore(xs, x);
  if (i < 0) return ys[0];
  if (i >= n - 1) return ys[n - 1];
  const span = xs[i + 1] - xs[i];
  return span > 0 ? ys[i] + ((x - xs[i]) / span) * (ys[i + 1] - ys[i]) : ys[i];
}

type Telemetry = ReadonlyMap<number, CleanTelemetry>;

/** Where the timing line is (location units) and the direction of travel across it. */
export interface TimingLine {
  x: number;
  y: number;
  ux: number;
  uy: number;
}

/** The timing line: the median car position at lap starts (laps 2+, not out-laps); null with fewer than 20. */
export function timingLine(laps: readonly Lap[], telemetry: Telemetry): TimingLine | null {
  function locAt(n: number, t: Ms): { x: number; y: number; dx: number; dy: number } | null {
    const loc = telemetry.get(n)?.loc;
    if (!loc || loc.t.length < 2) return null;
    const i = lastAtOrBefore(loc.t, t);
    if (i < 0 || i >= loc.t.length - 1 || loc.t[i + 1] - loc.t[i] > 1_500) return null;
    const f = (t - loc.t[i]) / (loc.t[i + 1] - loc.t[i]);
    const dx = loc.x[i + 1] - loc.x[i];
    const dy = loc.y[i + 1] - loc.y[i];
    return { x: loc.x[i] + f * dx, y: loc.y[i] + f * dy, dx, dy };
  }
  const lineXs: number[] = [];
  const lineYs: number[] = [];
  let hx = 0;
  let hy = 0;
  for (const l of laps) {
    if (l.lap < 2 || l.pitOut) continue;
    const p = locAt(l.driver, l.start);
    if (!p) continue;
    lineXs.push(p.x);
    lineYs.push(p.y);
    const len = Math.hypot(p.dx, p.dy);
    if (len > 0) {
      hx += p.dx / len;
      hy += p.dy / len;
    }
  }
  const hl = Math.hypot(hx, hy);
  return lineXs.length >= 20 && hl > 0 ? { x: median(lineXs), y: median(lineYs), ux: hx / hl, uy: hy / hl } : null;
}

/** When a car crossed the timing line on the main straight (not in the pit lane), from its location trace. */
export function lineCrossings(line: TimingLine | null, loc: CleanTelemetry["loc"] | undefined): Ms[] {
  if (!line || !loc) return [];
  const out: Ms[] = [];
  for (let i = 1; i < loc.t.length; i++) {
    const a = (loc.x[i - 1] - line.x) * line.ux + (loc.y[i - 1] - line.y) * line.uy;
    const b = (loc.x[i] - line.x) * line.ux + (loc.y[i] - line.y) * line.uy;
    if (!(a < 0 && b >= 0) || b - a > 1_500 || loc.t[i] - loc.t[i - 1] > 1_500) continue;
    const f = -a / (b - a);
    const off = -(loc.x[i - 1] + f * (loc.x[i] - loc.x[i - 1]) - line.x) * line.uy + (loc.y[i - 1] + f * (loc.y[i] - loc.y[i - 1]) - line.y) * line.ux;
    if (Math.abs(off) < 300) out.push(loc.t[i - 1] + f * (loc.t[i] - loc.t[i - 1])); // main straight only (not the pit lane)
  }
  return out;
}

/**
 * Chain lap starts through the official lap durations within each run of consecutive laps (step 1 above). A run
 * starts after a pit-out lap (which has no lap time to chain through). `lapsOf`: each driver's laps by lap number.
 * Mutates the laps' start and end; returns how far starts moved (ms) and how many runs were left alone.
 */
export function chainLapStarts(lapsOf: ReadonlyMap<number, Lap[]>, crossings: (driver: number) => Ms[]): { moves: number[]; brokenRuns: number } {
  const moves: number[] = [];
  let brokenRuns = 0;
  for (const [n, own] of lapsOf) {
    const cross = crossings(n);
    const runs: Lap[][] = [];
    let run: Lap[] = [];
    for (const l of own) {
      const prev = run.at(-1);
      if (prev && l.lap === prev.lap + 1 && prev.duration != null && !prev.pitOut && !l.pitOut) run.push(l);
      else {
        if (run.length) runs.push(run);
        run = [l];
      }
    }
    if (run.length) runs.push(run);
    for (const r of runs) {
      if (r[0].pitOut) continue; // a lone out-lap: starts at the pit exit, nothing to chain
      const cum: number[] = [];
      let acc = 0;
      for (const l of r) {
        cum.push(acc);
        acc += (l.duration ?? 0) * 1000;
      }
      const votes: number[] = [];
      r.forEach((l, i) => {
        votes.push(l.start - cum[i]);
        const c = cross.find((c) => Math.abs(c - l.start) < 1_500);
        if (c != null) votes.push(c - cum[i]);
      });
      const anchor = median(votes);
      // Durations that don't chain (a lost record in between) leave the run alone.
      if (r.some((l, i) => Math.abs(l.start - (anchor + cum[i])) > 2_500)) {
        brokenRuns++;
        continue;
      }
      r.forEach((l, i) => {
        const start = Math.round(anchor + cum[i]);
        moves.push(Math.abs(start - l.start));
        l.start = start;
        if (l.duration != null) l.end = start + Math.round(l.duration * 1000);
      });
    }
  }
  return { moves, brokenRuns };
}

export interface LapTraceResult {
  /** By driver, laps in lap order. */
  traces: Map<number, DriverLapTraces>;
  /** The traced laps, by `${driver}:${lap}`. */
  traced: Set<string>;
  /** Metres, timing line to timing line (median over the measured laps); NaN without any. Not rounded. */
  lapLength: number;
  /** Metres from the timing line to the sector 2 and 3 boundaries. Not rounded. */
  sectorDistances: [number, number];
  /** Summary for ingest's output: the distances, then the traces. */
  lines: string[];
  problems: string[];
}

/**
 * Traces for `laps` (each a timed lap, start and end on the timing line; in the order given), with the session's
 * lap length and sector boundaries measured on the laps `measure` picks (laps at full speed). Laps with too much car
 * data missing get none. Steps 2 and 3 above.
 */
export function buildLapTraces(laps: readonly Lap[], measure: (l: Lap) => boolean, telemetry: Telemetry, track: TrackGeometry): LapTraceResult {
  const problems: string[] = [];
  const carOf = (n: number): CleanTelemetry["car"] | null => telemetry.get(n)?.car ?? null;
  const locOf = (n: number) => telemetry.get(n)?.loc;

  // OpenF1's car-data feed sometimes sticks: every channel repeats for seconds while the car moves
  // (2026 Monza: 307 km/h, 7th gear, full throttle straight through the first chicane). Such samples
  // are dropped, and the gap they leave is bridged below.
  const frozenCache = new Map<number, Uint8Array>();
  function frozenOf(n: number): Uint8Array {
    let mask = frozenCache.get(n);
    if (mask) return mask;
    const c = carOf(n)!;
    mask = new Uint8Array(c.t.length);
    const same = (a: number, b: number) =>
      c.speed[a] === c.speed[b] && c.rpm[a] === c.rpm[b] && c.gear[a] === c.gear[b] && c.throttle[a] === c.throttle[b] && c.brake[a] === c.brake[b];
    for (let i = 0; i < c.t.length; ) {
      let j = i;
      while (j + 1 < c.t.length && same(j + 1, i)) j++;
      if (c.speed[i] > FROZEN_MIN_SPEED && c.t[j] - c.t[i] >= FROZEN_MS) for (let k = i + 1; k <= j; k++) mask[k] = 1;
      i = j + 1;
    }
    frozenCache.set(n, mask);
    return mask;
  }

  interface Integrated {
    t: number[]; // ms since t0: the lap's good car samples, plus exact samples on the line at both ends
    v: number[]; // km/h
    gap: boolean[]; // gap[k]: no car data between samples k - 1 and k (dropout or frozen feed)
    D: number[]; // m, integrated from the speed trace (gaps bridged at the mean of their ends)
  }
  /** The lap's samples from line to line with integrated distance, or null if too much is missing. */
  function integrate(l: Lap): Integrated | null {
    const car = carOf(l.driver);
    if (!car || l.end == null || car.t.length < 3) return null;
    const frozen = frozenOf(l.driver);
    let before = lastAtOrBefore(car.t, l.start);
    while (before >= 0 && frozen[before]) before--;
    if (before < 0) return null;
    const inside: number[] = [];
    let after = -1;
    for (let i = before + 1; i < car.t.length; i++) {
      if (frozen[i]) continue;
      if (car.t[i] >= l.end) {
        after = i;
        break;
      }
      inside.push(i);
    }
    if (after < 0 || !inside.length) return null;
    const vAt = (t: number, a: number, b: number) => car.speed[a] + ((t - car.t[a]) / (car.t[b] - car.t[a] || 1)) * (car.speed[b] - car.speed[a]);
    const t = [l.start, ...inside.map((i) => car.t[i]), l.end];
    const v = [vAt(l.start, before, inside[0]), ...inside.map((i) => car.speed[i]), vAt(l.end, inside.at(-1)!, after)];
    const gap = t.map((x, k) => k > 0 && x - t[k - 1] > GAP_MS);
    // Around the line the neighbouring samples count too.
    const edgeGaps = [inside[0], after].map((i, k) => car.t[i] - car.t[k === 0 ? before : inside.at(-1)!]);
    let gapTime = 0;
    for (let k = 1; k < t.length; k++) {
      const dt = t[k] - t[k - 1];
      if (dt > TRACE_MAX_GAP_MS) return null;
      if (gap[k]) gapTime += dt;
    }
    if (Math.max(...edgeGaps) > TRACE_MAX_GAP_MS || gapTime > MAX_GAP_SHARE * (l.end - l.start)) return null;
    const D = [0];
    for (let k = 1; k < t.length; k++) D.push(D[k - 1] + (((v[k - 1] + v[k]) / 2 / 3.6) * (t[k] - t[k - 1])) / 1000);
    return { t, v, gap, D };
  }

  let filledGaps = 0;
  /**
   * Distance per sample, pinned at the anchors (time, distance). Between two anchors the integrated
   * distance is scaled to fit; if data is missing there, the good samples keep their integrated
   * distance and the gaps get the rest (unless that's implausible: then everything is scaled).
   */
  function align(it: Integrated, anchors: [number, number][]): { t: number[]; v: number[]; d: number[] } {
    // Samples with the (sector) anchors inserted, so every increment lies between two anchors.
    const tt: number[] = [];
    const vv: number[] = [];
    const gg: boolean[] = [];
    let a = 1;
    for (let k = 0; k < it.t.length; k++) {
      while (a < anchors.length - 1 && anchors[a][0] < it.t[k]) {
        const ta = anchors[a][0];
        if (k > 0 && ta > it.t[k - 1]) {
          const f = (ta - it.t[k - 1]) / (it.t[k] - it.t[k - 1]);
          tt.push(ta);
          vv.push(it.v[k - 1] + f * (it.v[k] - it.v[k - 1]));
          gg.push(it.gap[k]);
        }
        a++;
      }
      tt.push(it.t[k]);
      vv.push(it.v[k]);
      gg.push(it.gap[k]);
    }
    const inc = tt.map((t, k) => (k === 0 ? 0 : (((vv[k - 1] + vv[k]) / 2 / 3.6) * (t - tt[k - 1])) / 1000));
    const anchorIdx = anchors.map(([ta]) => {
      let best = 0;
      for (let k = 0; k < tt.length; k++) if (Math.abs(tt[k] - ta) < Math.abs(tt[best] - ta)) best = k;
      return best;
    });
    const out = new Array<number>(tt.length).fill(0);
    for (let j = 0; j + 1 < anchors.length; j++) {
      const [from, to] = [anchorIdx[j], anchorIdx[j + 1]];
      const span = anchors[j + 1][1] - anchors[j][1];
      let good = 0;
      let missing = 0;
      for (let k = from + 1; k <= to; k++) (gg[k] ? (missing += inc[k]) : (good += inc[k]));
      let goodScale = good + missing > 0 ? span / (good + missing) : 0;
      let gapScale = goodScale;
      if (missing > 0 && good < span && (span - good) / missing >= 0.25 && (span - good) / missing <= 2.5) {
        goodScale = 1;
        gapScale = (span - good) / missing;
        filledGaps++;
      }
      out[from] = anchors[j][1];
      for (let k = from + 1; k <= to; k++) out[k] = out[k - 1] + inc[k] * (gg[k] ? gapScale : goodScale);
    }
    // The sector-line samples stay in the trace: they pin the distance where the times are exact.
    return { t: tt, v: vv, d: out };
  }

  const integrated = new Map<string, Integrated>();
  const lapByKey = new Map<string, Lap>();
  let dropouts = 0;
  for (const l of laps) {
    if (l.duration == null || l.end == null) continue;
    const key = `${l.driver}:${l.lap}`;
    lapByKey.set(key, l);
    const it = integrate(l);
    if (it) integrated.set(key, it);
    else dropouts++;
  }
  const frozenSamples = [...frozenCache.values()].reduce((s, m) => s + m.reduce((a, b) => a + b, 0), 0);

  // Session constants from complete full-speed laps: lap length and where the sector boundaries are.
  const lengths: number[] = [];
  const f1s: number[] = [];
  const f2s: number[] = [];
  const sectorTimes = (l: Lap): [number | null, number | null] => {
    const [s1, s2] = l.sectors;
    const a = s1 != null ? l.start + s1 * 1000 : null;
    const b = s1 != null && s2 != null ? l.start + (s1 + s2) * 1000 : null;
    return [a != null && a < l.end! ? a : null, b != null && b < l.end! ? b : null];
  };
  for (const [key, it] of integrated) {
    const l = lapByKey.get(key)!;
    if (!measure(l) || it.gap.some(Boolean)) continue;
    const total = it.D.at(-1)!;
    lengths.push(total);
    const [a, b] = sectorTimes(l);
    if (a != null) f1s.push(lerpAt(it.t, it.D, a) / total);
    if (b != null) f2s.push(lerpAt(it.t, it.D, b) / total);
  }
  const lapLength = median(lengths);
  const sectorDistances: [number, number] = [median(f1s) * lapLength, median(f2s) * lapLength];
  if (!Number.isFinite(lapLength)) problems.push("no push laps to measure the lap length");

  const traces = new Map<number, DriverLapTraces>();
  const traced = new Set<string>();
  const spread: number[] = []; // integrated lap distance / lap length - 1 (complete laps)
  for (const [key, it] of integrated) {
    if (!Number.isFinite(lapLength)) break;
    const l = lapByKey.get(key)!;
    const [a, b] = sectorTimes(l);
    const anchors: [number, number][] = [[l.start, 0]];
    if (a != null && Number.isFinite(sectorDistances[0])) anchors.push([a, sectorDistances[0]]);
    if (b != null && Number.isFinite(sectorDistances[1])) anchors.push([b, sectorDistances[1]]);
    anchors.push([l.end!, lapLength]);
    if (!it.gap.some(Boolean)) spread.push(it.D.at(-1)! / lapLength - 1);
    const { t: ts, v: vs, d } = align(it, anchors);
    d[d.length - 1] = lapLength;
    for (let k = 1; k < d.length; k++) d[k] = Math.max(d[k], d[k - 1]);

    const car = carOf(l.driver)!;
    const loc = locOf(l.driver);
    // Step channels (brake, gear) hold their last value; the line samples take the neighbour's.
    const step = (arr: number[], t: number) => arr[Math.max(0, lastAtOrBefore(car.t, t))];
    const trace: LapTrace = {
      lap: l.lap,
      t: encodeDeltas(ts.map((t) => Math.round(t - l.start))),
      d: encodeDeltas(d.map((x) => Math.round(x * 10))),
      speed: vs.map((v) => Math.round(v)),
      throttle: ts.map((t) => Math.round(lerpAt(car.t, car.throttle, t))),
      brake: ts.map((t) => step(car.brake, t)),
      gear: ts.map((t) => step(car.gear, t)),
      x: ts.map((t) => (loc && loc.t.length ? Math.round(lerpAt(loc.t, loc.x, t)) : 0)),
      y: ts.map((t) => (loc && loc.t.length ? Math.round(lerpAt(loc.t, loc.y, t)) : 0)),
    };
    if (!traces.has(l.driver)) traces.set(l.driver, { driver: l.driver, laps: [] });
    traces.get(l.driver)!.laps.push(trace);
    traced.add(key);
  }
  for (const tr of traces.values()) tr.laps.sort((a, b) => a.lap - b.lap);

  // Validation: GPS positions projected onto the outline vs the aligned distance.
  const { outline } = track;
  const ox = [...outline.x, outline.x[0]];
  const oy = [...outline.y, outline.y[0]];
  const os = [0];
  for (let i = 1; i < ox.length; i++) os.push(os[i - 1] + Math.hypot(ox[i] - ox[i - 1], oy[i] - oy[i - 1]));
  const outlineLength = os.at(-1)! / 10; // m
  const scale = lapLength / outlineLength;
  function project(x: number, y: number, near: number): number {
    // Nearest outline point within ±400 m of where the aligned distance says the car is.
    let best = NaN;
    let bestD = Infinity;
    for (let i = 1; i < ox.length; i++) {
      const s = (os[i - 1] / 10) * scale;
      let ds = Math.abs(s - near);
      ds = Math.min(ds, lapLength - ds);
      if (ds > 400) continue;
      const dx = ox[i] - ox[i - 1];
      const dy = oy[i] - oy[i - 1];
      const f = Math.min(1, Math.max(0, ((x - ox[i - 1]) * dx + (y - oy[i - 1]) * dy) / (dx * dx + dy * dy || 1)));
      const dd = (ox[i - 1] + f * dx - x) ** 2 + (oy[i - 1] + f * dy - y) ** 2;
      if (dd < bestD) {
        bestD = dd;
        best = ((os[i - 1] + f * (os[i] - os[i - 1])) / 10) * scale;
      }
    }
    return best;
  }
  const rmsByLap: number[] = [];
  const offsets: number[] = [];
  for (const tr of traces.values()) {
    for (const lt of tr.laps) {
      let acc = 0;
      const d = lt.d.map((x) => (acc += x) / 10);
      const diffs: number[] = [];
      d.forEach((dist, k) => {
        const s = project(lt.x[k], lt.y[k], dist);
        if (Number.isNaN(s)) return;
        let diff = s - dist;
        if (diff > lapLength / 2) diff -= lapLength;
        if (diff < -lapLength / 2) diff += lapLength;
        diffs.push(diff);
      });
      if (diffs.length < 20) continue;
      const off = median(diffs);
      offsets.push(off);
      rmsByLap.push(Math.sqrt(diffs.reduce((s, x) => s + (x - off) ** 2, 0) / diffs.length));
    }
  }

  const traceCount = [...traces.values()].reduce((s, t) => s + t.laps.length, 0);
  const lines = [
    `distance: lap ${lapLength.toFixed(1)} m (GPS outline ${outlineLength.toFixed(1)} m), sector boundaries at ${sectorDistances[0].toFixed(0)} / ${sectorDistances[1].toFixed(0)} m; ` +
      `speed-integrated laps within ${(quantile(spread, 0.05) * 100).toFixed(2)}%..+${(quantile(spread, 0.95) * 100).toFixed(2)}% (p5..p95) of it before alignment`,
    `traces: ${traceCount} laps for ${traces.size} drivers${dropouts ? ` (${dropouts} laps skipped: too much car data missing)` : ""}, ` +
      `${frozenSamples} frozen car-data samples in the session skipped (${filledGaps} gaps bridged from the sector length); ` +
      `aligned distance vs GPS projection: RMS median ${median(rmsByLap).toFixed(1)} m, p95 ${quantile(rmsByLap, 0.95).toFixed(1)} m (constant offset ${median(offsets).toFixed(1)} m)`,
  ];
  return { traces, traced, lapLength, sectorDistances, lines, problems };
}
