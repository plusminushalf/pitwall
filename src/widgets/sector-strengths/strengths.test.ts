// describe/test/expect are bun test's globals: a widget folder may only import react, widget-kit and its own
// files (bun run lint), so not "bun:test".

import type { NeutralPeriod } from "widget-kit";
import { deletionsUpTo, driverBests, gapText, groupBests, IDEAL, SPEED, strength, strengthTable, validLaps, type StrengthLap, type StrengthStint } from "./strengths";

/** A lap from t = start (s), its sectors adding up to its time (null: untimed), st the speed trap. */
function lap(n: number, start: number, sectors: [number, number, number] | null, extra: Partial<StrengthLap> & { st?: number | null; i2?: number | null } = {}): StrengthLap {
  const { st = null, i2 = null, ...rest } = extra;
  const duration = sectors ? sectors[0] + sectors[1] + sectors[2] : null;
  return {
    lap: n,
    start: start * 1000,
    end: (start + (duration ?? 100)) * 1000,
    duration,
    sectors: sectors ?? [null, null, null],
    speedTrap: { i1: null, i2, st },
    pitOut: false,
    ...rest,
  };
}

// A run from the garage on softs (2 laps old), then one on mediums: out-lap, laps, in-lap.
const LAPS: StrengthLap[] = [
  lap(1, 0, null, { pitOut: true }),
  lap(2, 100, [28.5, 35.2, 26.4], { st: 318 }),
  lap(3, 190, [28.1, 35.6, 26.3], { st: 322 }),
  lap(4, 280, [30.0, 34.0, 27.0], { st: 340 }), // the in-lap: quick in S2, but it doesn't count
  lap(5, 400, null, { pitOut: true }),
  lap(6, 500, [28.9, 35.0, 26.6], { st: null, i2: 305 }),
  lap(7, 590, [29.0, 35.1, 26.5], { st: 319 }),
];
const STINTS: StrengthStint[] = [
  { lapStart: 1, compound: "SOFT", ageAtStart: 2 },
  { lapStart: 5, compound: "MEDIUM", ageAtStart: null },
];

describe("laps that count", () => {
  test("timed, not out- or in-laps, with the tyre from their stint", () => {
    const v = validLaps(LAPS, STINTS, [], 0);
    expect(v.map((l) => [l.lap.lap, l.compound, l.age])).toEqual([
      [2, "SOFT", 3],
      [3, "SOFT", 4],
      [6, "MEDIUM", 1],
      [7, "MEDIUM", 2],
    ]);
  });

  test("a later stint's first lap is an out-lap even without the flag; the lap before it is an in-lap", () => {
    const laps = LAPS.map((l) => (l.lap === 5 ? { ...l, pitOut: false, duration: 95, sectors: [30, 35, 30] as [number, number, number] } : l));
    expect(validLaps(laps, STINTS, [], 0).map((l) => l.lap.lap)).toEqual([2, 3, 6, 7]);
  });

  test("a deleted lap counts until it's deleted", () => {
    const laps = LAPS.map((l) => (l.lap === 3 ? { ...l, deleted: { t: 500_000, reason: "TRACK LIMITS AT TURN 7" } } : l));
    expect(validLaps(laps, STINTS, [], 499_999).map((l) => l.lap.lap)).toContain(3);
    expect(validLaps(laps, STINTS, [], 500_000).map((l) => l.lap.lap)).not.toContain(3);
    expect(deletionsUpTo([laps], 499_999)).toBe(-Infinity);
    expect(deletionsUpTo([laps], 600_000)).toBe(500_000);
  });

  test("laps touched by a neutral period don't count", () => {
    const red: NeutralPeriod = { status: "RED", start: 250_000, end: 560_000 };
    expect(validLaps(LAPS, STINTS, [red], 0).map((l) => l.lap.lap)).toEqual([2, 7]);
    expect(validLaps(LAPS, STINTS, [{ ...red, end: null }], 0).map((l) => l.lap.lap)).toEqual([2]);
  });
});

describe("a driver's bests", () => {
  const bests = driverBests(16, validLaps(LAPS, STINTS, [], 0));

  test("each sector from whichever lap set it; the in-lap's quick S2 doesn't count", () => {
    expect(bests.slice(0, 3).map((m) => [m!.value, m!.lap])).toEqual([
      [28.1, 3],
      [35.0, 6],
      [26.3, 3],
    ]);
    expect(bests[0]).toMatchObject({ driver: 16, start: 190_000, compound: "SOFT", age: 4 });
  });

  test("ideal: the best sectors added up, watched on the fastest lap", () => {
    expect(bests[IDEAL]!.value).toBeCloseTo(28.1 + 35.0 + 26.3, 9);
    expect(bests[IDEAL]!.lap).toBe(3);
  });

  test("top speed: the speed trap, or the second intermediate when the trap has nothing", () => {
    expect(bests[SPEED]).toMatchObject({ value: 322, lap: 3 });
    const noTrap = LAPS.map((l) => ({ ...l, speedTrap: { ...l.speedTrap, st: null, i2: l.lap === 6 ? 305 : null } }));
    expect(driverBests(16, validLaps(noTrap, STINTS, [], 0))[SPEED]).toMatchObject({ value: 305, lap: 6 });
  });

  test("nothing yet: no bests", () => {
    expect(driverBests(16, [])).toEqual([null, null, null, null, null]);
  });
});

describe("the table", () => {
  const m = (driver: number, value: number) => ({ value, driver, lap: 1, start: 0, compound: "SOFT", age: 0 });
  const bests = (driver: number, s: [number, number, number], speed: number) => [m(driver, s[0]), m(driver, s[1]), m(driver, s[2]), m(driver, s[0] + s[1] + s[2]), m(driver, speed)];

  test("a team takes the better of its cars in each column", () => {
    const team = groupBests([bests(16, [28.1, 35.4, 26.2], 320), bests(44, [28.3, 35.1, 26.5], 324), []]);
    expect(team.map((x) => x!.driver)).toEqual([16, 44, 16, 16, 44]);
  });

  test("gaps and ranks per column, rows by ideal lap, the slower speed as a gap in km/h", () => {
    const rows = strengthTable([
      { key: "MCL", bests: bests(4, [28.0, 35.5, 26.4], 318) },
      { key: "FER", bests: bests(16, [28.4, 35.2, 26.1], 325) },
      { key: "WIL", bests: bests(23, [28.6, 35.9, 26.9], 330) },
    ]);
    expect(rows.map((r) => r.key)).toEqual(["FER", "MCL", "WIL"]);
    const fer = rows[0].cells;
    expect(fer.map((c) => c!.rank)).toEqual([2, 1, 1, 1, 2]);
    expect(fer[0]!.gap).toBeCloseTo(0.4, 9);
    expect(fer[SPEED]!.gap).toBe(5);
    expect(gapText(SPEED, fer[SPEED]!.gap)).toBe("−5");
    expect(gapText(0, fer[0]!.gap)).toBe("+0.400");
    expect(strength(fer[1]!)).toBe(1);
    expect(strength(rows[2].cells[0]!)).toBe(0);
  });

  test("ties share a rank; rows with no ideal lap go last, rows with nothing go", () => {
    const partial = [m(1, 28.0), null, null, null, m(1, 330)];
    const rows = strengthTable([
      { key: "A", bests: partial },
      { key: "B", bests: bests(2, [28.0, 35.0, 26.0], 320) },
      { key: "C", bests: [null, null, null, null, null] },
    ]);
    expect(rows.map((r) => r.key)).toEqual(["B", "A"]);
    expect(rows.map((r) => r.cells[0]!.rank)).toEqual([1, 1]);
    expect(rows[1].cells[IDEAL]).toBeNull();
    expect(rows[0].cells[IDEAL]).toMatchObject({ rank: 1, of: 1 });
  });
});
