// Long runs in free practice: a driver's laps at a steady pace on one tyre set (race simulations), with their
// average and how much slower they get per lap, ranked within each compound. Pure: the widget feeds it the laps,
// stints and safety car, VSC and red flag periods it has so far (nothing past t).
//
// A run is found in each stint (a run from the garage on one set): its out-lap and in-lap don't count, laps touched
// by a neutral period are left out (they don't end the run), and so are slow laps (over 107% of the stint's
// typical lap: cool-down laps, traffic). One or two slow laps in a row don't end a run if there are laps at pace on
// both sides of them (a lap stuck in traffic), so a quali simulation's push / cool-down / push laps never make one.

import type { NeutralPeriod } from "widget-kit";

/** The part of a completed lap this needs. */
export interface RunLap {
  lap: number;
  start: number;
  end: number | null;
  duration: number | null;
  pitOut: boolean;
}

/** The part of a stint this needs; `open` is the one the car is on. */
export interface RunStint {
  stint: number;
  lapStart: number;
  compound: string;
  ageAtStart: number;
  open: boolean;
}

export interface LongRun {
  driver: number;
  stint: number;
  compound: string;
  /** Laps on the set before the run's first counted lap (a new set's first lap is 0). */
  age: number;
  /** The laps counted, in order. */
  laps: number[];
  /** Laps in between that weren't counted: slow, or under a safety car, VSC or red flag. */
  skipped: number;
  /** When the first counted lap started (ms), to seek to. */
  start: number;
  /** When each counted lap ended (ms); the last is the run's end. */
  ends: number[];
  /** Seconds: the mean of the counted laps. */
  average: number;
  /** Seconds per lap of tyre age (least squares): positive is getting slower. Fuel burning off is in it too. */
  deg: number;
  /** The car is still on this run (its last lap so far is one of it, on the set it's on). */
  ongoing: boolean;
}

/** Fewer counted laps than this aren't a long run. */
export const MIN_RUN_LAPS = 5;
/** Slower than this share of the typical lap: a cool-down lap or traffic. */
export const SLOW = 1.07;
/** Faster than this share of a run's median: a push lap tacked onto it, not race pace. */
const FAST = 0.975;
/** The stint's typical lap is the median of its laps within this share of its fastest (cool-down laps would skew it). */
const TYPICAL_WITHIN = 1.1;
/** Slow laps in a row a run carries on through, with at least MIN_SIDE laps at pace either side. */
const MAX_SLOW = 2;
const MIN_SIDE = 2;

const median = (xs: readonly number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Least-squares slope of y against x (as stint pace fits its stints; widgets don't share code). */
function slope(points: readonly { x: number; y: number }[]): number {
  const n = points.length;
  const mx = points.reduce((a, p) => a + p.x, 0) / n;
  const my = points.reduce((a, p) => a + p.y, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (const p of points) {
    sxy += (p.x - mx) * (p.y - my);
    sxx += (p.x - mx) ** 2;
  }
  return sxx === 0 ? 0 : sxy / sxx;
}

interface AtPace {
  lap: number;
  start: number;
  end: number;
  time: number;
}

/** One driver's long runs, in the order driven. */
export function longRuns(driver: number, laps: readonly RunLap[], stints: readonly RunStint[], neutral: readonly NeutralPeriod[], minLaps = MIN_RUN_LAPS): LongRun[] {
  const out: LongRun[] = [];
  const sorted = [...laps].sort((a, b) => a.lap - b.lap);
  const lastLap = sorted.at(-1) ?? null;
  stints.forEach((s, i) => {
    const next = stints[i + 1];
    const own = sorted.filter((l) => l.lap >= s.lapStart && (!next || l.lap < next.lapStart));
    // The timed laps between the out-lap and the in-lap (an untimed lap ends a run too), but those touched by a
    // neutral period.
    const segments: AtPace[][] = [[]];
    own.forEach((l, k) => {
      const inLap = own[k + 1]?.pitOut === true || (next != null && l.lap === next.lapStart - 1);
      if (l.pitOut || (i > 0 && l.lap === s.lapStart) || inLap || l.duration == null || !(l.duration > 0)) {
        if (segments.at(-1)!.length) segments.push([]);
        return;
      }
      const end = l.end ?? l.start + l.duration * 1000;
      if (!neutral.some((p) => p.start < end && l.start < (p.end ?? Infinity))) segments.at(-1)!.push({ lap: l.lap, start: l.start, end, time: l.duration });
    });
    const times = segments.flat().map((l) => l.time);
    if (times.length < minLaps) return;
    const fastest = Math.min(...times);
    const limit = SLOW * median(times.filter((t) => t <= TYPICAL_WITHIN * fastest));

    const runs: AtPace[][] = [];
    for (const segment of segments) {
      // Laps at pace in a row, and the slow laps after each piece (Infinity: the segment ends).
      const pieces: { laps: AtPace[]; slowAfter: number }[] = [];
      let slow = 0;
      for (const l of segment) {
        if (l.time > limit) {
          slow++;
          continue;
        }
        const piece = pieces.at(-1);
        if (piece && slow === 0) piece.laps.push(l);
        else {
          if (piece) piece.slowAfter = slow;
          pieces.push({ laps: [l], slowAfter: Infinity });
        }
        slow = 0;
      }
      // Join pieces across one or two slow laps when there are laps at pace on both sides.
      let run: AtPace[] | null = null;
      pieces.forEach((p, k) => {
        const prev = pieces[k - 1];
        if (run && prev.slowAfter <= MAX_SLOW && prev.laps.length >= MIN_SIDE && p.laps.length >= MIN_SIDE) run.push(...p.laps);
        else runs.push((run = [...p.laps]));
      });
    }

    for (const run of runs) {
      if (run.length < minLaps) continue;
      // Measured against the run itself: what's left of slow laps, and push laps tacked on.
      const typical = median(run.map((l) => l.time));
      const counted = run.filter((l) => l.time <= SLOW * typical && l.time >= FAST * typical);
      if (counted.length < minLaps) continue;
      const age = (lap: number) => s.ageAtStart + lap - s.lapStart;
      const first = counted[0];
      const last = counted.at(-1)!;
      out.push({
        driver,
        stint: s.stint,
        compound: s.compound,
        age: age(first.lap),
        laps: counted.map((l) => l.lap),
        skipped: last.lap - first.lap + 1 - counted.length,
        start: first.start,
        ends: counted.map((l) => l.end),
        average: counted.reduce((a, l) => a + l.time, 0) / counted.length,
        deg: slope(counted.map((l) => ({ x: age(l.lap), y: l.time }))),
        // (Its last lap so far is timed, at most a slow lap or two past the run's: the car hasn't come in.)
        ongoing: s.open && lastLap != null && lastLap.duration != null && lastLap.lap >= last.lap && lastLap.lap - last.lap <= MAX_SLOW,
      });
    }
  });
  return out;
}

/** Compounds in the order the widget shows them. */
export const COMPOUND_ORDER = ["SOFT", "MEDIUM", "HARD", "INTERMEDIATE", "WET", "UNKNOWN"];

/** Runs by compound (in COMPOUND_ORDER), each fastest average first. */
export function byCompound(runs: readonly LongRun[]): { compound: string; runs: LongRun[] }[] {
  const groups = new Map<string, LongRun[]>();
  for (const r of runs) {
    if (!groups.has(r.compound)) groups.set(r.compound, []);
    groups.get(r.compound)!.push(r);
  }
  const rank = (c: string) => (COMPOUND_ORDER.includes(c) ? COMPOUND_ORDER.indexOf(c) : COMPOUND_ORDER.length);
  return [...groups]
    .sort(([a], [b]) => rank(a) - rank(b))
    .map(([compound, rs]) => ({ compound, runs: rs.sort((a, b) => a.average - b.average || a.start - b.start) }));
}

// ---------------------------------------------------------------- the run being watched
//
// Clicking a run seeks to its first lap, and the list only has runs with their laps done by then: the run would vanish
// from under the pointer. So the clicked run is pinned: it stays in the list as it was when clicked (that was on
// screen: no spoiler) while it's being watched, with how far into it the replay is. The rest of the list stays
// spoiler-free: runs that end after the new t go, as in every widget after a seek back.

/** The run the user clicked, as the list showed it then. */
export interface PinnedRun {
  run: LongRun;
  /** Its rank within its compound, and seconds behind the quickest run on it (null: the quickest), when clicked. */
  rank: number;
  gap: number | null;
  sessionKey: number;
}

/** Seeking up to this far before a pinned run still watches it (its out-lap, a few seconds back). */
export const PIN_LEAD_MS = 30_000;

/** How far the replay is into a pinned run: on its `lap`th counted lap of `of`, `fraction` of the way through. */
export interface PinProgress {
  lap: number;
  of: number;
  fraction: number;
}

/**
 * A pinned run's progress at t, or null when it isn't being watched any more and the pin goes: another session, a
 * seek clearly before it (over PIN_LEAD_MS), or past its end (the list has it by then).
 */
export function pinAt(pin: PinnedRun, t: number, sessionKey: number): PinProgress | null {
  const { start, ends } = pin.run;
  const end = ends.at(-1)!;
  if (sessionKey !== pin.sessionKey || t < start - PIN_LEAD_MS || t >= end) return null;
  const done = ends.filter((e) => e <= t).length;
  return { lap: Math.min(done + 1, ends.length), of: ends.length, fraction: Math.min(1, Math.max(0, (t - start) / (end - start))) };
}

export interface ListRow {
  run: LongRun;
  rank: number;
  /** Seconds behind the first row (null: the first). */
  gap: number | null;
  /** The pinned run being watched (its rank and gap are the ones it had when clicked). */
  pinned: PinProgress | null;
}

/** The pin after a click on a row: that run as the list shows it (the pinned run itself: the same pin, started over). */
export const pinFor = (row: ListRow, current: PinnedRun | null, sessionKey: number): PinnedRun =>
  row.pinned && current ? current : { run: row.run, rank: row.rank, gap: row.gap, sessionKey };

/** The same run: driver and set, laps overlapping (a run still under way has fewer of them). */
const sameRun = (a: LongRun, b: LongRun) => a.driver === b.driver && a.stint === b.stint && a.laps[0] <= b.laps.at(-1)! && b.laps[0] <= a.laps.at(-1)!;

/**
 * The list at t: the runs so far by compound, ranked (byCompound), and the pinned run while it's watched (`progress`
 * from pinAt) in its compound by its average, instead of its own run so far. Its rank and gap are the ones it had
 * when clicked; the other rows are ranked among themselves.
 */
export function listRows(runs: readonly LongRun[], pin: PinnedRun | null, progress: PinProgress | null): { compound: string; rows: ListRow[] }[] {
  const watched = pin && progress ? pin : null;
  const rest = watched ? runs.filter((r) => !sameRun(r, watched.run)) : runs;
  const groups = byCompound(rest).map((g) => ({
    compound: g.compound,
    rows: g.runs.map((run, i): ListRow => ({ run, rank: i + 1, gap: i > 0 ? run.average - g.runs[0].average : null, pinned: null })),
  }));
  if (!watched) return groups;
  let group = groups.find((g) => g.compound === watched.run.compound);
  if (!group) {
    group = { compound: watched.run.compound, rows: [] };
    groups.push(group);
    const rank = (c: string) => (COMPOUND_ORDER.includes(c) ? COMPOUND_ORDER.indexOf(c) : COMPOUND_ORDER.length);
    groups.sort((a, b) => rank(a.compound) - rank(b.compound));
  }
  const at = group.rows.findIndex((r) => r.run.average > watched.run.average);
  group.rows.splice(at < 0 ? group.rows.length : at, 0, { run: watched.run, rank: watched.rank, gap: watched.gap, pinned: progress });
  return groups;
}

/** 0.0834 -> "+0.08". */
export const degText = (s: number) => `${s >= 0 ? "+" : "−"}${Math.abs(s).toFixed(2)}`;
