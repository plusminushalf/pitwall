// describe/test/expect are bun test's globals: a widget folder may only import react, widget-kit and its own
// files (bun run lint), so not "bun:test".

import type { NeutralPeriod } from "widget-kit";
import { axisOf, byTeam, deletedBy, planRow, type PlanLapInput, type PlanStint } from "./plan";

/** A run from the garage: its compound, the set's age, and its laps ("o" the out-lap, null untimed: the in-lap). */
type Spec = { compound: string; age?: number; laps: (number | "o" | null)[]; garage?: number };

/** Laps and stints for runs from t = 0 (an untimed lap takes 100 s, an out-lap 120 s), `garage` s between runs. */
function session(specs: Spec[]): { laps: PlanLapInput[]; stints: PlanStint[] } {
  const laps: PlanLapInput[] = [];
  const stints: PlanStint[] = [];
  let start = 0;
  let lap = 1;
  for (const s of specs) {
    start += (s.garage ?? 0) * 1000;
    stints.push({ lapStart: lap, compound: s.compound, ageAtStart: s.age ?? 0 });
    for (const t of s.laps) {
      const duration = typeof t === "number" ? t : null;
      const ms = (duration ?? (t === "o" ? 120 : 100)) * 1000;
      laps.push({ lap, start, end: start + ms, duration, pitOut: t === "o", deleted: false });
      start += ms;
      lap++;
    }
  }
  return { laps, stints };
}

const kinds = (row: ReturnType<typeof planRow>) => row.laps.map((l) => l.kind);
const whys = (row: ReturnType<typeof planRow>) => row.laps.map((l) => l.why);

describe("run plans", () => {
  test("a quali sim and a long run: push laps, laps at pace, and out-, in- and cool-down laps", () => {
    const { laps, stints } = session([
      { compound: "SOFT", laps: ["o", 90.0, 120.0, 90.9, null] },
      { compound: "HARD", age: 3, garage: 600, laps: ["o", 94.0, 94.5, 95.0, null] },
    ]);
    const row = planRow(4, laps, stints, []);
    expect(row.best).toBe(90.0);
    expect(kinds(row)).toEqual(["slow", "push", "slow", "push", "slow", "slow", "pace", "pace", "pace", "slow"]);
    expect(whys(row)).toEqual(["out-lap", null, "slow", null, "in-lap", "out-lap", null, null, null, "untimed"]);
    // Compound and age from the stint holding the lap.
    expect(row.laps.map((l) => `${l.compound[0]}${l.age}`)).toEqual(["S0", "S1", "S2", "S3", "S4", "H3", "H4", "H5", "H6", "H7"]);
    // The garage is a gap: the hard run's out-lap starts 600 s after the in-lap ends.
    expect(row.laps[5].start - row.laps[4].end).toBe(600_000);
  });

  test("an in-lap is the lap before a pit-out lap or a new set, even when timed", () => {
    const { laps, stints } = session([{ compound: "MEDIUM", laps: ["o", 90.0, 91.0] }, { compound: "MEDIUM", laps: ["o", 90.5] }]);
    expect(whys(planRow(1, laps, stints, []))).toEqual(["out-lap", null, "in-lap", "out-lap", null]);
    // The first lap on a later set is its out-lap even unflagged.
    const unflagged = laps.map((l) => (l.lap === 4 ? { ...l, pitOut: false } : l));
    const row = planRow(1, unflagged, stints, []);
    expect(whys(row)).toEqual(["out-lap", null, "in-lap", "out-lap", null]);
  });

  test("laps touched by a red flag or deleted by now aren't valid, and don't set the best", () => {
    const { laps, stints } = session([{ compound: "SOFT", laps: ["o", 93.0, 89.0, 92.5, 91.0, null] }]);
    // Lap 3 (89.0) is deleted; lap 4 runs into a red flag.
    const marked = laps.map((l) => (l.lap === 3 ? { ...l, deleted: true } : l));
    const red: NeutralPeriod[] = [{ status: "RED", start: laps[3].start + 50_000, end: laps[3].end! - 5_000 }];
    const row = planRow(1, marked, stints, red);
    expect(row.best).toBe(91.0);
    expect(whys(row)).toEqual(["out-lap", null, "deleted", "red flag", null, "untimed"]);
    // A red flag still out covers every lap after it.
    expect(whys(planRow(1, marked, stints, [{ ...red[0], end: null }])).slice(3)).toEqual(["red flag", "red flag", "untimed"]);
    expect(kinds(row)).toEqual(["slow", "pace", "slow", "slow", "push", "slow"]);
  });

  test("a lap is deleted only once race control has deleted it", () => {
    expect(deletedBy({ deleted: { t: 1000 } }, 999)).toBe(false);
    expect(deletedBy({ deleted: { t: 1000 } }, 1000)).toBe(true);
    expect(deletedBy({}, 5000)).toBe(false);
  });

  test("no valid lap yet: everything is faint and there's no best", () => {
    const { laps, stints } = session([{ compound: "HARD", laps: ["o", null] }]);
    const row = planRow(1, laps, stints, []);
    expect(row.best).toBeNull();
    expect(kinds(row)).toEqual(["slow", "slow"]);
  });

  test("teams by their best lap, teammates together by theirs, no laps last", () => {
    const team: Record<number, string> = { 1: "A", 2: "A", 3: "B", 4: "B", 5: "C", 6: "C" };
    const rows = [
      { driver: 1, best: 91.0 },
      { driver: 2, best: 90.5 },
      { driver: 3, best: 90.2 },
      { driver: 4, best: null },
      { driver: 5, best: null },
      { driver: 6, best: null },
    ];
    expect(byTeam(rows, (n) => team[n]).map((g) => g.map((r) => r.driver))).toEqual([[3, 4], [2, 1], [5, 6]]);
  });

  test("the axis runs to the scheduled end, or the flag lap's end past it, in 15-minute ticks", () => {
    expect(axisOf(0, 3_600_000, [])).toEqual({ from: 0, to: 3_600_000, ticks: [0, 15, 30, 45, 60] });
    const late = { driver: 1, best: null, laps: [{ lap: 1, start: 3_550_000, end: 3_640_000, duration: 90, compound: "SOFT", age: 0, kind: "push" as const, why: null }] };
    expect(axisOf(0, 3_600_000, [late]).to).toBe(3_640_000);
    // The cool-down lap after the flag doesn't stretch it.
    const coolDown = { ...late, laps: [{ ...late.laps[0], start: 3_640_000, end: 3_900_000, duration: null, kind: "slow" as const, why: "in-lap" }] };
    expect(axisOf(0, 3_600_000, [coolDown]).to).toBe(3_600_000);
  });
});
