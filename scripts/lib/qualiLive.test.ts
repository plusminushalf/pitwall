// Live qualifying (qualiLive.ts, src/engine/qualiPhase.ts): the segments from race control, the timing screen through
// them, and the clock and cut the screen shows. Checked end to end on cached 2026 qualifying (Kuala Lumpur 11730,
// Melbourne 11230 with two red flags, Shanghai sprint qualifying 11236) replayed live: the order at the end matched
// the official classification for every car.

import { describe, expect, test } from "bun:test";
import { liveSegments, qualiStandings } from "./qualiLive";
import { qualiPhaseAt, segmentBest, SETTLE_MS, standingOf } from "../../src/engine/qualiPhase";
import type { Lap, LiveQualiSegment, RaceControlMsg } from "../../src/types";

const MIN = 60_000;
const msg = (t: number, category: string, message: string, flag: string | null = null, scope: string | null = null): RaceControlMsg => ({
  t,
  lap: null,
  category,
  flag,
  scope,
  sector: null,
  driver: null,
  message,
});
const started = (t: number) => msg(t, "SessionStatus", "SESSION STARTED");
const flag = (t: number) => [msg(t, "SessionStatus", "SESSION FINISHED"), msg(t, "Flag", "CHEQUERED FLAG", "CHEQUERED", "Track")];

const lap = (driver: number, n: number, start: number, duration: number | null, extra: Partial<Lap> = {}): Lap => ({
  driver,
  lap: n,
  start,
  end: duration != null ? start + duration * 1000 : null,
  duration,
  sectors: [null, null, null],
  segments: [[], [], []],
  speedTrap: { i1: null, i2: null, st: null },
  pitOut: false,
  ...extra,
});

const segment = (number: number, start: number, end: number | null, advance: number | null): LiveQualiSegment => ({
  number,
  name: `Q${number}`,
  start,
  end,
  advance,
  length: 18 * MIN,
  stopped: [],
});

/** Position, gap and interval of every car at t, from the events. */
function screenAt(s: ReturnType<typeof qualiStandings>, t: number) {
  const pos = new Map<number, number>();
  const gap = new Map<number, number | string | null>();
  for (const p of s.positions) if (p.t <= t) pos.set(p.driver, p.position);
  for (const i of s.intervals) if (i.t <= t) gap.set(i.driver, i.gapToLeader);
  return [...pos].sort((a, b) => a[1] - b[1]).map(([n, p]) => `P${p} #${n} ${gap.get(n) ?? "-"}`);
}

describe("live qualifying segments", () => {
  test("a red flag stops the clock until the session starts again; no qualifying_phase needed", () => {
    // Melbourne 2026, Q1: red flag 10:31 in, restarted 8:29 later.
    const rc = [
      started(0),
      msg(631_433, "SessionStatus", "SESSION ABORTED"),
      msg(631_000, "Flag", "RED FLAG", "RED", "Track"),
      started(1_140_000),
      ...flag(1_589_000),
      started(2_040_000),
      ...flag(2_940_000),
      started(3_540_000),
    ];
    const segs = liveSegments(rc, { sprint: false, year: 2026, entries: 22 });
    expect(segs.map((s) => [s.name, s.start, s.end, s.advance, s.length / MIN])).toEqual([
      ["Q1", 0, 1_589_000, 16, 18],
      ["Q2", 2_040_000, 2_940_000, 10, 15],
      ["Q3", 3_540_000, null, null, 13],
    ]);
    expect(segs[0].stopped).toEqual([{ from: 631_000, to: 1_140_000 }]);
    // Its clock ran out at the flag: 18 minutes of running time.
    expect(qualiPhaseAt({ qualiLive: { segments: segs }, drivers: new Array(22) }, 1_589_000).left).toBe(0);
  });

  test("sprint qualifying: SQ1 to SQ3, 12, 10 and 8 minutes; 15 of 20 cars go through", () => {
    const segs = liveSegments([started(0), ...flag(12 * MIN), started(19 * MIN)], { sprint: true, year: 2026, entries: 20 });
    expect(segs.map((s) => [s.name, s.length / MIN, s.advance])).toEqual([
      ["SQ1", 12, 15],
      ["SQ2", 10, 10],
    ]);
  });

  test("before 2026, Q3 is 12 minutes", () => {
    const [, , q3] = liveSegments([started(0), ...flag(1), started(2), ...flag(3), started(4)], { sprint: false, year: 2025, entries: 20 });
    expect(q3.length).toBe(12 * MIN);
  });
});

describe("live qualifying standings", () => {
  // Four cars; two go through Q1, then one through Q2.
  const segs = [segment(1, 0, 10 * MIN, 2), segment(2, 15 * MIN, 25 * MIN, 1), segment(3, 30 * MIN, null, null)];
  const laps = [
    lap(1, 2, 60_000, 90),
    lap(2, 2, 70_000, 89.5),
    lap(3, 2, 80_000, 91),
    lap(4, 2, 85_000, 92),
    // Started a second before the flag: still Q1's.
    lap(3, 4, 10 * MIN - 1_000, 89, { deleted: { t: 13 * MIN, reason: "TRACK LIMITS AT TURN 4" } }),
    lap(1, 6, 16 * MIN, 88.8),
    lap(2, 6, 16 * MIN + 5_000, 89.1),
    // An out-lap never counts.
    lap(1, 7, 31 * MIN, 80, { pitOut: true }),
  ];
  const s = qualiStandings(laps, [1, 2, 3, 4], segs);

  test("before Q1: car number order", () => {
    const before = qualiStandings([], [4, 1, 3, 2], [segment(1, MIN, null, 2)]);
    expect(screenAt(before, 0)).toEqual(["P1 #1 -", "P2 #2 -", "P3 #3 -", "P4 #4 -"]);
  });

  test("Q1 by best lap; a lap started before the flag counts until race control deletes it", () => {
    expect(screenAt(s, 3 * MIN)).toEqual(["P1 #2 -", "P2 #1 0.5", "P3 #3 1.5", "P4 #4 2.5"]);
    expect(screenAt(s, 12 * MIN)).toEqual(["P1 #3 -", "P2 #2 0.5", "P3 #1 1", "P4 #4 3"]);
    // Deleted: #1 goes back through, #3 out.
    expect(screenAt(s, 14 * MIN)).toEqual(["P1 #2 -", "P2 #1 0.5", "P3 #3 1.5", "P4 #4 2.5"]);
  });

  test("Q2 starts from Q1's order; the cars knocked out keep their places and Q1 gaps", () => {
    expect(screenAt(s, 15 * MIN)).toEqual(["P1 #2 -", "P2 #1 -", "P3 #3 1.5", "P4 #4 2.5"]);
    expect(screenAt(s, 20 * MIN)).toEqual(["P1 #1 -", "P2 #2 0.3", "P3 #3 1.5", "P4 #4 2.5"]);
    expect(screenAt(s, 31 * MIN)).toEqual(["P1 #1 -", "P2 #2 0.3", "P3 #3 1.5", "P4 #4 2.5"]);
  });

  test("a driver's best in a segment, as the tower shows it", () => {
    const own = laps.filter((l) => l.driver === 3);
    expect(segmentBest(own, segs[0], 12 * MIN)).toBe(89);
    expect(segmentBest(own, segs[0], 14 * MIN)).toBe(91);
  });
});

describe("live qualifying at t", () => {
  const segs = [{ ...segment(1, 0, 20 * MIN, 16), stopped: [{ from: 5 * MIN, to: 7 * MIN }] }, segment(2, 27 * MIN, null, 10)];
  const meta = { qualiLive: { segments: segs }, drivers: new Array(22) };

  test("the clock stops under a red flag", () => {
    expect(qualiPhaseAt(meta, 4 * MIN).left).toBe(14 * MIN);
    const red = qualiPhaseAt(meta, 6 * MIN);
    expect([red.red, red.left]).toEqual([true, 13 * MIN]);
    expect(qualiPhaseAt(meta, 8 * MIN).left).toBe(12 * MIN);
  });

  test("below the cut: the drop zone while it can change, out once the laps after the flag are done", () => {
    const running = qualiPhaseAt(meta, 10 * MIN);
    expect([standingOf(running, 16), standingOf(running, 17)]).toEqual([null, { danger: true }]);
    expect(standingOf(qualiPhaseAt(meta, 20 * MIN + 1_000), 17)).toEqual({ danger: true });
    expect(standingOf(qualiPhaseAt(meta, 20 * MIN + SETTLE_MS), 17)).toEqual({ out: segs[0] });
  });

  test("in Q2, the cars out in Q1 stay out; the field is the 16 through", () => {
    const q2 = qualiPhaseAt(meta, 30 * MIN);
    expect([q2.segment?.name, q2.field]).toEqual(["Q2", 16]);
    expect([standingOf(q2, 10), standingOf(q2, 11), standingOf(q2, 17)]).toEqual([null, { danger: true }, { out: segs[0] }]);
  });
});
