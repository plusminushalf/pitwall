// Push laps in free practice, set by set (quali simulations): on each tyre set a driver pushed on, the first push
// lap, the best one, how many there were, and the drop from the 1st push to the 2nd, which is the thermal-degradation
// signal (a set that holds its grip gives a 2nd push close to the 1st). Pure: the widget feeds it the laps, stints and
// safety car, VSC and red flag periods it has so far (nothing past t), with the laps deleted by t marked.
//
// A lap is valid when it's timed, not an out-lap or an in-lap, not touched by a neutral period and not deleted. A
// push lap is a valid lap within PUSH (101.5%) of the driver's best valid lap so far, or within PUSH of the best
// valid lap on its own set when that set's best is within SET_PACE (103%) of the driver's best (pushes on harder
// tyres, early on a heavier car; a long run's set is further off, so its laps don't count).

import type { NeutralPeriod } from "widget-kit";

/** The part of a completed lap this needs; `deleted`: race control has deleted it by t (track limits). */
export interface PushLap {
  lap: number;
  start: number;
  end: number | null;
  duration: number | null;
  pitOut: boolean;
  deleted: boolean;
}

/** The part of a stint this needs. */
export interface PushStint {
  stint: number;
  lapStart: number;
  compound: string;
  ageAtStart: number;
}

/** One driver's push laps on one set. */
export interface SetPushes {
  driver: number;
  stint: number;
  compound: string;
  /** Laps on the set before the first push lap (the out-lap counts: a new set's first push is usually 1). */
  age: number;
  /** The push laps, in order, and their times (s). */
  laps: number[];
  times: number[];
  /** Seconds: the 1st push lap and the best. */
  first: number;
  best: number;
  /** Seconds: the 2nd push lap minus the 1st (positive: slower), null with one push only. */
  drop: number | null;
  /** When the first push lap started (ms), to seek to, and when the last one ended. */
  start: number;
  end: number;
}

/** Within this share of the best lap: a push lap. */
export const PUSH = 1.015;
/** A set whose best is within this share of the driver's best is a set pushed on, judged against its own best. */
export const SET_PACE = 1.03;

interface Valid {
  lap: number;
  start: number;
  end: number;
  time: number;
  stint: number;
}

/** One driver's sets with at least one push lap, in the order driven. */
export function pushSets(driver: number, laps: readonly PushLap[], stints: readonly PushStint[], neutral: readonly NeutralPeriod[]): SetPushes[] {
  const sorted = [...stints].sort((a, b) => a.lapStart - b.lapStart);
  const byLap = new Map(laps.map((l) => [l.lap, l]));
  const valid: Valid[] = [];
  for (const l of [...laps].sort((a, b) => a.lap - b.lap)) {
    // The stint that holds it (none: a lap before OpenF1's first stint, its tyre unknown).
    const after = sorted.findIndex((s) => s.lapStart > l.lap);
    const i = (after < 0 ? sorted.length : after) - 1;
    if (i < 0) continue;
    const s = sorted[i];
    const next = sorted[i + 1];
    const inLap = byLap.get(l.lap + 1)?.pitOut === true || (next != null && l.lap === next.lapStart - 1);
    // (A later stint's first lap is its out-lap, as long runs treat it, flagged or not.)
    const outLap = l.pitOut || (i > 0 && l.lap === s.lapStart);
    if (outLap || inLap || l.deleted || l.duration == null || !(l.duration > 0)) continue;
    const end = l.end ?? l.start + l.duration * 1000;
    if (neutral.some((p) => p.start < end && l.start < (p.end ?? Infinity))) continue;
    valid.push({ lap: l.lap, start: l.start, end, time: l.duration, stint: i });
  }
  if (valid.length === 0) return [];
  const overall = Math.min(...valid.map((l) => l.time));

  const out: SetPushes[] = [];
  sorted.forEach((s, i) => {
    const own = valid.filter((l) => l.stint === i);
    if (own.length === 0) return;
    const setBest = Math.min(...own.map((l) => l.time));
    const pushed = setBest <= SET_PACE * overall;
    const pushes = own.filter((l) => l.time <= PUSH * overall || (pushed && l.time <= PUSH * setBest));
    if (pushes.length === 0) return;
    const times = pushes.map((l) => l.time);
    out.push({
      driver,
      stint: s.stint,
      compound: s.compound,
      age: s.ageAtStart + pushes[0].lap - s.lapStart,
      laps: pushes.map((l) => l.lap),
      times,
      first: times[0],
      best: Math.min(...times),
      drop: times.length > 1 ? times[1] - times[0] : null,
      start: pushes[0].start,
      end: pushes.at(-1)!.end,
    });
  });
  return out;
}

/** Compounds in the order the widget shows them. */
export const COMPOUND_ORDER = ["SOFT", "MEDIUM", "HARD", "INTERMEDIATE", "WET", "UNKNOWN"];

/** Sets by compound (in COMPOUND_ORDER), each quickest best push first. */
export function byCompound(sets: readonly SetPushes[]): { compound: string; sets: SetPushes[] }[] {
  const groups = new Map<string, SetPushes[]>();
  for (const s of sets) {
    if (!groups.has(s.compound)) groups.set(s.compound, []);
    groups.get(s.compound)!.push(s);
  }
  const rank = (c: string) => (COMPOUND_ORDER.includes(c) ? COMPOUND_ORDER.indexOf(c) : COMPOUND_ORDER.length);
  return [...groups]
    .sort(([a], [b]) => rank(a) - rank(b))
    .map(([compound, ss]) => ({ compound, sets: ss.sort((a, b) => a.best - b.best || a.start - b.start) }));
}

// ---------------------------------------------------------------- the set being watched
//
// Clicking a row seeks to its first push lap, and the list only has push laps done by then: the row would vanish from
// under the pointer. So the clicked row is pinned: it stays as it was when clicked (that was on screen: no spoiler)
// while the replay is on its pushes, and goes once the replay is past them (the list has them again by then) or
// clearly before them.

export interface PinnedSet {
  set: SetPushes;
  sessionKey: number;
}

/** Seeking up to this far before a pinned set's first push still watches it (its out-lap's end, a few seconds back). */
export const PIN_LEAD_MS = 30_000;

/** Whether a pinned set is still being watched at t. */
export const pinHolds = (pin: PinnedSet, t: number, sessionKey: number) => sessionKey === pin.sessionKey && t >= pin.set.start - PIN_LEAD_MS && t < pin.set.end;

/** The sets so far, with the pinned one (while watched) in place of that set's pushes so far. */
export const withPin = (sets: readonly SetPushes[], pin: PinnedSet | null): SetPushes[] =>
  pin ? [...sets.filter((s) => s.driver !== pin.set.driver || s.stint !== pin.set.stint), pin.set] : [...sets];

/** Seconds of a drop at or under this: the set held up (as in "kept within 0.3 s"). */
export const SMALL_DROP = 0.3;
/** Over this: the set lost a lot of its grip after one lap. */
export const BIG_DROP = 0.6;

/** 0.312 -> "+0.31", -0.15 -> "−0.15". */
export const dropText = (s: number) => `${s >= 0 ? "+" : "−"}${Math.abs(s).toFixed(2)}`;
