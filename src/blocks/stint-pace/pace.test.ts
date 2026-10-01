// describe/test/expect are bun test's globals: a block folder may only import react, block-kit and its own
// files (bun run lint), so not "bun:test".

import type { NeutralPeriod } from "block-kit";
import { pacePoints, stintFits, trendText, type PaceLap, type PaceStint } from "./pace";

const LAP_MS = 90_000;

/** Laps 1..times.length, back to back from t = 0 (times in seconds). */
function lapsOf(times: number[], pitOut: number[] = []): PaceLap[] {
  let start = 0;
  return times.map((duration, i) => {
    const lap = { lap: i + 1, start, end: start + duration * 1000, duration, pitOut: pitOut.includes(i + 1) };
    start += duration * 1000;
    return lap;
  });
}

// Two stints: mediums for laps 1-10 (pit at the end of lap 10), hards from lap 11, still on them.
const STINTS: PaceStint[] = [
  { stint: 1, lapStart: 1, lapEnd: 10, compound: "MEDIUM", ageAtStart: 0, open: false },
  { stint: 2, lapStart: 11, lapEnd: 20, compound: "HARD", ageAtStart: 0, open: true },
];
// 90 s getting 0.1 s slower a lap on mediums; 91 s getting 0.05 s slower on hards.
const TIMES = [
  ...Array.from({ length: 10 }, (_, i) => 90 + 0.1 * i),
  ...Array.from({ length: 10 }, (_, i) => 91 + 0.05 * i),
];

describe("stint pace", () => {
  test("lap 1, the in lap and the out lap don't count", () => {
    const times = [...TIMES];
    times[0] = 98; // standing start
    times[9] = 110; // into the pits
    times[10] = 112; // out of the pits
    const points = pacePoints(lapsOf(times, [11]), STINTS, []);
    const reasons = Object.fromEntries(points.filter((p) => p.excluded).map((p) => [p.lap, p.excluded]));
    expect(reasons).toEqual({ 1: "lap-1", 10: "pit-in", 11: "pit-out" });
  });

  test("the out lap counts as one even without the pit-out flag (the stint's first lap)", () => {
    const points = pacePoints(lapsOf(TIMES), STINTS, []);
    expect(points.find((p) => p.lap === 11)?.excluded).toBe("pit-out");
  });

  test("tyre age and compound per lap, as the tyre badge counts them", () => {
    const used: PaceStint[] = [{ ...STINTS[0] }, { ...STINTS[1], ageAtStart: 3 }];
    const points = pacePoints(lapsOf(TIMES), used, []);
    expect(points[1]).toMatchObject({ lap: 2, age: 1, compound: "MEDIUM", stint: 1 });
    expect(points[14]).toMatchObject({ lap: 15, age: 7, compound: "HARD", stint: 2 });
  });

  test("laps slower than 107% of the median are outliers; untimed laps are left out", () => {
    const times = [...TIMES];
    times[4] = 100; // a spin
    const laps = lapsOf(times);
    laps[6] = { ...laps[6], duration: null };
    const points = pacePoints(laps, STINTS, []);
    expect(points.find((p) => p.lap === 5)?.excluded).toBe("slow");
    expect(points.some((p) => p.lap === 7)).toBe(false);
    // 96 s is within 107% of a ~91 s median.
    times[4] = 96;
    expect(pacePoints(lapsOf(times), STINTS, []).find((p) => p.lap === 5)?.excluded).toBeNull();
  });

  // Equal laps, so the times don't move lap boundaries; lap 1, the in lap and the out lap left out of the reasons.
  const neutralReasons = (neutral: NeutralPeriod[]) =>
    Object.fromEntries(
      pacePoints(lapsOf(Array(20).fill(90)), STINTS, neutral)
        .filter((p) => p.excluded && p.lap > 1 && p.lap !== 10 && p.lap !== 11)
        .map((p) => [p.lap, p.excluded]),
    );

  test("laps touched by a safety car, VSC or red flag period don't count", () => {
    const neutral: NeutralPeriod[] = [
      { status: "SC", start: 4 * LAP_MS + 30_000, end: 6 * LAP_MS + 10_000 },
      { status: "VSC", start: 14 * LAP_MS + 5_000, end: 14 * LAP_MS + 50_000 },
      { status: "RED", start: 17 * LAP_MS + 60_000, end: 17 * LAP_MS + 80_000 },
    ];
    expect(neutralReasons(neutral)).toEqual({ 5: "SC", 6: "SC", 7: "SC", 15: "VSC", 18: "RED" });
  });

  test("a period still out runs on to the last lap", () => {
    expect(neutralReasons([{ status: "SC", start: 16 * LAP_MS + 30_000, end: null }])).toEqual({ 17: "SC", 18: "SC", 19: "SC", 20: "SC" });
  });

  test("the trend per stint is the slope through its clean laps", () => {
    const points = pacePoints(lapsOf(TIMES), STINTS, []);
    const fits = stintFits(points, STINTS);
    expect(fits).toHaveLength(2);
    // Mediums: laps 2-9 (lap 1 and the in lap out).
    expect(fits[0]).toMatchObject({ stint: 1, compound: "MEDIUM", laps: 8, fromLap: 2, toLap: 9, open: false });
    expect(fits[0].slope).toBeCloseTo(0.1, 6);
    expect(fits[0].intercept).toBeCloseTo(90, 6);
    // Hards: laps 12-20 (the out lap out).
    expect(fits[1]).toMatchObject({ stint: 2, compound: "HARD", laps: 9, fromLap: 12, toLap: 20, fromAge: 1, toAge: 9, open: true });
    expect(fits[1].slope).toBeCloseTo(0.05, 6);
  });

  test("a stint with too few clean laps has no trend yet", () => {
    // The race so far: 13 laps, so 2 clean laps on the hards.
    const stints: PaceStint[] = [STINTS[0], { ...STINTS[1], lapEnd: 14 }];
    const points = pacePoints(lapsOf(TIMES.slice(0, 13)), stints, []);
    expect(stintFits(points, stints).map((f) => f.stint)).toEqual([1]);
  });

  test("trend text", () => {
    expect(trendText(0.0834)).toBe("+0.08 s/lap");
    expect(trendText(-0.031)).toBe("−0.03 s/lap");
  });
});
