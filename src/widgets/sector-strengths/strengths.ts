// Sector strengths in free practice: where each car is quick. Every driver's best S1, S2 and S3, their sum (the
// ideal lap) and top speed over the laps that count, then a team's best of its two drivers in each column, ranked
// column by column. Pure: the widget feeds it the laps, stints and safety car, VSC and red flag periods it has so
// far (nothing past t).
//
// A lap counts when it's timed, isn't an out-lap or an in-lap, wasn't touched by a neutral period and race control
// hasn't deleted it by t (a deleted lap counts until then, as in the timing tower). A sector or a speed-trap reading
// counts when its lap does. Sector bests may come from different laps, and different tyres.

import type { Lap, NeutralPeriod, Stint } from "widget-kit";

/** The part of a completed lap this needs. */
export type StrengthLap = Pick<Lap, "lap" | "start" | "end" | "duration" | "sectors" | "speedTrap" | "pitOut" | "deleted">;
/** The part of a stint this needs. */
export type StrengthStint = Pick<Stint, "lapStart" | "compound" | "ageAtStart">;

/** A lap that counts, on the tyre it was set on. */
export interface ValidLap {
  lap: StrengthLap;
  compound: string;
  /** Laps on the set before this one. */
  age: number;
}

/** The columns, in order: three sectors, the ideal lap (their sum) and top speed. */
export const COLUMNS = ["S1", "S2", "S3", "Ideal", "Top speed"] as const;
export const IDEAL = 3;
export const SPEED = 4;

/** Where a best was set: the value (seconds, or km/h for top speed), and the lap to watch for it. */
export interface Mark {
  value: number;
  driver: number;
  lap: number;
  /** When the lap started (ms), to seek to. */
  start: number;
  compound: string;
  age: number;
}

/**
 * One driver's bests, by column (null: none yet). The ideal lap's mark is the driver's fastest lap that counts
 * (the lap to watch), with the sum of the best sectors as its value.
 */
export type Bests = (Mark | null)[];

/** The latest deletion in effect at t (or -Infinity): it only changes when one takes effect, so the widget re-renders then. */
export function deletionsUpTo(laps: Iterable<readonly StrengthLap[]>, t: number): number {
  let latest = -Infinity;
  for (const own of laps) for (const l of own) if (l.deleted && l.deleted.t <= t && l.deleted.t > latest) latest = l.deleted.t;
  return latest;
}

/** One driver's laps that count by t, with their tyre. */
export function validLaps(laps: readonly StrengthLap[], stints: readonly StrengthStint[], neutral: readonly NeutralPeriod[], t: number): ValidLap[] {
  const sorted = [...laps].sort((a, b) => a.lap - b.lap);
  const byLap = new Map(sorted.map((l) => [l.lap, l]));
  const starts = [...stints].sort((a, b) => a.lapStart - b.lapStart);
  const out: ValidLap[] = [];
  for (const l of sorted) {
    if (l.duration == null || !(l.duration > 0) || l.pitOut) continue;
    // Its stint: the last to start by it. A later stint's first lap is an out-lap, whatever the flag says.
    let i = starts.length - 1;
    while (i >= 0 && starts[i].lapStart > l.lap) i--;
    if (i < 0 || (i > 0 && starts[i].lapStart === l.lap)) continue;
    // An in-lap: the next lap leaves the pits, or the next stint starts with it.
    if (byLap.get(l.lap + 1)?.pitOut || starts[i + 1]?.lapStart === l.lap + 1) continue;
    if (l.deleted && l.deleted.t <= t) continue;
    const end = l.end ?? l.start + l.duration * 1000;
    if (neutral.some((p) => p.start < end && l.start < (p.end ?? Infinity))) continue;
    const s = starts[i];
    out.push({ lap: l, compound: s.compound, age: (s.ageAtStart ?? 0) + l.lap - s.lapStart });
  }
  return out;
}

const speedOf = (l: StrengthLap) => l.speedTrap.st ?? l.speedTrap.i2;

/** A driver's bests in each column over their laps that count. */
export function driverBests(driver: number, laps: readonly ValidLap[]): Bests {
  const mark = (v: ValidLap, value: number): Mark => ({ value, driver, lap: v.lap.lap, start: v.lap.start, compound: v.compound, age: v.age });
  const out: Bests = [null, null, null, null, null];
  let fastest: ValidLap | null = null;
  for (const v of laps) {
    for (let k = 0; k < 3; k++) {
      const s = v.lap.sectors[k];
      if (s != null && s > 0 && (out[k] == null || s < out[k]!.value)) out[k] = mark(v, s);
    }
    const speed = speedOf(v.lap);
    if (speed != null && speed > 0 && (out[SPEED] == null || speed > out[SPEED]!.value)) out[SPEED] = mark(v, speed);
    if (!fastest || v.lap.duration! < fastest.lap.duration!) fastest = v;
  }
  if (fastest && out[0] && out[1] && out[2]) out[IDEAL] = mark(fastest, out[0].value + out[1].value + out[2].value);
  return out;
}

/** Quicker in the column: less time, or more speed. */
const better = (k: number, a: number, b: number) => (k === SPEED ? a > b : a < b);

/** A group's best in each column: the best of its drivers' (a team: its two cars). */
export function groupBests(bests: readonly Bests[]): Bests {
  return COLUMNS.map((_, k) => {
    let best: Mark | null = null;
    for (const b of bests) {
      const m = b[k];
      if (m && (!best || better(k, m.value, best.value))) best = m;
    }
    return best;
  });
}

export interface Cell {
  mark: Mark;
  /** Behind the column's best: seconds, or km/h slower for top speed (0: the best). */
  gap: number;
  /** In the column, among the rows with a value (ties share a rank). */
  rank: number;
  /** Rows with a value in the column. */
  of: number;
}

export interface Row<K> {
  key: K;
  cells: (Cell | null)[];
}

/**
 * The table: each row's cells with its gap and rank in the column, rows sorted by the ideal lap (rows without one
 * after, by S1 to S3; rows with nothing at all left out).
 */
export function strengthTable<K>(rows: readonly { key: K; bests: Bests }[]): Row<K>[] {
  const withAny = rows.filter((r) => r.bests.some((m) => m != null));
  const columns = COLUMNS.map((_, k) => withAny.map((r) => r.bests[k]?.value).filter((v): v is number => v != null));
  const table = withAny.map(
    (r): Row<K> => ({
      key: r.key,
      cells: r.bests.map((m, k) => {
        if (!m) return null;
        const values = columns[k];
        const best = k === SPEED ? Math.max(...values) : Math.min(...values);
        return { mark: m, gap: Math.abs(m.value - best), rank: 1 + values.filter((v) => better(k, v, m.value)).length, of: values.length };
      }),
    }),
  );
  const rankIn = (r: Row<K>, k: number) => r.cells[k]?.rank ?? Infinity;
  return table.sort((a, b) => {
    const k = [IDEAL, 0, 1, 2].find((k) => rankIn(a, k) !== rankIn(b, k));
    return k == null ? 0 : rankIn(a, k) - rankIn(b, k);
  });
}

/** How bright a cell is, 1 for the column's best down to 0 for its slowest. */
export const strength = (cell: Cell) => (cell.of <= 1 ? 1 : 1 - (cell.rank - 1) / (cell.of - 1));

/** A gap as the cell shows it: "+0.123" seconds, or "−4" km/h. */
export const gapText = (k: number, gap: number) => (k === SPEED ? `−${Math.round(gap)}` : `+${gap.toFixed(3)}`);
