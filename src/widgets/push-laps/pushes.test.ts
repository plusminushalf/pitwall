// describe/test/expect are bun test's globals: a widget folder may only import react, widget-kit and its own
// files (bun run lint), so not "bun:test".

import type { NeutralPeriod } from "widget-kit";
import { byCompound, dropText, pinHolds, pushSets, withPin, type PushLap, type PushStint } from "./pushes";

/** A run from the garage: its compound, the set's age, and its laps ("o" the out-lap, null untimed: the in-lap). */
type Spec = { compound: string; age?: number; laps: (number | "o" | null)[] };

/** Laps and stints for runs back to back from t = 0 (an untimed lap takes 100 s, an out-lap 120 s). */
function session(specs: Spec[], deleted: number[] = []): { laps: PushLap[]; stints: PushStint[] } {
  const laps: PushLap[] = [];
  const stints: PushStint[] = [];
  let start = 0;
  let lap = 1;
  specs.forEach((s, i) => {
    stints.push({ stint: i + 1, lapStart: lap, compound: s.compound, ageAtStart: s.age ?? 0 });
    for (const t of s.laps) {
      const duration = typeof t === "number" ? t : null;
      const ms = (duration ?? (t === "o" ? 120 : 100)) * 1000;
      laps.push({ lap, start, end: start + ms, duration, pitOut: t === "o", deleted: deleted.includes(lap) });
      start += ms;
      lap++;
    }
  });
  return { laps, stints };
}

const setsOf = (specs: Spec[], neutral: NeutralPeriod[] = [], deleted: number[] = []) => {
  const { laps, stints } = session(specs, deleted);
  return pushSets(4, laps, stints, neutral);
};

describe("push laps", () => {
  test("a quali simulation: push, cool-down, push; the drop is the 2nd push minus the 1st", () => {
    const [set, ...rest] = setsOf([{ compound: "SOFT", laps: ["o", 90.0, 120.0, 90.8, 118.0, 90.5, null] }]);
    expect(rest).toEqual([]);
    expect(set).toMatchObject({ driver: 4, stint: 1, compound: "SOFT", age: 1, laps: [2, 4, 6], times: [90.0, 90.8, 90.5], first: 90.0, best: 90.0 });
    expect(set.drop).toBeCloseTo(0.8, 6);
    // The first push lap's start, after the out-lap.
    expect(set.start).toBe(120_000);
    expect(set.end).toBe((120 + 90 + 120 + 90.8 + 118 + 90.5) * 1000);
  });

  test("one push only: no drop; a 2nd push quicker than the 1st is a gain", () => {
    expect(setsOf([{ compound: "SOFT", laps: ["o", 90.0, 120.0, null] }])[0].drop).toBeNull();
    expect(setsOf([{ compound: "SOFT", laps: ["o", 90.6, 120.0, 90.2, null] }])[0].drop).toBeCloseTo(-0.4, 6);
  });

  test("the in-lap doesn't count, nor does a lap before a set change", () => {
    // A quick lap straight into the pits (the next lap is the next set's out-lap).
    const sets = setsOf([
      { compound: "MEDIUM", laps: ["o", 91.0, 91.2] },
      { compound: "SOFT", laps: ["o", 90.0, null] },
    ]);
    expect(sets.map((s) => [s.compound, s.laps])).toEqual([
      ["MEDIUM", [2]],
      ["SOFT", [5]],
    ]);
  });

  test("a set pushed on is judged against its own best; a long run's set isn't", () => {
    const sets = setsOf([
      // Mediums: best 91.6 (101.8% of 90.0), still a set pushed on: 92.5 is within 101.5% of it.
      { compound: "MEDIUM", laps: ["o", 91.6, 125.0, 92.5, null] },
      // Hards: a long run, 94-95 s (104%+).
      { compound: "HARD", age: 3, laps: ["o", 94.2, 94.4, 94.8, 95.0, null] },
      { compound: "SOFT", laps: ["o", 90.0, null] },
    ]);
    expect(sets.map((s) => [s.compound, s.laps])).toEqual([
      ["MEDIUM", [2, 4]],
      ["SOFT", [13]],
    ]);
  });

  test("laps under a neutral period or deleted by now don't count", () => {
    const specs: Spec[] = [{ compound: "SOFT", laps: ["o", 90.0, 120.0, 90.3, 120.0, 90.4, null] }];
    const { laps } = session(specs);
    const vsc: NeutralPeriod = { status: "VSC", start: laps[3].start + 10_000, end: laps[3].end! - 10_000 };
    expect(setsOf(specs, [vsc])[0].laps).toEqual([2, 6]);
    // The best lap deleted: the next one is the 1st push and the best.
    expect(setsOf(specs, [], [2])[0]).toMatchObject({ laps: [4, 6], first: 90.3, best: 90.3 });
  });

  test("tyre age at the first push counts on from the set's age", () => {
    expect(setsOf([{ compound: "SOFT", age: 3, laps: ["o", 120, 90.0, null] }])[0].age).toBe(5);
  });

  test("sets by compound, ranked by best push", () => {
    const a = setsOf([{ compound: "SOFT", laps: ["o", 90.4, null] }]);
    const b = setsOf([{ compound: "MEDIUM", laps: ["o", 91.0, null] }, { compound: "SOFT", laps: ["o", 90.1, null] }]);
    const groups = byCompound([...a, ...b]);
    expect(groups.map((g) => [g.compound, g.sets.map((s) => s.best)])).toEqual([
      ["SOFT", [90.1, 90.4]],
      ["MEDIUM", [91.0]],
    ]);
  });

  test("the pinned set stands in for that set's pushes while it's watched", () => {
    const [set] = setsOf([{ compound: "SOFT", laps: ["o", 90.0, 120.0, 90.8, null] }]);
    const pin = { set, sessionKey: 1 };
    expect(pinHolds(pin, set.start, 1)).toBe(true);
    expect(pinHolds(pin, set.start - 40_000, 1)).toBe(false);
    expect(pinHolds(pin, set.end, 1)).toBe(false);
    expect(pinHolds(pin, set.start, 2)).toBe(false);
    const sofar = { ...set, laps: [2], times: [90.0], drop: null };
    expect(withPin([sofar], pin)).toEqual([set]);
  });

  test("drop text", () => {
    expect(dropText(0.312)).toBe("+0.31");
    expect(dropText(-0.15)).toBe("−0.15");
  });
});
