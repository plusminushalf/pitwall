import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import type { RaceControlMsg, SessionMeta } from "../types";
import { raceDistanceAt, scheduledDistance } from "./raceDistance";

const msg = (t: number, message: string): RaceControlMsg => ({ t, lap: 1, category: "Other", flag: null, scope: null, sector: null, driver: null, message });

type Meta = Parameters<typeof raceDistanceAt>[0];
const race = (over: Partial<Meta>): Meta => ({
  circuit: "Suzuka",
  sessionName: "Race",
  totalLaps: 53,
  lightsOut: 300_000,
  chequered: 5_000_000,
  raceControl: [],
  ...over,
});

describe("race distance at t", () => {
  test("a race shortened after lap N shows the scheduled distance until the chequered flag", () => {
    // Red flag, not resumed: the results say 30 laps.
    const meta = race({ totalLaps: 30, chequered: 3_000_000 });
    expect(raceDistanceAt(meta, 0).totalLaps).toBe(53);
    expect(raceDistanceAt(meta, 2_999_999).totalLaps).toBe(53);
    expect(raceDistanceAt(meta, 3_000_000).totalLaps).toBe(30);
    expect(scheduledDistance(meta).totalLaps).toBe(53);
  });

  test("an extra formation lap takes a lap off when race control announces it", () => {
    const meta = race({ totalLaps: 52, raceControl: [msg(100_000, "EXTRA FORMATION LAP")] });
    expect(raceDistanceAt(meta, 99_999).totalLaps).toBe(53);
    expect(raceDistanceAt(meta, 100_000).totalLaps).toBe(52);
  });

  test("an extra formation lap on a resumption after the start doesn't", () => {
    const meta = race({ raceControl: [msg(2_000_000, "EXTRA FORMATION LAP")] });
    expect(raceDistanceAt(meta, 2_500_000).totalLaps).toBe(53);
  });

  test("a full-distance race is unchanged", () => {
    const meta = race({});
    for (const t of [0, 1_000_000, 5_000_000]) expect(raceDistanceAt(meta, t)).toEqual({ totalLaps: 53, estimated: false });
  });

  test("sprints use the sprint distance; unknown circuits fall back to the results", () => {
    expect(raceDistanceAt(race({ circuit: "Shanghai", sessionName: "Sprint", totalLaps: 12 }), 0).totalLaps).toBe(19);
    expect(raceDistanceAt(race({ circuit: "Nowhere", totalLaps: 40 }), 0).totalLaps).toBe(40);
  });

  test("live: the scheduled distance replaces the estimate", () => {
    expect(raceDistanceAt(race({ totalLaps: 54, totalLapsEstimated: true, chequered: null }), 1_000_000)).toEqual({ totalLaps: 53, estimated: false });
    expect(raceDistanceAt(race({ circuit: "Nowhere", totalLaps: 54, totalLapsEstimated: true, chequered: null }), 0)).toEqual({ totalLaps: 54, estimated: true });
  });
});

// Against the real 2026 Canadian GP (run `bun run ingest 11291` first): 68 laps after an extra formation lap.
const dir = new URL("../../data/sessions/11291/", import.meta.url).pathname;
const available = existsSync(`${dir}meta.json`);

describe.skipIf(!available)("Montreal 2026", () => {
  const meta: SessionMeta = available ? JSON.parse(readFileSync(`${dir}meta.json`, "utf8")) : (null as unknown as SessionMeta);

  test("scheduled 70, 69 after the extra formation lap, 68 at the flag", () => {
    expect(meta.totalLaps).toBe(68);
    expect(raceDistanceAt(meta, 0).totalLaps).toBe(70);
    expect(raceDistanceAt(meta, meta.lightsOut + 60_000).totalLaps).toBe(69);
    expect(raceDistanceAt(meta, meta.chequered! - 1).totalLaps).toBe(69);
    expect(raceDistanceAt(meta, meta.chequered!).totalLaps).toBe(68);
  });
});
