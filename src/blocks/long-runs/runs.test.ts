// describe/test/expect are bun test's globals: a block folder may only import react, block-kit and its own
// files (bun run lint), so not "bun:test".

import type { NeutralPeriod } from "block-kit";
import { byCompound, degText, listRows, longRuns, pinAt, pinFor, PIN_LEAD_MS, type LongRun, type PinnedRun, type RunLap, type RunStint } from "./runs";

/** A run from the garage: its compound, the set's age, and its laps ("o" the out-lap, null untimed: the in-lap). */
type Spec = { compound: string; age?: number; laps: (number | "o" | null)[] };

/**
 * Laps and stints for runs back to back from t = 0 (an untimed lap takes 100 s, an out-lap 120 s), the last stint
 * open. Lap numbers count on through all the runs, as OpenF1's do.
 */
function session(specs: Spec[]): { laps: RunLap[]; stints: RunStint[] } {
  const laps: RunLap[] = [];
  const stints: RunStint[] = [];
  let start = 0;
  let lap = 1;
  specs.forEach((s, i) => {
    stints.push({ stint: i + 1, lapStart: lap, compound: s.compound, ageAtStart: s.age ?? 0, open: i === specs.length - 1 });
    for (const t of s.laps) {
      const duration = typeof t === "number" ? t : null;
      const ms = (duration ?? (t === "o" ? 120 : 100)) * 1000;
      laps.push({ lap, start, end: start + ms, duration, pitOut: t === "o" });
      start += ms;
      lap++;
    }
  });
  return { laps, stints };
}

const runsOf = (specs: Spec[], neutral: NeutralPeriod[] = []) => {
  const { laps, stints } = session(specs);
  return longRuns(44, laps, stints, neutral);
};

describe("long runs", () => {
  test("a run at race pace: its laps between the out-lap and the in-lap, with the set's age and a trend", () => {
    // 2026 Melbourne FP2, ANT's hards (7 laps old): 13 laps, one a little slow.
    const laps = [84.7, 84.2, 84.1, 84.0, 84.1, 84.0, 83.8, 83.7, 83.7, 84.6, 88.7, 84.4, 84.9];
    const [run, ...rest] = runsOf([{ compound: "MEDIUM", laps: ["o", 82.2, 121.5, 81.1, null] }, { compound: "HARD", age: 7, laps: ["o", ...laps, null] }]);
    expect(rest).toEqual([]);
    expect(run).toMatchObject({ driver: 44, stint: 2, compound: "HARD", age: 8, laps: [7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19], skipped: 0, ongoing: false });
    expect(run.average).toBeCloseTo(laps.reduce((a, b) => a + b) / laps.length, 6);
    // The out-lap's start: the first counted lap's.
    expect(run.start).toBe((120 + 82.2 + 121.5 + 81.1 + 100 + 120) * 1000);
  });

  test("quali simulations (push, cool-down, push...) aren't long runs", () => {
    // GAS's mediums: five push laps, a cool-down lap between each.
    expect(runsOf([{ compound: "MEDIUM", laps: ["o", 85.0, 118.3, 83.4, 121.8, 82.8, 115.4, 82.4, 119.3, 82.5, null] }])).toEqual([]);
    // LEC's hards: the same, with a slow lap or two between pushes.
    expect(runsOf([{ compound: "HARD", laps: ["o", 110.1, 82.2, 103.8, 81.5, 127.3, 95.4, 81.8, 104.3, null] }])).toEqual([]);
  });

  test("a lap or two in traffic doesn't end a run; they aren't counted", () => {
    // HAD's mediums: 93.4 after two laps, 92.5 and 114.2 after two more.
    const [run] = runsOf([{ compound: "MEDIUM", laps: ["o", 84.4, 84.7, 93.4, 84.0, 84.3, 92.5, 114.2, 85.9, 85.2, 84.6, null] }]);
    expect(run.laps).toEqual([2, 3, 5, 6, 9, 10, 11]);
    expect(run.skipped).toBe(3);
  });

  test("a quali simulation on the set before the run isn't part of it", () => {
    // NOR's softs: two push laps, then the run (two slow laps in it), then the cool-down lap after the flag.
    const [run, ...rest] = runsOf([{ compound: "SOFT", laps: ["o", 80.8, 116.3, 110.0, 81.0, 105.9, 84.9, 83.4, 83.0, 95.9, 92.5, 88.1, 83.6, 85.3, 157.1] }]);
    expect(rest).toEqual([]);
    expect(run).toMatchObject({ laps: [7, 8, 9, 12, 13, 14], skipped: 2, age: 6 });
  });

  test("laps under a VSC are left out, and don't end the run", () => {
    const specs: Spec[] = [{ compound: "MEDIUM", laps: ["o", 84.0, 84.2, 84.1, 98.0, 99.0, 97.0, 84.3, 84.4, 84.2, null] }];
    const { laps } = session(specs);
    // Three slow laps in a row: two runs of three laps, neither a long run.
    expect(runsOf(specs)).toEqual([]);
    const vsc: NeutralPeriod = { status: "VSC", start: laps[4].start + 10_000, end: laps[6].end! - 10_000 };
    expect(runsOf(specs, [vsc])[0]).toMatchObject({ laps: [2, 3, 4, 8, 9, 10], skipped: 3 });
    // Still out: every lap from its start on is touched.
    expect(runsOf(specs, [{ ...vsc, end: null }])).toEqual([]);
  });

  test("a push lap tacked onto the start of a run isn't race pace", () => {
    const [run] = runsOf([{ compound: "SOFT", laps: ["o", 80.4, 84.2, 84.0, 84.3, 84.1, 84.5, null] }]);
    expect(run.laps).toEqual([3, 4, 5, 6, 7]);
  });

  test("fewer than five laps at pace is no long run; the minimum can be set", () => {
    const specs: Spec[] = [{ compound: "HARD", age: 11, laps: ["o", 86.8, 86.5, 86.1, 85.6, null] }];
    expect(runsOf(specs)).toEqual([]);
    const { laps, stints } = session(specs);
    expect(longRuns(44, laps, stints, [], 4)).toHaveLength(1);
  });

  test("spoiler-free: a run on the set the car is on grows lap by lap, and is ongoing until it comes in", () => {
    const full: Spec = { compound: "MEDIUM", age: 8, laps: ["o", 85.8, 85.8, 86.0, 85.5, 85.7, 86.5, 86.1, null] };
    const { laps, stints } = session([full]);
    expect(longRuns(44, laps.slice(0, 5), stints, [])).toEqual([]);
    const now = longRuns(44, laps.slice(0, 6), stints, []);
    expect(now).toHaveLength(1);
    expect(now[0]).toMatchObject({ laps: [2, 3, 4, 5, 6], ongoing: true, age: 9 });
    const done = longRuns(44, laps, stints, []);
    expect(done[0]).toMatchObject({ laps: [2, 3, 4, 5, 6, 7, 8], ongoing: false });
  });

  test("degradation: seconds per lap of tyre age", () => {
    const times = Array.from({ length: 10 }, (_, i) => 90 + 0.08 * i);
    const [run] = runsOf([{ compound: "HARD", laps: ["o", ...times, null] }]);
    expect(run.deg).toBeCloseTo(0.08, 6);
    expect(degText(run.deg)).toBe("+0.08");
    expect(degText(-0.031)).toBe("−0.03");
  });

  test("ranked within each compound, softest first", () => {
    const run = (driver: number, compound: string, average: number) => ({ driver, stint: 1, compound, age: 0, laps: [], skipped: 0, start: 0, ends: [], average, deg: 0, ongoing: false });
    const groups = byCompound([run(1, "HARD", 85), run(2, "MEDIUM", 84.5), run(3, "HARD", 84.8), run(4, "SOFT", 84)]);
    expect(groups.map((g) => [g.compound, g.runs.map((r) => r.driver)])).toEqual([
      ["SOFT", [4]],
      ["MEDIUM", [2]],
      ["HARD", [3, 1]],
    ]);
  });
});

describe("the run being watched (pinned)", () => {
  // HAD's mediums: laps 2-11 at pace, then the in-lap. The list at the end of the session has it 2nd on mediums.
  const specs: Spec[] = [{ compound: "MEDIUM", laps: ["o", 85.8, 85.8, 86.0, 85.5, 85.7, 86.5, 86.1, 86.0, 85.6, 85.4, null] }];
  const { laps, stints } = session(specs);
  const had = longRuns(6, laps, stints, [])[0];
  const quicker: LongRun = { ...had, driver: 63, stint: 3, average: had.average - 0.4, start: 0, ends: [80_000] };
  const slower: LongRun = { ...had, driver: 30, stint: 2, average: had.average + 0.3, start: 0, ends: [90_000] };
  const pin: PinnedRun = { run: had, rank: 2, gap: 0.4, sessionKey: 11228 };
  const end = had.ends.at(-1)!;

  test("is watched from a little before its first lap until it ends, in its session", () => {
    expect(pinAt(pin, had.start, 11228)).toEqual({ lap: 1, of: 10, fraction: 0 });
    // A few seconds back (the out-lap) still watches it; clearly before it doesn't.
    expect(pinAt(pin, had.start - PIN_LEAD_MS, 11228)?.lap).toBe(1);
    expect(pinAt(pin, had.start - PIN_LEAD_MS - 1, 11228)).toBeNull();
    // Three laps done: on the fourth.
    expect(pinAt(pin, had.ends[2] + 1, 11228)).toMatchObject({ lap: 4, of: 10 });
    expect(pinAt(pin, end - 1, 11228)).toMatchObject({ lap: 10 });
    expect(pinAt(pin, end - 1, 11228)!.fraction).toBeCloseTo(1, 4);
    // Past its end the list has it again; another session drops it.
    expect(pinAt(pin, end, 11228)).toBeNull();
    expect(pinAt(pin, had.start, 9183)).toBeNull();
  });

  test("stays in the list as it was clicked while its laps aren't all done, among the runs done by now", () => {
    // Seeked back to its start: its own laps aren't done, a quicker and a slower run are.
    const progress = pinAt(pin, had.start, 11228);
    const [mediums] = listRows([slower, quicker], pin, progress);
    expect(mediums.compound).toBe("MEDIUM");
    // The pinned run keeps its rank and gap from the click; the others are ranked among themselves.
    expect(mediums.rows.map((r) => [r.run.driver, r.rank, r.gap == null ? null : Math.round(r.gap * 1000) / 1000, r.pinned != null])).toEqual([
      [63, 1, null, false],
      [6, 2, 0.4, true],
      [30, 2, 0.7, false],
    ]);
    // Alone on its compound: a group of its own, among the others.
    const soft = { ...quicker, compound: "SOFT" };
    expect(listRows([soft], pin, progress).map((g) => [g.compound, g.rows.map((r) => r.run.driver)])).toEqual([
      ["SOFT", [63]],
      ["MEDIUM", [6]],
    ]);
  });

  test("replaces its own run so far (once five of its laps are done), and nothing else is added", () => {
    const soFar = longRuns(6, laps.slice(0, 7), stints, [])[0];
    expect(soFar.laps).toHaveLength(6);
    const rows = listRows([soFar, quicker], pin, pinAt(pin, laps[6].end!, 11228))[0].rows;
    expect(rows.map((r) => [r.run.driver, r.run.laps.length, r.pinned?.lap])).toEqual([
      [63, 10, undefined],
      [6, 10, 7],
    ]);
  });

  test("a click pins the run as the list shows it; another run takes the pin; the pinned one keeps it (and starts over)", () => {
    const rows = listRows([slower, quicker], null, null)[0].rows;
    const first = pinFor(rows[1], null, 11228);
    expect(first).toEqual({ run: slower, rank: 2, gap: rows[1].gap, sessionKey: 11228 });
    const watching = listRows([quicker], first, pinAt(first, slower.start, 11228))[0].rows;
    expect(pinFor(watching.find((r) => r.pinned)!, first, 11228)).toBe(first);
    expect(pinFor(watching.find((r) => !r.pinned)!, first, 11228)).toMatchObject({ run: quicker, rank: 1, gap: null });
  });

  test("not watched: the list is just the runs at t", () => {
    const rows = listRows([slower, quicker], pin, null)[0].rows;
    expect(rows.map((r) => [r.run.driver, r.rank, r.pinned])).toEqual([
      [63, 1, null],
      [30, 2, null],
    ]);
    expect(listRows([slower, quicker], null, null)).toEqual(listRows([slower, quicker], pin, pinAt(pin, end, 11228)));
  });
});

