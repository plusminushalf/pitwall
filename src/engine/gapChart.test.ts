import { describe, expect, test } from "bun:test";
// (Here, not next to it: blocks may only import block-kit, and bun:test isn't that.)
import { crossingsOf, gapScale, gapSeries, INTERVAL_CAP, leaderCrossings, neutralisedLaps, neutralisedPeriods, orderAtLine, type Crossings } from "../blocks/gap-chart/gaps";

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
  const msg = (t: number, text: string, flag: string | null = null) => ({ t: t * 1000, text, flag });

  test("safety car: from deployed to the leader's next crossing after 'in this lap'", () => {
    const messages = [msg(100, "SAFETY CAR DEPLOYED"), msg(200, "SAFETY CAR IN THIS LAP")];
    expect(neutralisedPeriods(messages, leader)).toEqual([{ kind: "SC", from: 100_000, to: 270_000 }]);
    // Lap 2 (90-180 s) and lap 3 (180-270 s); lap 4 and the lap in progress are green.
    expect(neutralisedLaps(messages, leader, 0)).toEqual([null, null, "SC", "SC", null, null]);
  });

  test("VSC: ends 15 s after 'ending'; one still running marks the lap in progress", () => {
    const vsc = [msg(30, "VIRTUAL SAFETY CAR DEPLOYED"), msg(60, "VIRTUAL SAFETY CAR ENDING")];
    expect(neutralisedLaps(vsc, leader, 0)).toEqual([null, "VSC", null, null, null, null]);
    // 2026 wording, still running at t: the lap in progress is under it.
    expect(neutralisedLaps([msg(365, "VSC DEPLOYED")], leader, 0)).toEqual([null, null, null, null, null, "VSC"]);
  });

  test("a red flag ends it; a VSC turned into a safety car marks SC", () => {
    expect(neutralisedPeriods([msg(100, "SAFETY CAR DEPLOYED"), msg(120, "RED FLAG", "RED")], leader)).toEqual([
      { kind: "SC", from: 100_000, to: 120_000 },
    ]);
    const upgraded = [msg(100, "VIRTUAL SAFETY CAR DEPLOYED"), msg(170, "SAFETY CAR DEPLOYED")];
    expect(neutralisedLaps(upgraded, leader, 0)).toEqual([null, null, "SC", "SC", "SC", "SC"]);
  });

  test("no laps yet: only lap 1, from lights out", () => {
    expect(neutralisedLaps([msg(10, "SAFETY CAR DEPLOYED")], [null], 5_000)).toEqual([null, "SC"]);
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
