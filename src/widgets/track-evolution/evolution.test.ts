// describe/test/expect are bun test's globals: a widget folder may only import react, widget-kit and its own
// files (bun run lint), so not "bun:test".

import type { NeutralPeriod } from "widget-kit";
import { evolution, gainOf, gainText, trackTempAt, validLaps, type EvoLap, type EvoStint } from "./evolution";

const MIN = 60_000;

/** Laps back to back from `from` ms, numbered from 1; "o" an out-lap (120 s), null untimed (100 s). */
function laps(times: (number | "o" | null)[], from = 0): EvoLap[] {
  let start = from;
  return times.map((x, i) => {
    const duration = typeof x === "number" ? x : null;
    const ms = (duration ?? (x === "o" ? 120 : 100)) * 1000;
    const l: EvoLap = { lap: i + 1, start, end: start + ms, duration, pitOut: x === "o" };
    start += ms;
    return l;
  });
}

const soft: EvoStint[] = [{ lapStart: 1, compound: "SOFT", ageAtStart: 0 }];

describe("valid laps", () => {
  test("out-laps, in-laps and untimed laps don't count; compound and age come from the stint", () => {
    // Out, 3 timed, in-lap, out on a used medium, 2 timed.
    const ls = laps(["o", 90, 91, 92, 110, "o", 89, 90]);
    const stints: EvoStint[] = [
      { lapStart: 1, compound: "SOFT", ageAtStart: 0 },
      { lapStart: 6, compound: "MEDIUM", ageAtStart: 3 },
    ];
    const v = validLaps(1, ls, stints, [], Infinity);
    expect(v.map((l) => l.lap)).toEqual([2, 3, 4, 7, 8]);
    expect(v.map((l) => l.compound)).toEqual(["SOFT", "SOFT", "SOFT", "MEDIUM", "MEDIUM"]);
    expect(v.map((l) => l.age)).toEqual([1, 2, 3, 4, 5]);
  });

  test("a lap before the next stint is an in-lap even without a pit-out flag after it", () => {
    const ls = laps([90, 91, 95, 89]);
    const stints: EvoStint[] = [
      { lapStart: 1, compound: "SOFT", ageAtStart: null },
      { lapStart: 4, compound: "HARD", ageAtStart: 0 },
    ];
    expect(validLaps(1, ls, stints, [], Infinity).map((l) => l.lap)).toEqual([1, 2, 4]);
  });

  test("a lap touched by a neutral period, or deleted by t, doesn't count", () => {
    const ls = laps([90, 90, 90, 90]);
    ls[3].deleted = { t: 500_000, reason: "TRACK LIMITS" };
    const red: NeutralPeriod[] = [{ status: "RED", start: 100_000, end: 150_000 }];
    expect(validLaps(1, ls, soft, red, 400_000).map((l) => l.lap)).toEqual([1, 3, 4]);
    expect(validLaps(1, ls, soft, red, 500_000).map((l) => l.lap)).toEqual([1, 3]);
    // A red flag still out: every lap after its start is touched.
    expect(validLaps(1, ls, soft, [{ status: "RED", start: 100_000, end: null }], Infinity).map((l) => l.lap)).toEqual([1]);
  });
});

describe("evolution", () => {
  test("push laps are within 101.5% of the driver's own best; the step line is the fastest so far", () => {
    const all = new Map([
      [1, laps([90, 92, 91.2, 89.5])],
      [2, laps([93, 89.8, 88.9], 30_000)],
    ]);
    const stints = new Map([
      [1, soft],
      [2, soft],
    ]);
    const e = evolution(all, stints, [], Infinity, 0);
    const push = (n: number) => e.points.filter((p) => p.driver === n && p.push).map((p) => p.lap);
    // Driver 1's best 89.5: up to 90.84. Driver 2's best 88.9: up to 90.23. Driver 1's 89.5 comes after 88.9.
    expect(push(1)).toEqual([1, 4]);
    expect(push(2)).toEqual([2, 3]);
    expect(e.records.map((r) => [r.driver, r.time])).toEqual([
      [1, 90],
      [2, 89.8],
      [2, 88.9],
    ]);
  });

  test("the median of each 10-minute window's push laps, and the gain from the first to the latest", () => {
    // Five drivers, one push lap each 10 minutes from the green light (at 5 min), 0.3 s quicker each window.
    const green = 5 * MIN;
    const all = new Map<number, EvoLap[]>();
    const stints = new Map<number, EvoStint[]>();
    for (let n = 1; n <= 5; n++) {
      const own: EvoLap[] = [0, 1, 2].map((w) => {
        const time = 90 + n * 0.1 - w * 0.3;
        const start = green + w * 10 * MIN + n * MIN;
        return { lap: w * 4 + 1, start, end: start + time * 1000, duration: time, pitOut: false };
      });
      all.set(n, own);
      stints.set(n, soft);
    }
    const e = evolution(all, stints, [], Infinity, green);
    expect(e.windows.map((w) => [(w.from - green) / MIN, w.laps])).toEqual([
      [0, 5],
      [10, 5],
      [20, 5],
    ]);
    expect(e.windows.map((w) => w.median)).toEqual([90.3, 90.3 - 0.3, 90.3 - 0.6]);
    expect(gainOf(e.windows, Infinity, null)?.gain).toBeCloseTo(0.6, 6);
  });

  test("the gain leaves out a window less than half run, by now or by the scheduled end", () => {
    const w = (from: number, median: number) => ({ from: from * MIN, to: (from + 10) * MIN, median, laps: 5 });
    const windows = [w(0, 90.3), w(10, 90), w(20, 90.6)];
    // Live, 4 minutes into the third window: it's left out until it's half run.
    expect(gainOf(windows, 24 * MIN, null)?.last.median).toBe(90);
    expect(gainOf(windows, 25 * MIN, null)?.last.median).toBe(90.6);
    // The session was scheduled to end a minute into it: the laps finishing after the flag don't count.
    expect(gainOf(windows, Infinity, 21 * MIN)?.gain).toBeCloseTo(0.3, 6);
    expect(gainOf(windows.slice(0, 1), Infinity, null)).toBeNull();
  });

  test("a window with fewer than 3 push laps has no median, and one window has no gain", () => {
    const all = new Map([
      [1, laps([90, 90.1])],
      [2, laps([90.2], 1000)],
    ]);
    const e = evolution(all, new Map([[1, soft], [2, soft]]), [], Infinity, 0);
    expect(e.windows.map((w) => w.laps)).toEqual([3]);
    expect(gainOf(e.windows, Infinity, null)).toBeNull();
  });
});

describe("text and weather", () => {
  test("gain", () => {
    expect(gainText(1.24)).toBe("1.2 s quicker since the first runs");
    expect(gainText(-0.4)).toBe("0.4 s slower since the first runs");
    expect(gainText(0.06)).toBe("0.06 s quicker since the first runs");
    expect(gainText(0.004)).toBe("no quicker than in the first runs");
  });

  test("track temperature at a time: the last sample by then", () => {
    const w = [
      { t: 0, trackTemp: 40 },
      { t: 60_000, trackTemp: 39 },
      { t: 120_000, trackTemp: 37 },
    ];
    expect(trackTempAt(w, 90_000)).toBe(39);
    expect(trackTempAt(w, -5)).toBe(40);
    expect(trackTempAt([], 0)).toBeNull();
  });
});
