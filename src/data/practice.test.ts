// Practice's lap comparison: the classification, tyres and default laps, on a made-up session and against the
// real 2026 Australian GP FP2 (run `bun run ingest 11228` first).

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import type { DriverInfo, Lap, SessionMeta, Stint } from "../types";
import { canCompare, compareModel } from "./compare";
import { defaultPracticeLap, practiceClassification, practiceComparable, tyreOn } from "./practice";

const lap = (driver: number, n: number, start: number, duration: number | null, extra: Partial<Lap> = {}): Lap => ({
  driver,
  lap: n,
  start,
  end: duration != null ? start + duration * 1000 : start + 100_000,
  duration,
  sectors: [null, null, null],
  segments: [[], [], []],
  speedTrap: { i1: null, i2: null, st: null },
  pitOut: false,
  ...extra,
});
const driver = (number: number, acronym: string) => ({ number, acronym }) as DriverInfo;
const stint = (driver: number, n: number, lapStart: number, compound: string, ageAtStart: number): Stint => ({ driver, stint: n, lapStart, lapEnd: lapStart + 3, compound, ageAtStart });

// Two drivers: #1's fastest lap is deleted (track limits), #4 has no time.
const META = {
  drivers: [driver(1, "VER"), driver(4, "NOR"), driver(16, "LEC")],
  laps: [
    lap(1, 1, 0, null, { pitOut: true }),
    lap(1, 2, 120_000, 80.1, { deleted: { t: 300_000, reason: "TRACK LIMITS AT TURN 4" } }),
    lap(1, 3, 200_100, 80.5),
    lap(1, 4, 280_600, null),
    lap(1, 5, 900_000, null, { pitOut: true }),
    lap(1, 6, 1_020_000, 84.0),
    lap(16, 1, 0, null, { pitOut: true }),
    lap(16, 2, 120_000, 80.5),
    lap(16, 3, 200_500, 80.3),
    lap(4, 1, 0, null, { pitOut: true }),
  ],
  stints: [stint(1, 1, 1, "SOFT", 0), stint(1, 2, 5, "HARD", 3), stint(16, 1, 1, "SOFT", 2)],
  practice: { scheduledEnd: 3_600_000, lapLength: 5232.5, sectorDistances: [1735, 3135.6] as [number, number], traced: [{ driver: 1, laps: [2, 3, 6] }, { driver: 16, laps: [2] }] },
} as unknown as SessionMeta;

describe("practice classification", () => {
  test("by best lap that counts (a deleted one doesn't), cars without a time last, gaps to P1", () => {
    const c = practiceClassification(META);
    expect(c.map((r) => [r.position, r.driver, r.best, r.lap, r.gap, r.laps])).toEqual([
      [1, 16, 80.3, 3, null, 3],
      [2, 1, 80.5, 3, 0.2, 6],
      [3, 4, null, null, null, 1],
    ]);
    expect(c[1].deleted).toEqual([{ lap: 2, reason: "TRACK LIMITS AT TURN 4" }]);
  });

  test("ties: the lap set first ranks first", () => {
    const meta = { ...META, laps: [lap(16, 2, 120_000, 80.3), lap(1, 2, 100_000, 80.3)] } as SessionMeta;
    expect(practiceClassification(meta).map((r) => r.driver)).toEqual([1, 16, 4]);
  });

  test("the tyre a lap was on: its stint's compound, and laps on the set before it", () => {
    expect(tyreOn(META, 1, 2)).toEqual({ compound: "SOFT", age: 1 });
    expect(tyreOn(META, 1, 6)).toEqual({ compound: "HARD", age: 4 });
    expect(tyreOn(META, 16, 3)).toEqual({ compound: "SOFT", age: 4 });
    expect(tyreOn(META, 4, 1)).toBeNull();
  });

  test("the lap compared by default: the best that counts, else the fastest traced lap that counts", () => {
    expect(defaultPracticeLap(META, 1)).toBe(3);
    // LEC's best (lap 3) has no trace: lap 2 has.
    expect(defaultPracticeLap(META, 16)).toBe(2);
    expect(defaultPracticeLap(META, 4)).toBeNull();
  });

  test("compared only once downloaded: with lap traces (live and a download being watched have none)", () => {
    expect(practiceComparable(META)).toBe(true);
    expect(canCompare({ ...META, practice: { scheduledEnd: 3_600_000 } })).toBe(false);
    const model = compareModel(META)!;
    expect(model.kind).toBe("practice");
    expect(model.presets).toEqual([]);
    expect(model.defaultDrivers).toEqual([16, 1]);
    expect(model.deleted(1, 2)).toBe("TRACK LIMITS AT TURN 4");
    expect(model.lapGroups(1)).toEqual([
      {
        name: "Run 1 · Soft, new",
        laps: [
          { lap: 2, duration: 80.1, notes: ["deleted"], tyre: { compound: "SOFT", age: 1 } },
          { lap: 3, duration: 80.5, notes: ["★ best"], tyre: { compound: "SOFT", age: 2 } },
        ],
      },
      { name: "Run 2 · Hard, 3 laps old", laps: [{ lap: 6, duration: 84, notes: [], tyre: { compound: "HARD", age: 4 } }] },
    ]);
  });
});

const dir = new URL("../../data/sessions/11228/", import.meta.url).pathname;
const meta = existsSync(`${dir}meta.json`) ? (JSON.parse(readFileSync(`${dir}meta.json`, "utf8")) as SessionMeta) : null;

describe.skipIf(!meta?.practice?.lapLength)("2026 Australian GP FP2", () => {
  test("the classification is the official one, and every driver's best lap with a time has a trace", () => {
    const c = practiceClassification(meta!);
    const official = [...meta!.results].sort((a, b) => (a.position ?? 99) - (b.position ?? 99));
    expect(c.filter((r) => r.best != null).map((r) => r.driver)).toEqual(official.filter((r) => r.position != null && r.duration != null).map((r) => r.driver));
    for (const r of c) {
      if (r.lap != null) expect(defaultPracticeLap(meta!, r.driver, c)).toBe(r.lap);
    }
    expect(compareModel(meta!)!.defaultDrivers).toEqual(official.slice(0, 2).map((r) => r.driver));
  });
});
