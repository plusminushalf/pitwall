// describe/test/expect are bun test's globals: a widget folder may only import react, widget-kit and its own
// files (bun run lint), so not "bun:test".

import type { NeutralPeriod } from "widget-kit";
import { bestLap, leftOf, paceRows, tyreOf, validLaps, watching, withPin, type Best, type PaceLap, type PaceStint } from "./pace";

/** A lap's spec: its sectors (the duration is their sum), "o" an out-lap, null untimed. */
type Spec = [number, number, number] | "o" | null;

/** Laps back to back from t = 0 (an untimed lap takes 100 s, an out-lap 120 s), numbered from 1. */
function lapsOf(specs: Spec[], extra: Partial<Record<number, Partial<PaceLap>>> = {}): PaceLap[] {
  let start = 0;
  return specs.map((s, i) => {
    const sectors = Array.isArray(s) ? s : ([null, null, null] as const);
    const duration = Array.isArray(s) ? s[0] + s[1] + s[2] : null;
    const ms = (duration ?? (s === "o" ? 120 : 100)) * 1000;
    const lap: PaceLap = { lap: i + 1, start, end: start + ms, duration, sectors, pitOut: s === "o", ...extra[i + 1] };
    start += ms;
    return lap;
  });
}

const soft: PaceStint[] = [{ lapStart: 1, compound: "SOFT", ageAtStart: 0 }];

describe("valid laps", () => {
  test("out-laps, in-laps and untimed laps don't count", () => {
    // Out, push, cool-down, push, in; out on a new set, push, (in-lap under way).
    const laps = lapsOf(["o", [30, 40, 20], [40, 50, 30], [29, 40, 21], null, "o", [30, 39, 20]]);
    const stints: PaceStint[] = [
      { lapStart: 1, compound: "SOFT", ageAtStart: 0 },
      { lapStart: 6, compound: "MEDIUM", ageAtStart: 2 },
    ];
    expect(validLaps(laps, stints, [], 0).map((l) => l.lap)).toEqual([2, 3, 4, 7]);
    // A timed in-lap: the lap before an out-lap, or before a new stint.
    const timed = lapsOf(["o", [30, 40, 20], [30, 40, 25], "o", [30, 40, 20], [31, 40, 20]]);
    const two: PaceStint[] = [
      { lapStart: 1, compound: "SOFT", ageAtStart: 0 },
      { lapStart: 6, compound: "SOFT", ageAtStart: 0 },
    ];
    expect(validLaps(timed, soft, [], 0).map((l) => l.lap)).toEqual([2, 5, 6]);
    expect(validLaps(timed, two, [], 0).map((l) => l.lap)).toEqual([2]);
  });

  test("laps touched by a safety car, VSC or red flag don't count", () => {
    const laps = lapsOf(["o", [30, 40, 20], [30, 40, 20], [30, 40, 20]]);
    // A red flag from the middle of lap 3 (120 + 90 + 45 s) to its end; an open VSC from late in lap 4.
    const neutral: NeutralPeriod[] = [
      { status: "RED", start: 255_000, end: 300_000 },
      { status: "VSC", start: 385_000, end: null },
    ];
    expect(validLaps(laps, soft, neutral, 0).map((l) => l.lap)).toEqual([2]);
  });

  test("a deleted lap counts until it's deleted", () => {
    const laps = lapsOf(["o", [30, 40, 20], [29, 40, 20]], { 3: { deleted: { t: 400_000 } } });
    expect(validLaps(laps, soft, [], 399_999).map((l) => l.lap)).toEqual([2, 3]);
    expect(validLaps(laps, soft, [], 400_000).map((l) => l.lap)).toEqual([2]);
  });
});

describe("best lap", () => {
  test("the quickest valid lap, its set and age, and the ideal lap from the best sectors", () => {
    const laps = lapsOf(["o", [30.1, 40.2, 20.3], [40, 50, 30], [29.9, 40.4, 20.1], null]);
    const stints: PaceStint[] = [{ lapStart: 1, compound: "SOFT", ageAtStart: 3 }];
    const b = bestLap(4, laps, stints, [], 0)!;
    expect(b).toMatchObject({ driver: 4, lap: 4, compound: "SOFT", age: 6, start: (120 + 90.6 + 120) * 1000 });
    expect(b.time).toBeCloseTo(90.4, 6);
    expect(b.ideal).toBeCloseTo(29.9 + 40.2 + 20.1, 6);
    expect(leftOf(b)).toBeCloseTo(0.2, 6);
  });

  test("sectors of laps that don't count aren't in the ideal lap; a missing sector leaves it unknown", () => {
    // The out-lap's and the deleted lap's quick sectors aren't used.
    const laps = lapsOf(["o", [30, 40, 20], [28, 39, 19]], { 1: { sectors: [1, 1, 1] }, 3: { deleted: { t: 0 } } });
    expect(bestLap(4, laps, soft, [], 0)!.ideal).toBeCloseTo(90, 6);
    const gap = lapsOf(["o", [30, 40, 20]], { 2: { sectors: [30, null, 20] } });
    const b = bestLap(4, gap, soft, [], 0)!;
    expect(b.ideal).toBeNull();
    expect(leftOf(b)).toBeNull();
  });

  test("none without a valid lap", () => {
    expect(bestLap(4, lapsOf(["o", null]), soft, [], 0)).toBeNull();
    expect(bestLap(4, [], [], [], 0)).toBeNull();
  });

  test("the set's age: laps since the stint started, on its age then (unknown: 0)", () => {
    const stints: PaceStint[] = [
      { lapStart: 1, compound: "SOFT", ageAtStart: 0 },
      { lapStart: 5, compound: "MEDIUM", ageAtStart: null },
    ];
    expect(tyreOf(stints, 3)).toEqual({ compound: "SOFT", age: 2 });
    expect(tyreOf(stints, 7)).toEqual({ compound: "MEDIUM", age: 2 });
    expect(tyreOf([], 1)).toBeNull();
  });
});

const best = (driver: number, time: number, end = 0): Best => ({ driver, lap: 5, time, start: end - time * 1000, end, compound: "SOFT", age: 1, ideal: null });

describe("pace rows", () => {
  test("quickest first, with the gap to it; equal times: the one set first", () => {
    const rows = paceRows([best(16, 91.2, 10), best(1, 90.5, 30), best(4, 90.5, 20)]);
    expect(rows.map((r) => [r.best.driver, r.rank, Math.round(r.gap * 1000)])).toEqual([
      [4, 1, 0],
      [1, 2, 0],
      [16, 3, 700],
    ]);
  });

  test("by team: each team's quicker driver", () => {
    const team = (n: number) => (n === 1 || n === 81 ? "McLaren" : "Ferrari");
    const rows = paceRows([best(1, 90.5), best(81, 90.4), best(16, 90.9), best(44, 90.6)], team);
    expect(rows.map((r) => [r.best.driver, r.rank, Math.round(r.gap * 1000)])).toEqual([
      [81, 1, 0],
      [44, 2, 200],
    ]);
  });
});

describe("the lap being watched", () => {
  const pinned = best(1, 90.5, 500_000);
  const pin = { best: pinned, sessionKey: 9 };

  test("is watched from a little before its start until it ends, in its session", () => {
    expect(watching(pin, pinned.start, 9)).toBe(true);
    expect(watching(pin, pinned.start - 30_000, 9)).toBe(true);
    expect(watching(pin, pinned.start - 30_001, 9)).toBe(false);
    expect(watching(pin, pinned.end, 9)).toBe(false);
    expect(watching(pin, pinned.start, 10)).toBe(false);
  });

  test("stands in for its driver's best so far", () => {
    const older = best(1, 91.0, 200_000);
    const rows = paceRows(withPin([older, best(16, 90.8)], pin));
    expect(rows.map((r) => [r.best.driver, r.best.time])).toEqual([
      [1, 90.5],
      [16, 90.8],
    ]);
    expect(withPin([older], null)).toEqual([older]);
  });
});
