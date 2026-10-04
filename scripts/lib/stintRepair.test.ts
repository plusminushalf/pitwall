// OpenF1 stints missing a stop (stintRepair.ts), on 2026 Kuala Lumpur's shape: VER stopped on laps 9, 33 and 43,
// the stints have one set from lap 10 to the flag.

import { describe, expect, test } from "bun:test";
import { repairStints } from "./stintRepair";
import type { Lap, PitStop, Stint } from "../../src/types";

const LAP_MS = 100_000;
const lapsOf = (driver: number, count: number): Lap[] =>
  Array.from({ length: count }, (_, i) => ({
    driver,
    lap: i + 1,
    start: i * LAP_MS,
    end: (i + 1) * LAP_MS,
    duration: LAP_MS / 1000,
    sectors: [null, null, null],
    segments: [[], [], []],
    speedTrap: { i1: null, i2: null, st: null },
    pitOut: false,
  }));
/** A stop at the end of `lap`: into the pit lane 5 s before the line, out 20 s after it. */
const pit = (driver: number, lap: number): PitStop => ({ driver, lap, entry: lap * LAP_MS - 5_000, exit: lap * LAP_MS + 20_000, laneDuration: 25, stopDuration: null });
const stint = (driver: number, n: number, lapStart: number, lapEnd: number, compound = "SOFT", ageAtStart: number | null = 0): Stint => ({ driver, stint: n, lapStart, lapEnd, compound, ageAtStart });

describe("stint repair", () => {
  test("a stop with no stint after it starts one on an unknown set", () => {
    const { stints, added } = repairStints([stint(3, 1, 1, 9, "MEDIUM"), stint(3, 2, 10, 55)], [pit(3, 9), pit(3, 33), pit(3, 43)], lapsOf(3, 55), []);
    expect(added).toBe(2);
    expect(stints).toEqual([
      stint(3, 1, 1, 9, "MEDIUM"),
      stint(3, 2, 10, 33),
      stint(3, 3, 34, 43, "UNKNOWN", null),
      stint(3, 4, 44, 55, "UNKNOWN", null),
    ]);
  });

  test("stops the stints have are left alone, used sets included", () => {
    const given = [stint(12, 1, 1, 33, "MEDIUM"), stint(12, 2, 34, 44), stint(12, 3, 45, 55, "SOFT", 3)];
    const { stints, added } = repairStints(given, [pit(12, 33), pit(12, 44)], lapsOf(12, 55), []);
    expect(added).toBe(0);
    expect(stints).toEqual(given);
  });

  test("a stint that came out a lap off the stop counts as its stint", () => {
    const { added } = repairStints([stint(1, 1, 1, 20), stint(1, 2, 22, 40)], [pit(1, 20)], lapsOf(1, 40), []);
    expect(added).toBe(0);
  });

  test("a drive-through or stop-go goes through the pit lane without tyres", () => {
    const rc = [{ t: 25 * LAP_MS, driver: null, message: "FIA STEWARDS: DRIVE THROUGH PENALTY FOR CAR 44 (HAM) - SPEEDING IN THE PIT LANE" }];
    const { stints, added } = repairStints([stint(44, 1, 1, 50)], [pit(44, 27), pit(44, 40)], lapsOf(44, 50), rc);
    expect(added).toBe(1);
    expect(stints.map((s) => s.lapStart)).toEqual([1, 41]);
  });

  test("a stop before the next stint is published (live) still starts one", () => {
    const { stints } = repairStints([stint(16, 1, 1, 28)], [pit(16, 28)], lapsOf(16, 29), []);
    expect(stints).toEqual([stint(16, 1, 1, 28), stint(16, 2, 29, 29, "UNKNOWN", null)]);
  });
});
