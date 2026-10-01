// describe/test/expect are bun test's globals: a block folder may only import react, block-kit and its own
// files (bun run lint), so not "bun:test".

import { crossingsOf, gapScale, gapSeries, INTERVAL_CAP, leaderCrossings, neutralisedLaps, orderAtLine, type Crossings, type NeutralPeriod } from "./gaps";

// Crossings in seconds from lights out at t = 0 (index = lap), as ms.
const at = (...s: (number | null)[]): Crossings => [null, ...s.map((v) => (v == null ? null : v * 1000))];

// Car 1 leads to lap 3, car 2 passes it on lap 4. Car 3 retires after lap 2. Car 4 is lapped by
// car 2 on lap 3 (car 2 finishes lap 4 at 360 s, before car 4 finishes lap 3 at 365 s).
const all = new Map<number, Crossings>([
  [1, at(90, 180, 270, 361)],
  [2, at(91, 181, 270.5, 360)],
  [3, at(95, 186)],
  [4, at(110, 230, 365)],
]);

describe("gap chart: crossings", () => {
  test("a car's completed laps by lap number, holes left empty", () => {
    expect(crossingsOf([])).toEqual([null]);
    expect(crossingsOf([{ lap: 1, end: 90_000 }, { lap: 3, end: 270_000 }])).toEqual([null, 90_000, null, 270_000]);
  });

  test("the leader's crossing is the first at each lap, whoever it is", () => {
    expect(leaderCrossings([...all.values()])).toEqual([null, 90_000, 180_000, 270_000, 360_000]);
    expect(leaderCrossings([])).toEqual([null]);
  });
});

describe("gap chart: gaps", () => {
  test("to the leader: the leader changes with the lead, a retired car's line ends, a lapped car's line ends", () => {
    const [a, b, c, d] = gapSeries(all, [1, 2, 3, 4], "leader");
    expect(a.gaps).toEqual([null, 0, 0, 0, 1]);
    expect(b.gaps).toEqual([null, 1, 1, 0.5, 0]);
    expect(c.gaps).toEqual([null, 5, 6]);
    // Lap 3 ends after car 2 finished lap 4: lapped.
    expect(d.gaps).toEqual([null, 20, 50, "lapped"]);
  });

  test("interval: to whoever crossed just before at that lap; nobody ahead is leading", () => {
    const [a, b, c, d] = gapSeries(all, [1, 2, 3, 4], "interval");
    expect(a.gaps).toEqual([null, "leading", "leading", "leading", 1]);
    expect(b.gaps).toEqual([null, 1, 1, 0.5, "leading"]);
    expect(c.gaps).toEqual([null, 4, 5]);
    // Lapped cars keep an interval (to the car ahead at the same lap count), like the timing tower.
    expect(d.gaps.map((g) => (typeof g === "number" ? Math.round(g * 10) / 10 : g))).toEqual([null, 15, 44, 94.5]);
  });

  test("a missing lap breaks the line; a car with no laps or no data has none", () => {
    const holes = new Map<number, Crossings>([...all, [5, at(92, null, 280)], [6, [null]]]);
    const [e, f, g] = gapSeries(holes, [5, 6, 7], "leader");
    expect(e.gaps).toEqual([null, 2, null, 10]);
    expect(f.gaps).toEqual([null]);
    expect(g.gaps).toEqual([]);
  });

  test("the order at the line: most laps first, then who crossed first", () => {
    expect(orderAtLine(all)).toEqual([2, 1, 4, 3]);
    expect(orderAtLine(new Map([[1, [null]]]))).toEqual([]);
  });
});

describe("gap chart: safety car laps", () => {
  const leader = [null, 90_000, 180_000, 270_000, 360_000];
  // A period in seconds; no end: still out.
  const period = (status: NeutralPeriod["status"], start: number, end: number | null = null): NeutralPeriod => ({
    status,
    start: start * 1000,
    end: end == null ? null : end * 1000,
  });

  test("a lap is marked when the period overlaps it, from the leader's crossing before to theirs at its end", () => {
    // Lap 2 (90-180 s) and lap 3 (180-270 s); lap 4 and the lap in progress are green.
    expect(neutralisedLaps([period("SC", 100, 250)], leader, 0)).toEqual([null, null, "SC", "SC", null, null]);
    // Ending as the leader crosses the line: the next lap is green.
    expect(neutralisedLaps([period("SC", 100, 270)], leader, 0)).toEqual([null, null, "SC", "SC", null, null]);
  });

  test("VSC; one still out marks the lap in progress", () => {
    expect(neutralisedLaps([period("VSC", 30, 75)], leader, 0)).toEqual([null, "VSC", null, null, null, null]);
    expect(neutralisedLaps([period("VSC", 365)], leader, 0)).toEqual([null, null, null, null, null, "VSC"]);
  });

  test("a red flag isn't marked; a VSC turned into a safety car marks SC", () => {
    expect(neutralisedLaps([period("SC", 100, 120), period("RED", 120, 200)], leader, 0)).toEqual([null, null, "SC", null, null, null]);
    const upgraded = [period("VSC", 100, 170), period("SC", 170)];
    expect(neutralisedLaps(upgraded, leader, 0)).toEqual([null, null, "SC", "SC", "SC", "SC"]);
  });

  test("no laps yet: only lap 1, from lights out", () => {
    expect(neutralisedLaps([period("SC", 10)], [null], 5_000)).toEqual([null, "SC"]);
    expect(neutralisedLaps([period("SC", 1, 4)], [null], 5_000)).toEqual([null, null]);
    expect(neutralisedLaps([], [null], 5_000)).toEqual([null, null]);
  });
});

describe("gap chart: y scale", () => {
  test("fits the largest gap in round steps, at least 1 s", () => {
    expect(gapScale(0, "leader", 4)).toEqual({ max: 1, step: 0.5, capped: false });
    expect(gapScale(3.2, "leader", 4)).toEqual({ max: 4, step: 1, capped: false });
    expect(gapScale(47, "leader", 4)).toEqual({ max: 60, step: 15, capped: false });
    expect(gapScale(95, "leader", 2)).toEqual({ max: 120, step: 60, capped: false });
  });

  test("interval stops at the cap", () => {
    expect(gapScale(25, "interval", 4)).toEqual({ max: INTERVAL_CAP, step: 5, capped: true });
    expect(gapScale(2.1, "interval", 4)).toEqual({ max: 3, step: 1, capped: false });
  });
});
