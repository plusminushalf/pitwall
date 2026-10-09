// Top speed against lap time, a dot per driver (or team): where a car's lap time comes from. Low drag shows as a high
// top speed; downforce as lap time found with less of it. Pure: the widget feeds it the laps, stints and safety car,
// VSC and red flag periods it has so far (nothing past t), and the laps race control has deleted by then.
//
// A lap counts (is valid) when it's timed, isn't an out-lap or an in-lap, isn't touched by a neutral period and hasn't
// been deleted. A push lap is a valid lap within PUSH of the driver's best valid lap. Top speed comes from the push
// laps' speed trap (the intermediate 2 trap where the speed trap has no reading): a tow inflates one reading, so with
// three or more it's the median of the top three, else the highest.

import type { NeutralPeriod } from "widget-kit";

/** The part of a completed lap this needs; `deleted`: race control has deleted its time by now. */
export interface SpeedLap {
  lap: number;
  start: number;
  end: number | null;
  duration: number | null;
  pitOut: boolean;
  st: number | null;
  i2: number | null;
  deleted: boolean;
}

/** The part of a stint this needs. */
export interface SpeedStint {
  lapStart: number;
  compound: string;
  ageAtStart: number | null;
}

/** A push lap is within this share of the driver's best valid lap. */
export const PUSH = 1.015;
/** Traps on push laps from which the median of the top three is taken, not the highest. */
export const TOP_N = 3;

export interface ValidLap {
  lap: number;
  start: number;
  /** Seconds. */
  time: number;
  /** km/h: the speed trap, else intermediate 2; null with neither. */
  trap: number | null;
  compound: string;
  /** Laps on the set, null when the set's age isn't known. */
  age: number | null;
}

/** A driver's valid laps, in order, with the tyre each was on. */
export function validLaps(laps: readonly SpeedLap[], stints: readonly SpeedStint[], neutral: readonly NeutralPeriod[]): ValidLap[] {
  const sorted = [...laps].sort((a, b) => a.lap - b.lap);
  const byLap = new Map(sorted.map((l) => [l.lap, l]));
  const ordered = [...stints].sort((a, b) => a.lapStart - b.lapStart);
  const out: ValidLap[] = [];
  for (const l of sorted) {
    if (l.duration == null || !(l.duration > 0) || l.pitOut || l.deleted) continue;
    let k = -1;
    while (k + 1 < ordered.length && ordered[k + 1].lapStart <= l.lap) k++;
    const stint = ordered[k];
    const next = ordered[k + 1];
    // An in-lap: the next lap is an out-lap, or the next stint starts after it.
    if (byLap.get(l.lap + 1)?.pitOut || (next != null && next.lapStart === l.lap + 1)) continue;
    const end = l.end ?? l.start + l.duration * 1000;
    if (neutral.some((p) => p.start < end && l.start < (p.end ?? Infinity))) continue;
    out.push({
      lap: l.lap,
      start: l.start,
      time: l.duration,
      trap: l.st ?? l.i2,
      compound: stint?.compound ?? "UNKNOWN",
      age: stint && stint.ageAtStart != null ? stint.ageAtStart + l.lap - stint.lapStart : null,
    });
  }
  return out;
}

/** The valid laps within PUSH of the fastest of them. */
export function pushLaps(valid: readonly ValidLap[]): ValidLap[] {
  if (valid.length === 0) return [];
  const best = Math.min(...valid.map((l) => l.time));
  return valid.filter((l) => l.time <= best * PUSH);
}

export type SpeedMethod = "median" | "max";

/** Top speed from trap readings: the median of the top TOP_N with that many, else the highest. Null with none. */
export function topSpeed(traps: readonly number[]): { speed: number; method: SpeedMethod; readings: number } | null {
  if (traps.length === 0) return null;
  const top = [...traps].sort((a, b) => b - a);
  return top.length >= TOP_N ? { speed: top[1], method: "median", readings: top.length } : { speed: top[0], method: "max", readings: top.length };
}

/** One dot: a driver, or a team (both its cars' push laps, its best lap). */
export interface Dot {
  /** Driver number, or team name. */
  key: string;
  /** The driver whose best lap it is (seeked to and focused on click). */
  driver: number;
  /** km/h. */
  speed: number;
  method: SpeedMethod;
  readings: number;
  /** The best lap: its number, start (ms), time (s), tyre. */
  best: ValidLap;
  /** Seconds behind the fastest dot's best lap (0: the fastest). */
  gap: number;
}

/** One driver's laps so far, or a team's drivers' together. */
export interface Entry {
  key: string;
  drivers: { driver: number; valid: readonly ValidLap[] }[];
}

/** The dots: each entry's top speed over its drivers' push laps and its best lap, with gaps to the fastest. */
export function dots(entries: readonly Entry[]): Dot[] {
  const raw = entries.flatMap((e) => {
    let best: { driver: number; lap: ValidLap } | null = null;
    const traps: number[] = [];
    for (const d of e.drivers) {
      for (const l of pushLaps(d.valid)) {
        if (l.trap != null) traps.push(l.trap);
        if (!best || l.time < best.lap.time) best = { driver: d.driver, lap: l };
      }
    }
    const top = topSpeed(traps);
    return best && top ? [{ key: e.key, driver: best.driver, ...top, best: best.lap }] : [];
  });
  const fastest = Math.min(...raw.map((d) => d.best.time));
  return raw.map((d) => ({ ...d, gap: d.best.time - fastest }));
}

export const median = (xs: readonly number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// ---------------------------------------------------------------- labels

export type Side = "right" | "left" | "above" | "below";

/** A dot on screen and its label's width (px). */
export interface Placing {
  x: number;
  y: number;
  w: number;
}

/**
 * A side for each dot's label, in order: the first of right, left, above, below where it overlaps no label placed
 * already and no other dot, and stays inside the plot's `width`; else the side with more room. Labels are `h` px tall and sit
 * `gap` px from their dot.
 */
export function placeLabels(points: readonly Placing[], width: number, h = 11, gap = 6, r = 4): Side[] {
  type Box = [number, number, number, number];
  const boxOf = (p: Placing, side: Side): Box => {
    if (side === "right") return [p.x + gap, p.y - h / 2, p.x + gap + p.w, p.y + h / 2];
    if (side === "left") return [p.x - gap - p.w, p.y - h / 2, p.x - gap, p.y + h / 2];
    if (side === "above") return [p.x - p.w / 2, p.y - r - 2 - h, p.x + p.w / 2, p.y - r - 2];
    return [p.x - p.w / 2, p.y + r + 2, p.x + p.w / 2, p.y + r + 2 + h];
  };
  const overlaps = (a: Box, b: Box) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
  const dotBoxes: Box[] = points.map((p) => [p.x - r, p.y - r, p.x + r, p.y + r]);
  const placed: Box[] = [];
  return points.map((p, i) => {
    const sides: Side[] = ["right", "left", "above", "below"];
    const side =
      sides.find((s) => {
        const b = boxOf(p, s);
        return b[0] >= 0 && b[2] <= width && !placed.some((o) => overlaps(o, b)) && !dotBoxes.some((d, k) => k !== i && overlaps(d, b));
      }) ?? (p.x > width / 2 ? "left" : "right");
    placed.push(boxOf(p, side));
    return side;
  });
}
