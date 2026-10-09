// Track evolution in free practice: how much quicker the track got as rubber went down. Pure: the widget feeds it
// the laps, stints and safety car, VSC and red flag periods it has so far (nothing past t), and t itself (a lap
// race control deletes counts until the deletion).
//
// Every valid lap is a point at the session time it was set (its end). Two lines read the trend: the fastest lap so
// far by anyone (a step that only moves when someone pushes), and the median of each 10-minute window's push laps,
// the steadier signal: who happened to push when matters less to it.

import type { NeutralPeriod } from "widget-kit";

/** The part of a completed lap this needs. */
export interface EvoLap {
  lap: number;
  start: number;
  end: number | null;
  duration: number | null;
  pitOut: boolean;
  deleted?: { t: number; reason: string };
}

/** The part of a stint this needs. */
export interface EvoStint {
  lapStart: number;
  compound: string;
  ageAtStart: number | null;
}

/** A valid lap, as drawn. */
export interface EvoPoint {
  driver: number;
  lap: number;
  /** When the lap started (ms), to seek to, and ended: the point's x. */
  start: number;
  end: number;
  /** Seconds. */
  time: number;
  compound: string;
  /** Laps on the set before this one (a new set's first lap is 0). */
  age: number;
  /** Within PUSH of the driver's best valid lap so far. */
  push: boolean;
}

/** A new fastest lap by anyone: from `at` (ms) the fastest so far is `time`. */
export interface FastestStep {
  at: number;
  time: number;
  driver: number;
}

/** One WINDOW_MS window from the green light, and the median of its push laps. */
export interface EvoWindow {
  /** ms since t0. */
  from: number;
  to: number;
  median: number;
  laps: number;
}

export interface Evolution {
  /** Valid laps, in the order they ended. */
  points: EvoPoint[];
  records: FastestStep[];
  /** Windows with at least MIN_WINDOW_LAPS push laps, in order. */
  windows: EvoWindow[];
  /** Seconds the push-lap median came down from the first window to the latest (negative: slower). Null: < 2 windows. */
  gain: number | null;
}

/** A push lap: within this share of the driver's best valid lap so far. */
export const PUSH = 1.015;
/** Laps slower than this share of the fastest so far aren't drawn. */
export const CLIP = 1.07;
export const WINDOW_MS = 10 * 60_000;
/** Fewer push laps than this in a window and its median isn't drawn (one driver's lap isn't the track). */
export const MIN_WINDOW_LAPS = 3;

const median = (xs: readonly number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * One driver's valid laps at t, with their compound and tyre age: timed, not an out- or in-lap, not touched by a
 * neutral period and not deleted by t.
 */
export function validLaps(driver: number, laps: readonly EvoLap[], stints: readonly EvoStint[], neutral: readonly NeutralPeriod[], t: number): Omit<EvoPoint, "push">[] {
  const sorted = [...laps].sort((a, b) => a.lap - b.lap);
  const sets = [...stints].sort((a, b) => a.lapStart - b.lapStart);
  const out: Omit<EvoPoint, "push">[] = [];
  sorted.forEach((l, k) => {
    if (l.duration == null || !(l.duration > 0) || l.pitOut) return;
    if (l.deleted && t >= l.deleted.t) return;
    let i = -1;
    while (i + 1 < sets.length && sets[i + 1].lapStart <= l.lap) i++;
    const next = sets[i + 1];
    // An in-lap: the next lap leaves the pits, or the next set starts after it.
    if (sorted[k + 1]?.pitOut === true || (next != null && l.lap === next.lapStart - 1)) return;
    const end = l.end ?? l.start + l.duration * 1000;
    if (neutral.some((p) => p.start < end && l.start < (p.end ?? Infinity))) return;
    const set = sets[i];
    out.push({
      driver,
      lap: l.lap,
      start: l.start,
      end,
      time: l.duration,
      compound: set?.compound ?? "UNKNOWN",
      age: set ? (set.ageAtStart ?? 0) + l.lap - set.lapStart : 0,
    });
  });
  return out;
}

/** Every driver's valid laps so far, the fastest-lap steps and the push-lap median by window from the green light. */
export function evolution(
  laps: ReadonlyMap<number, readonly EvoLap[]>,
  stints: ReadonlyMap<number, readonly EvoStint[]>,
  neutral: readonly NeutralPeriod[],
  t: number,
  greenLight: number,
): Evolution {
  const points: EvoPoint[] = [];
  for (const [n, own] of laps) {
    const valid = validLaps(n, own, stints.get(n) ?? [], neutral, t);
    if (valid.length === 0) continue;
    const best = Math.min(...valid.map((l) => l.time));
    for (const l of valid) points.push({ ...l, push: l.time <= PUSH * best });
  }
  points.sort((a, b) => a.end - b.end || a.driver - b.driver);

  const records: FastestStep[] = [];
  for (const p of points) if (records.length === 0 || p.time < records.at(-1)!.time) records.push({ at: p.end, time: p.time, driver: p.driver });

  const byWindow = new Map<number, number[]>();
  for (const p of points) {
    if (!p.push) continue;
    const w = Math.floor((p.end - greenLight) / WINDOW_MS);
    if (!byWindow.has(w)) byWindow.set(w, []);
    byWindow.get(w)!.push(p.time);
  }
  const windows: EvoWindow[] = [...byWindow]
    .filter(([, times]) => times.length >= MIN_WINDOW_LAPS)
    .sort(([a], [b]) => a - b)
    .map(([w, times]) => ({ from: greenLight + w * WINDOW_MS, to: greenLight + (w + 1) * WINDOW_MS, median: median(times), laps: times.length }));
  const gain = windows.length >= 2 ? windows[0].median - windows.at(-1)!.median : null;
  return { points, records, windows, gain };
}

/** The track temperature at `at` (the last sample by then, else the first), from samples up to t. */
export function trackTempAt(samples: readonly { t: number; trackTemp: number }[], at: number): number | null {
  if (samples.length === 0) return null;
  let found = samples[0];
  for (const s of samples) {
    if (s.t > at) break;
    found = s;
  }
  return found.trackTemp;
}

/** Minutes from the green light: 600_000 ms after it -> "10". */
export const minutes = (ms: number, greenLight: number) => String(Math.round((ms - greenLight) / 60_000));

/** The header's caption: "1.2 s quicker since the first runs", or slower. */
export function gainText(gain: number): string {
  const s = Math.abs(gain).toFixed(gain !== 0 && Math.abs(gain) < 0.1 ? 2 : 1);
  return Number(s) === 0 ? "no quicker than in the first runs" : `${s} s ${gain > 0 ? "quicker" : "slower"} since the first runs`;
}
