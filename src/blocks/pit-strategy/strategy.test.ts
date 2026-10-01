// Stops and undercuts on synthetic races: 90 s laps, a stop costs 5 s on the in-lap and 15 s on the
// out-lap. (bun test's describe/test/expect are globals: a block may only import react and block-kit.)

import type { NeutralPeriod } from "block-kit";
import { analyse, CLOSE_S, type CarInput, type PitRecord, type StintStart } from "./strategy";

const LAP_MS = 90_000;

interface CarSpec {
  driver: number;
  /** How far behind the reference car it starts, ms. */
  offset?: number;
  /** In-laps, and the compound fitted at each. */
  stops?: { lap: number; compound: string }[];
  /** Extra ms on a lap (negative: faster). */
  pace?: (lap: number) => number;
  /** Its last completed lap (a retirement, if before the end). */
  last?: number;
  /** OpenF1 has pit records (not in early 2023). */
  records?: boolean;
}

/** The whole race of one car: every lap's end, stints and pit records. */
function race({ driver, offset = 0, stops = [], pace = () => 0, last = 30, records = true }: CarSpec): CarInput {
  const laps = [];
  let t = offset;
  for (let lap = 1; lap <= last; lap++) {
    t += LAP_MS + pace(lap);
    if (stops.some((s) => s.lap === lap)) t += 5_000;
    if (stops.some((s) => s.lap === lap - 1)) t += 15_000;
    laps.push({ lap, end: t });
  }
  const stints: StintStart[] = [{ stint: 1, lapStart: 1, compound: "MEDIUM" }, ...stops.map((s, i) => ({ stint: i + 2, lapStart: s.lap + 1, compound: s.compound }))];
  const pits: PitRecord[] = records
    ? stops.map((s) => {
        const entry = laps[s.lap - 1].end - 10_000;
        return { entry, exit: entry + 22_000, laneDuration: 22, stopDuration: 2.4 };
      })
    : [];
  return { driver, laps, stints, pits };
}

/** What the hooks would give at t: laps completed, stints started by the current lap, stops finished. */
function at(cars: CarInput[], t: number): CarInput[] {
  return cars.map((c) => {
    const laps = c.laps.filter((l) => l.end <= t);
    const lap = (laps.at(-1)?.lap ?? 0) + 1;
    return { ...c, laps, stints: c.stints.filter((s) => s.lapStart <= lap), pits: c.pits.filter((p) => p.exit <= t) };
  });
}

const endOf = (c: CarInput, lap: number) => c.laps.find((l) => l.lap === lap)!.end;

describe("undercuts and overcuts", () => {
  // HAM (44) 1.5 s behind LEC (16) at the end of lap 17. HAM stops after lap 18, LEC after lap 21;
  // they're compared at the end of LEC's out-lap (lap 22).
  const lec = race({ driver: 16, stops: [{ lap: 21, compound: "HARD" }] });

  test("an undercut that works: HAM is ahead after LEC's stop", () => {
    const ham = race({ driver: 44, offset: 1_500, stops: [{ lap: 18, compound: "HARD" }], pace: (l) => (l >= 20 ? -2_000 : 0) });
    const { duels } = analyse([lec, ham], []);
    expect(duels).toHaveLength(1);
    const d = duels[0];
    expect([d.kind, d.attacker, d.defender, d.worked]).toEqual(["undercut", 44, 16, true]);
    expect([d.attackerStop.lap, d.defenderStop.lap]).toEqual([18, 21]);
    expect(d.margin).toBeCloseTo(4.5, 3);
    expect(d.t).toBe(endOf(lec, 22));
  });

  test("an undercut that doesn't: new tyres weren't quick enough", () => {
    const ham = race({ driver: 44, offset: 1_500, stops: [{ lap: 18, compound: "HARD" }], pace: (l) => (l >= 20 ? -300 : 0) });
    const [d] = analyse([lec, ham], []).duels;
    expect([d.kind, d.attacker, d.worked]).toEqual(["undercut", 44, false]);
    expect(d.margin).toBeCloseTo(0.6, 3);
  });

  test("an overcut: LEC stops first, HAM stays out and comes out ahead", () => {
    const lecFirst = race({ driver: 16, stops: [{ lap: 18, compound: "HARD" }], pace: (l) => (l >= 20 ? 500 : 0) });
    const ham = race({ driver: 44, offset: 1_500, stops: [{ lap: 21, compound: "HARD" }], pace: (l) => (l >= 18 && l <= 21 ? -500 : 0) });
    const [d] = analyse([lecFirst, ham], []).duels;
    expect([d.kind, d.attacker, d.defender, d.worked]).toEqual(["overcut", 44, 16, true]);
    expect([d.attackerStop.lap, d.defenderStop.lap]).toEqual([21, 18]);
    expect(d.margin).toBeCloseTo(2, 3);
  });

  test("nothing until both have stopped and crossed the line after: no spoilers", () => {
    const ham = race({ driver: 44, offset: 1_500, stops: [{ lap: 18, compound: "HARD" }], pace: (l) => (l >= 20 ? -2_000 : 0) });
    const decided = endOf(lec, 22);
    expect(analyse(at([lec, ham], decided - 1), []).duels).toEqual([]);
    expect(analyse(at([lec, ham], endOf(ham, 18) + 30_000), []).stops.map((s) => s.driver)).toEqual([44]);
    expect(analyse(at([lec, ham], decided), []).duels).toHaveLength(1);
  });

  test("not when they stop on the same lap, or the reply comes too late", () => {
    const ham = (lap: number) => race({ driver: 44, offset: 1_500, stops: [{ lap, compound: "HARD" }] });
    expect(analyse([lec, ham(21)], []).duels).toEqual([]);
    expect(analyse([lec, ham(14)], []).duels).toEqual([]); // LEC replied 7 laps later
  });

  test(`not when they were more than ${CLOSE_S} s apart`, () => {
    const ham = race({ driver: 44, offset: 3_500, stops: [{ lap: 18, compound: "HARD" }], pace: (l) => (l >= 20 ? -2_000 : 0) });
    expect(analyse([lec, ham], []).duels).toEqual([]);
  });

  test("from the stints alone when there are no pit records (early 2023)", () => {
    const lec2 = race({ driver: 16, stops: [{ lap: 21, compound: "HARD" }], records: false });
    const ham = race({ driver: 44, offset: 1_500, stops: [{ lap: 18, compound: "HARD" }], pace: (l) => (l >= 20 ? -2_000 : 0), records: false });
    const { stops, duels } = analyse([lec2, ham], []);
    expect(stops.map((s) => [s.driver, s.lap, s.from, s.to, s.lane])).toEqual([
      [44, 18, "MEDIUM", "HARD", null],
      [16, 21, "MEDIUM", "HARD", null],
    ]);
    expect(duels.map((d) => [d.kind, d.worked])).toEqual([["undercut", true]]);
  });
});

describe("stops", () => {
  // VER leads; NOR is 8 s behind HAM, too far for an undercut, and passes him while he's in the pits.
  const ver = race({ driver: 1, offset: -20_000 });
  const ham = race({ driver: 44, offset: 1_500, stops: [{ lap: 18, compound: "HARD" }] });
  const nor = race({ driver: 4, offset: 9_500 });

  test("a stop away from anyone: positions before and after, pit times, no undercut", () => {
    const { stops, duels } = analyse([ver, ham, nor], []);
    expect(duels).toEqual([]);
    expect(stops).toHaveLength(1);
    const s = stops[0];
    expect([s.driver, s.lap, s.from, s.to, s.lane, s.stationary, s.before, s.after, s.under]).toEqual([44, 18, "MEDIUM", "HARD", 22, 2.4, 2, 3, null]);
    expect(s.t).toBe(endOf(ham, 18) - 10_000);
  });

  test("the position after isn't known until the out-lap is done", () => {
    const [s] = analyse(at([ver, ham, nor], endOf(ham, 18) + 30_000), []).stops;
    expect([s.before, s.after]).toEqual([2, null]);
  });

  test("a retirement settles nothing: neither the defender before replying, nor the attacker after stopping", () => {
    const lec = race({ driver: 16, stops: [{ lap: 21, compound: "HARD" }] });
    const lecOut = race({ driver: 16, last: 19 });
    const quick = { driver: 44, offset: 1_500, stops: [{ lap: 18, compound: "HARD" }], pace: (l: number) => (l >= 20 ? -2_000 : 0) };
    expect(analyse([lecOut, race(quick)], []).duels).toEqual([]);
    const { stops, duels } = analyse([lec, race({ ...quick, last: 20 })], []);
    expect(duels).toEqual([]);
    expect(stops.map((s) => s.driver)).toEqual([44, 16]);
  });

  test("a pit record with no new stint is a stop without a tyre change", () => {
    const drive = { ...ham, stints: [ham.stints[0]] };
    const [s] = analyse([ver, drive, nor], []).stops;
    expect([s.lap, s.from, s.to, s.lane]).toEqual([18, "MEDIUM", null, 22]);
  });

  test("under a VSC or safety car: pit entry within a period so far", () => {
    const entry = endOf(ham, 18) - 10_000;
    const period = (status: NeutralPeriod["status"], start: number, end: number | null = null): NeutralPeriod => ({ status, start, end });
    const under = (periods: NeutralPeriod[]) => analyse([ver, ham, nor], periods).stops[0].under;
    expect(under([period("VSC", entry - 60_000)])).toBe("VSC");
    expect(under([period("SC", entry - 60_000, entry + 5_000)])).toBe("SC");
    expect(under([period("SC", entry)])).toBe("SC");
    // Over by the time the car came in (no grace after the green), or not out yet.
    expect(under([period("VSC", entry - 60_000, entry)])).toBeNull();
    expect(under([period("SC", entry - 60_000, entry - 1_000)])).toBeNull();
    expect(under([period("SC", entry + 1_000)])).toBeNull();
    // A red flag is neither; the safety car out after it is.
    expect(under([period("RED", entry - 60_000)])).toBeNull();
    expect(under([period("RED", entry - 60_000, entry - 5_000), period("SC", entry - 5_000)])).toBe("SC");
  });

  test("no stop before it happens", () => {
    expect(analyse(at([ver, ham, nor], endOf(ham, 18) - 11_000), []).stops).toEqual([]);
  });
});
