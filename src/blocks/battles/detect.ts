// Battles from lap-line crossings: two cars next to each other on the road, within `gap` seconds at the
// line for `minLaps` laps in a row. Pure, over what the block hooks return at t (no spoilers).
//
// A lap counts for a pair only when it's clean for both: completed, not an in-lap or out-lap, and not
// run under a safety car, VSC or red flag. Cars are compared on the same lap number, so a lapped car is
// never in a battle with the car lapping it. "Next to each other" is among the cars on clean laps, so a
// car crossing the line in the pit lane between two others doesn't split their battle, but a third car
// running between them does.

import type { NeutralPeriod } from "block-kit";

/** A completed lap's crossings (Lap from block-kit has these and more). */
export interface LapLine {
  lap: number;
  start: number;
  end: number | null;
  pitOut: boolean;
}

/** One car as the detector reads it. */
export interface CarLaps {
  driver: number;
  /** Completed laps, in lap order. */
  laps: readonly LapLine[];
  /** First lap of each stint so far (useAllStints): a stint after the first starts with an out-lap. */
  stintStarts: readonly number[];
  /** Retired, or took the chequered flag: its laps end here. */
  out: boolean;
  finished: boolean;
}

/** An overtake from the race feed (OpenF1's position changes, timed on track): `by` passed `on`. */
export interface FeedPass {
  t: number;
  by: number;
  on: number;
}

export interface Inputs {
  cars: readonly CarLaps[];
  /** Safety car, VSC and red flag periods so far (useNeutralPeriods). */
  neutral: readonly NeutralPeriod[];
  /** Pit-lane entries so far (race feed: known as the car goes in, useAllPitStops only once it's out). */
  pitEntries: readonly { driver: number; t: number }[];
  passes: readonly FeedPass[];
}

export interface Options {
  /** Seconds between the two at the line. */
  gap: number;
  minLaps: number;
}

export interface Pass {
  /** The lap at whose end the order had flipped. */
  lap: number;
  by: number;
  on: number;
  /** When it happened: the feed's overtake if there is one (`exact`), else the line crossing that showed it. */
  t: number;
  exact: boolean;
}

export type EndReason = "gap" | "pit" | "neutral" | "retired" | "flag";

export interface Battle {
  /** Stable while the battle grows: the pair and the first lap. */
  key: string;
  /** The car ahead and the car behind, at the battle's last lap (or after a pass that ended it). */
  ahead: number;
  behind: number;
  from: number;
  to: number;
  /** When the first of them crossed the line at the end of `from`. */
  t: number;
  /** Closest and latest gap at the line, in seconds. */
  closest: number;
  last: number;
  /** The position fought for: the car ahead's place at the line on lap `to`. */
  position: number;
  passes: Pass[];
  ongoing: boolean;
  /** Why it ended (null while ongoing); `driver` is who pitted or retired, `neutral` what neutralised the race. */
  end: { reason: EndReason; driver: number | null; neutral: NeutralPeriod["status"] | null } | null;
}

/**
 * In-laps and out-laps: the lap before a new stint and its first, a pit-out lap and the one before, and
 * the lap a pit-lane entry fell in (and the next). `laps` is the car's completed laps.
 */
export function pitLapsOf(car: CarLaps, pitEntries: readonly { driver: number; t: number }[]): Set<number> {
  const pit = new Set<number>();
  const mark = (outLap: number) => {
    if (outLap > 1) pit.add(outLap - 1);
    pit.add(outLap);
  };
  car.stintStarts.forEach((s, i) => i > 0 && mark(s));
  for (const l of car.laps) if (l.pitOut && l.lap > 1) mark(l.lap);
  for (const p of pitEntries) {
    if (p.driver !== car.driver) continue;
    const inLap = car.laps.find((l) => l.start <= p.t && l.end != null && p.t < l.end);
    if (inLap) mark(inLap.lap + 1);
  }
  return pit;
}

interface Car {
  driver: number;
  out: boolean;
  finished: boolean;
  end: Map<number, number>;
  clean: Map<number, boolean>;
  pit: Set<number>;
}

const pairKey = (a: number, b: number) => (a < b ? `${a}-${b}` : `${b}-${a}`);

export function detectBattles(input: Inputs, opts: Options): Battle[] {
  const gapMs = opts.gap * 1000;
  const minLaps = Math.max(1, opts.minLaps);
  const neutralAt = (start: number, end: number) => input.neutral.some((n) => start < (n.end ?? Infinity) && end > n.start);

  const cars = new Map<number, Car>();
  let maxLap = 0;
  for (const c of input.cars) {
    const pit = pitLapsOf(c, input.pitEntries);
    const end = new Map<number, number>();
    const clean = new Map<number, boolean>();
    for (const l of c.laps) {
      if (l.end == null) continue;
      end.set(l.lap, l.end);
      clean.set(l.lap, !pit.has(l.lap) && !neutralAt(l.start, l.end));
      maxLap = Math.max(maxLap, l.lap);
    }
    cars.set(c.driver, { driver: c.driver, out: c.out, finished: c.finished, end, clean, pit });
  }

  // Each lap: the cars on clean laps in crossing order, and every car's place at the line.
  const order: number[][] = [];
  const place: Map<number, number>[] = [];
  for (let k = 1; k <= maxLap; k++) {
    const crossed = [...cars.values()].filter((c) => c.end.has(k)).sort((a, b) => a.end.get(k)! - b.end.get(k)!);
    place[k] = new Map(crossed.map((c, i) => [c.driver, i + 1]));
    order[k] = crossed.filter((c) => c.clean.get(k)).map((c) => c.driver);
  }

  /** The pair at the end of lap k: who was ahead and by how much, if both ran it clean. */
  const at = (k: number, a: number, b: number): { ahead: number; behind: number; gap: number } | null => {
    const ca = cars.get(a)!;
    const cb = cars.get(b)!;
    if (!ca.clean.get(k) || !cb.clean.get(k)) return null;
    const ea = ca.end.get(k)!;
    const eb = cb.end.get(k)!;
    return ea <= eb ? { ahead: a, behind: b, gap: eb - ea } : { ahead: b, behind: a, gap: ea - eb };
  };

  // Laps each pair spent next to each other within the gap.
  const close = new Map<string, { a: number; b: number; laps: number[] }>();
  for (let k = 1; k <= maxLap; k++) {
    const o = order[k];
    for (let i = 0; i + 1 < o.length; i++) {
      const [a, b] = [o[i], o[i + 1]];
      if (cars.get(b)!.end.get(k)! - cars.get(a)!.end.get(k)! > gapMs) continue;
      const key = pairKey(a, b);
      let entry = close.get(key);
      if (!entry) close.set(key, (entry = { a: Math.min(a, b), b: Math.max(a, b), laps: [] }));
      entry.laps.push(k);
    }
  }

  /** The feed's overtake for a flip on lap k, else the line crossing that showed it. */
  const passOn = (k: number, by: number, on: number): Pass => {
    const cb = cars.get(by)!;
    const co = cars.get(on)!;
    const lo = Math.min(cb.end.get(k - 1)!, co.end.get(k - 1)!) - 1_000;
    const crossing = Math.min(cb.end.get(k)!, co.end.get(k)!);
    const hi = Math.max(cb.end.get(k)!, co.end.get(k)!) + 500;
    const hit = input.passes.filter((p) => p.by === by && p.on === on && p.t > lo && p.t <= hi).at(-1);
    return hit ? { lap: k, by, on, t: hit.t, exact: true } : { lap: k, by, on, t: crossing, exact: false };
  };

  /** The first neutral period still on after time t. */
  const spellAfter = (t: number) => input.neutral.find((n) => (n.end ?? Infinity) > t)?.status ?? null;
  const ended = (reason: EndReason, driver: number | null = null, neutral: NeutralPeriod["status"] | null = null) => ({ reason, driver, neutral });

  const battles: Battle[] = [];
  for (const { a, b, laps } of close.values()) {
    // Runs of consecutive laps.
    const runs: [number, number][] = [];
    for (const k of laps) {
      const last = runs.at(-1);
      if (last && last[1] === k - 1) last[1] = k;
      else runs.push([k, k]);
    }
    for (const [from, to] of runs) {
      if (to - from + 1 < minLaps) continue;
      const passes: Pass[] = [];
      let closest = Infinity;
      let prev = at(from - 1, a, b);
      for (let k = from; k <= to; k++) {
        const now = at(k, a, b)!;
        closest = Math.min(closest, now.gap);
        if (prev && prev.ahead !== now.ahead) passes.push(passOn(k, now.ahead, now.behind));
        prev = now;
      }
      const lastAt = at(to, a, b)!;
      let ahead = lastAt.ahead;
      let behind = lastAt.behind;

      // How it ended, or that it hasn't yet.
      const next = to + 1;
      const ca = cars.get(a)!;
      const cb = cars.get(b)!;
      let end: Battle["end"] = null;
      if (ca.end.has(next) && cb.end.has(next)) {
        const after = at(next, a, b);
        if (after) {
          // Clean but apart (or split by a third car); a pass that broke it still counts.
          if (after.ahead !== ahead) {
            passes.push(passOn(next, after.ahead, after.behind));
            [ahead, behind] = [after.ahead, after.behind];
          }
          end = ended("gap");
        } else {
          const pitted = [a, b].find((n) => cars.get(n)!.pit.has(next));
          end = pitted != null ? ended("pit", pitted) : ended("neutral", null, spellAfter(Math.min(ca.end.get(to)!, cb.end.get(to)!)));
        }
      } else if (ca.out || cb.out) {
        end = ended("retired", ca.out ? a : b);
      } else if (ca.finished || cb.finished) {
        end = ended("flag");
      } else {
        // Already known before the lap ends: one of them went into the pits, or the race was neutralised.
        const sinceLine = Math.max(ca.end.get(to)!, cb.end.get(to)!);
        const pitted = input.pitEntries.find((p) => (p.driver === a || p.driver === b) && p.t > cars.get(p.driver)!.end.get(to)!);
        const spell = spellAfter(sinceLine);
        if (pitted) end = ended("pit", pitted.driver);
        else if (spell) end = ended("neutral", null, spell);
      }

      battles.push({
        key: `${pairKey(a, b)}-${from}`,
        ahead,
        behind,
        from,
        to,
        t: Math.min(ca.end.get(from)!, cb.end.get(from)!),
        closest: closest / 1000,
        last: lastAt.gap / 1000,
        position: place[to].get(lastAt.ahead)!,
        passes,
        ongoing: end == null,
        end,
      });
    }
  }

  // Ongoing first, up the field; then the ones that ended, latest first.
  return battles.sort((x, y) => Number(y.ongoing) - Number(x.ongoing) || (x.ongoing ? x.position - y.position : y.to - x.to || x.position - y.position));
}
