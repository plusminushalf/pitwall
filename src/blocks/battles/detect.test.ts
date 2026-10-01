// Battle detection on synthetic laps. describe/test/expect are bun test's globals: a block folder may only
// import react, block-kit and its own files (bun run lint), so not "bun:test".

import { detectBattles, neutralSpells, pitLapsOf, type CarLaps, type Inputs, type LapLine } from "./detect";

const LAP = 90_000;

/** Laps from the times (ms) a car crossed the line at the end of each lap; lap 1 starts at 0. */
function lapsOf(ends: number[], pitOut: number[] = []): LapLine[] {
  return ends.map((end, i) => ({ lap: i + 1, start: i === 0 ? 0 : ends[i - 1], end, pitOut: pitOut.includes(i + 1) }));
}

/** A car at a steady 90 s a lap, `offset(lap)` ms behind the reference at the end of each lap. */
function car(driver: number, laps: number, offset: (lap: number) => number, more: Partial<CarLaps> = {}): CarLaps {
  const ends = Array.from({ length: laps }, (_, i) => (i + 1) * LAP + offset(i + 1));
  return { driver, laps: lapsOf(ends), stintStarts: [1], out: false, finished: false, ...more };
}

const input = (cars: CarLaps[], more: Partial<Inputs> = {}): Inputs => ({ cars, neutral: [], pitEntries: [], passes: [], ...more });
const OPTS = { gap: 1, minLaps: 3 };

describe("detectBattles", () => {
  test("a sustained battle with an overtake: who passed, on which lap, and the feed's moment", () => {
    // 1 leads 2 by 0.5 s on laps 1-5; 2 is 0.3 s ahead on laps 6-8, then pulls away. Both run 10 laps.
    const one = car(1, 10, () => 0);
    const two = car(2, 10, (k) => (k <= 5 ? 500 : k <= 8 ? -300 : -3_000));
    const leader = car(3, 10, () => -20_000);
    const pass = { t: 5 * LAP + 40_000, by: 2, on: 1 };
    const [b, ...rest] = detectBattles(input([one, two, leader], { passes: [pass] }), OPTS);
    expect(rest).toHaveLength(0);
    expect(b).toMatchObject({ from: 1, to: 8, ahead: 2, behind: 1, position: 2, ongoing: false, end: { reason: "gap" } });
    expect(b.closest).toBeCloseTo(0.3);
    expect(b.passes).toEqual([{ lap: 6, by: 2, on: 1, t: pass.t, exact: true }]);
    // Without the feed's overtake: the line crossing that showed it.
    const [inferred] = detectBattles(input([one, two, leader]), OPTS);
    expect(inferred.passes).toEqual([{ lap: 6, by: 2, on: 1, t: 6 * LAP - 300, exact: false }]);
  });

  test("a battle with no pass: the car ahead kept the other behind", () => {
    const one = car(1, 10, () => 0);
    const two = car(2, 10, (k) => (k >= 3 && k <= 7 ? 600 : 4_000));
    const [b, ...rest] = detectBattles(input([one, two]), OPTS);
    expect(rest).toHaveLength(0);
    expect(b).toMatchObject({ from: 3, to: 7, ahead: 1, behind: 2, passes: [], ongoing: false, end: { reason: "gap" } });
    expect(b.t).toBe(3 * LAP);
    expect(b.last).toBeCloseTo(0.6);
  });

  test("too few laps together isn't a battle", () => {
    const one = car(1, 10, () => 0);
    const two = car(2, 10, (k) => (k === 4 || k === 5 ? 400 : 3_000));
    expect(detectBattles(input([one, two]), OPTS)).toEqual([]);
    expect(detectBattles(input([one, two]), { gap: 1, minLaps: 2 })).toHaveLength(1);
  });

  test("an ongoing battle: close on the last laps both completed; listed before the ones that ended", () => {
    const one = car(1, 12, () => 0);
    const two = car(2, 12, (k) => (k >= 9 ? 400 : 5_000));
    // An earlier, finished battle further down.
    const three = car(3, 12, () => 30_000);
    const four = car(4, 12, (k) => (k <= 4 ? 30_500 : 40_000));
    const battles = detectBattles(input([one, two, three, four]), OPTS);
    expect(battles.map((b) => [b.ahead, b.behind, b.ongoing])).toEqual([
      [1, 2, true],
      [3, 4, false],
    ]);
    expect(battles[0]).toMatchObject({ from: 9, to: 12, end: null });
    // Once one of them retires, or takes the flag, it's over.
    const out = detectBattles(input([one, { ...two, out: true }]), OPTS)[0];
    expect(out).toMatchObject({ ongoing: false, end: { reason: "retired", driver: 2 } });
    const flag = detectBattles(input([{ ...one, finished: true }, { ...two, finished: true }]), OPTS)[0];
    expect(flag).toMatchObject({ ongoing: false, end: { reason: "flag" } });
    // A pit-lane entry after the line ends it before the lap does.
    const pitted = detectBattles(input([one, two], { pitEntries: [{ driver: 1, t: 12 * LAP + 80_000 }] }), OPTS)[0];
    expect(pitted).toMatchObject({ ongoing: false, end: { reason: "pit", driver: 1 } });
  });

  test("a pit stop shuffling the order isn't a battle", () => {
    // 1 runs 5 s ahead of 2 and pits on lap 4: its in-lap crossing (in the pit lane) is 0.4 s ahead of 2,
    // its out-lap 0.6 s behind, then it drops 4 s back. Close only on its in- and out-lap.
    const one = car(1, 10, (k) => (k < 4 ? 0 : k === 4 ? 4_600 : k === 5 ? 5_600 : 9_000), { stintStarts: [1, 5] });
    const two = car(2, 10, () => 5_000);
    expect(detectBattles(input([one, two]), { gap: 1, minLaps: 2 })).toEqual([]);
    // The same stop known only from the pit-out flag, or only from the feed's pit entry.
    const flagged = { ...one, stintStarts: [1], laps: lapsOf(one.laps.map((l) => l.end!), [5]) };
    expect(detectBattles(input([flagged, two]), { gap: 1, minLaps: 2 })).toEqual([]);
    const fed = { ...one, stintStarts: [1] };
    expect(detectBattles(input([fed, two], { pitEntries: [{ driver: 1, t: 4 * LAP - 10_000 }] }), { gap: 1, minLaps: 2 })).toEqual([]);
  });

  test("a lapped car next to the leader on the road isn't a battle", () => {
    // 9 is a lap down, crossing the line 0.5 s before the leader every lap (holding it up, blue flags).
    const leader = car(1, 12, () => 0);
    const lapped = { ...car(9, 11, () => 0), laps: lapsOf(Array.from({ length: 11 }, (_, i) => (i + 2) * LAP - 500)) };
    expect(detectBattles(input([leader, lapped]), OPTS)).toEqual([]);
  });

  test("laps under the safety car don't count, and split a battle", () => {
    const one = car(1, 12, () => 0);
    const two = car(2, 12, () => 500);
    const neutral = [{ from: 5 * LAP + 10_000, to: 7 * LAP + 10_000, kind: "sc" as const }];
    const battles = detectBattles(input([one, two], { neutral }), OPTS);
    expect(battles.map((b) => [b.from, b.to])).toEqual([
      [9, 12],
      [1, 5],
    ]);
    expect(battles[1].end).toEqual({ reason: "neutral", driver: null, neutral: "sc" });
  });

  test("only cars next to each other: a third car between them splits the pair", () => {
    const one = car(1, 8, () => 0);
    const mid = car(2, 8, () => 400);
    const three = car(3, 8, () => 800);
    const pairs = detectBattles(input([one, mid, three]), OPTS).map((b) => [b.ahead, b.behind]);
    expect(pairs.sort()).toEqual([
      [1, 2],
      [2, 3],
    ]);
  });
});

describe("pitLapsOf", () => {
  test("the in-lap and out-lap, from stints, pit-out flags or pit entries", () => {
    const c = car(1, 10, () => 0, { stintStarts: [1, 4] });
    expect([...pitLapsOf(c, [])].sort()).toEqual([3, 4]);
    expect([...pitLapsOf({ ...c, stintStarts: [1], laps: lapsOf(c.laps.map((l) => l.end!), [7]) }, [])].sort()).toEqual([6, 7]);
    expect([...pitLapsOf({ ...c, stintStarts: [1] }, [{ driver: 1, t: 8 * LAP - 5_000 }])].sort()).toEqual([8, 9]);
  });
});

describe("neutralSpells", () => {
  test("safety car to 'in this lap', VSC to 'ending' plus 15 s, red flag to the pit exit opening", () => {
    const sc = (t: number, text: string) => ({ t, kind: "safety-car", text });
    const spells = neutralSpells([
      sc(100, "SAFETY CAR DEPLOYED"),
      sc(200, "SAFETY CAR IN THIS LAP"),
      sc(300, "VSC DEPLOYED"),
      sc(400, "VSC ENDING"),
      { t: 500, kind: "control", text: "RED FLAG - RACE SUSPENDED" },
      { t: 600, kind: "flag", text: "GREEN LIGHT - PIT EXIT OPEN", flag: "GREEN" },
      sc(700, "VIRTUAL SAFETY CAR DEPLOYED"),
    ]);
    expect(spells).toEqual([
      { from: 100, to: 200, kind: "sc" },
      { from: 300, to: 15_400, kind: "vsc" },
      { from: 500, to: 600, kind: "red" },
      { from: 700, to: Infinity, kind: "vsc" },
    ]);
  });

  test("a red flag restarting behind the safety car stays neutral until it comes in", () => {
    const spells = neutralSpells([
      { t: 100, kind: "flag", text: "RED FLAG", flag: "RED" },
      { t: 150, kind: "safety-car", text: "SAFETY CAR DEPLOYED" },
      { t: 200, kind: "flag", text: "GREEN LIGHT - PIT EXIT OPEN", flag: "GREEN" },
      { t: 300, kind: "safety-car", text: "SAFETY CAR IN THIS LAP" },
    ]);
    expect(spells).toEqual([{ from: 100, to: 300, kind: "sc" }]);
  });
});
