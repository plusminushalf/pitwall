// describe/test/expect are bun test's globals: a widget folder may only import react, widget-kit and its own
// files (bun run lint), so not "bun:test".

import type { NeutralPeriod } from "widget-kit";
import { dots, placeLabels, pushLaps, topSpeed, validLaps, type SpeedLap, type SpeedStint } from "./speed";

/** Laps back to back from t = 0: a number is a timed lap ("o" an out-lap of 120 s, null untimed), traps as given. */
function laps(times: (number | "o" | null)[], traps: (number | null)[] = []): SpeedLap[] {
  let start = 0;
  return times.map((t, i) => {
    const duration = t === "o" ? 120 : t;
    const ms = (duration ?? 120) * 1000;
    const lap: SpeedLap = { lap: i + 1, start, end: start + ms, duration, pitOut: t === "o", st: traps[i] ?? null, i2: null, deleted: false };
    start += ms;
    return lap;
  });
}

const SOFTS: SpeedStint[] = [{ lapStart: 1, compound: "SOFT", ageAtStart: 0 }];

describe("speed vs lap time", () => {
  test("valid laps: no out-lap, in-lap, untimed, deleted or neutralised lap; tyre and age from the stint", () => {
    // Out, push, cool, push, in (the next is an out-lap), out, push on a new set.
    const ls = laps(["o", 80.5, 110, 80.2, 95, "o", 80.0]);
    const stints: SpeedStint[] = [...SOFTS, { lapStart: 6, compound: "MEDIUM", ageAtStart: 2 }];
    expect(validLaps(ls, stints, []).map((l) => l.lap)).toEqual([2, 3, 4, 7]);
    expect(validLaps(ls, stints, []).at(-1)).toMatchObject({ compound: "MEDIUM", age: 3 });
    // The lap before a new stint is an in-lap even without an out-lap flag.
    const noFlag = ls.map((l) => ({ ...l, pitOut: false }));
    expect(validLaps(noFlag, stints, []).map((l) => l.lap)).toEqual([1, 2, 3, 4, 6, 7]);
    // Deleted (by now), and touched by a VSC.
    const deleted = ls.map((l) => (l.lap === 4 ? { ...l, deleted: true } : l));
    const vsc: NeutralPeriod = { status: "VSC", start: ls[1].start + 5_000, end: ls[1].start + 10_000 };
    expect(validLaps(deleted, stints, [vsc]).map((l) => l.lap)).toEqual([3, 7]);
  });

  test("push laps are within 1.5% of the best", () => {
    const valid = validLaps(laps(["o", 80.0, 81.1, 81.3, 90]), SOFTS, []);
    expect(pushLaps(valid).map((l) => l.lap)).toEqual([2, 3]);
  });

  test("top speed: the median of the top three readings (a tow doesn't count), else the highest", () => {
    expect(topSpeed([318, 331, 320, 319])).toEqual({ speed: 320, method: "median", readings: 4 });
    expect(topSpeed([318, 331])).toEqual({ speed: 331, method: "max", readings: 2 });
    expect(topSpeed([])).toBeNull();
  });

  test("dots: top speed from push laps only, intermediate 2 without a speed trap, gap to the fastest", () => {
    // A slow lap with a towed 340 isn't a push lap.
    const a = validLaps(laps(["o", 80.0, 80.4, 85.0, 80.6], [null, 320, 322, 340, 318]), SOFTS, []);
    const b = laps(["o", 80.9, 81.0], []).map((l) => (l.lap === 2 ? { ...l, i2: 300 } : l));
    const [da, db] = dots([
      { key: "1", drivers: [{ driver: 1, valid: a }] },
      { key: "2", drivers: [{ driver: 2, valid: validLaps(b, SOFTS, []) }] },
    ]);
    expect(da).toMatchObject({ driver: 1, speed: 320, method: "median", gap: 0, best: { lap: 2 } });
    expect(db).toMatchObject({ driver: 2, speed: 300, method: "max" });
    expect(db.gap).toBeCloseTo(0.9, 6);
  });

  test("a team: both cars' push laps, its best lap and whose it is", () => {
    const a = validLaps(laps(["o", 80.5, 80.6], [null, 310, 312]), SOFTS, []);
    const b = validLaps(laps(["o", 80.2], [null, 316]), SOFTS, []);
    const [team] = dots([{ key: "Ferrari", drivers: [{ driver: 16, valid: a }, { driver: 44, valid: b }] }]);
    expect(team).toMatchObject({ driver: 44, speed: 312, method: "median", readings: 3, gap: 0 });
  });

  test("labels go right, else left, above or below, away from other labels and dots", () => {
    expect(placeLabels([{ x: 50, y: 50, w: 20 }], 200)).toEqual(["right"]);
    // At the right edge: left.
    expect(placeLabels([{ x: 195, y: 50, w: 20 }], 200)).toEqual(["left"]);
    // A dot just right of another: the first label goes left (it'd cover the dot), the second right.
    expect(placeLabels([{ x: 50, y: 50, w: 20 }, { x: 62, y: 50, w: 20 }], 200)).toEqual(["left", "right"]);
    // Three in a row: the middle one's label goes above.
    expect(placeLabels([{ x: 30, y: 50, w: 20 }, { x: 50, y: 50, w: 20 }, { x: 70, y: 50, w: 20 }], 200)).toEqual(["left", "above", "right"]);
  });
});
