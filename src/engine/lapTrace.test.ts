import { describe, expect, test } from "bun:test";
import { buildSession } from "../data/session";
import type { DriverTelemetry, Lap, SessionMeta } from "../types";
import { timeAtDistance, valueAtDistance } from "./compare";
import { lapGeometryOf, lapTraceOf } from "./lapTrace";

// Two cars on a 1 km lap: car 1 steady at 180 km/h (50 m/s: a 20 s lap), car 2 steady at 150 km/h (a 24 s lap).
// Sector boundaries at 300 m and 600 m. Lap starts jittered by up to 800 ms against the
// chained times, as OpenF1 dates them.
const LAP_M = 1_000;
const JITTER = [0, 600, -500, 800, -300, 400];

function lapsOf(driver: number, duration: number, sectors: [number, number, number], n = 6): Lap[] {
  return Array.from({ length: n }, (_, i) => ({
    driver,
    lap: i + 1,
    start: i * duration * 1000 + JITTER[i],
    end: (i + 1) * duration * 1000 + JITTER[i],
    duration,
    sectors,
    segments: [[], [], []],
    speedTrap: { i1: null, i2: null, st: null },
    pitOut: false,
  }));
}

/** Car data every 250 ms over 120 s at speed(t) km/h. */
function car(driver: number, speed: (t: number) => number): DriverTelemetry {
  const n = 480;
  const t = Array.from({ length: n }, (_, i) => (i === 0 ? 0 : 250));
  const abs = Array.from({ length: n }, (_, i) => i * 250);
  return {
    driver,
    loc: { t: [0, 60_000, 60_000], x: [0, 1, 2], y: [0, 0, 0], z: [0, 0, 0] },
    car: { t, speed: abs.map(speed), rpm: abs.map(() => 10_000), gear: abs.map(() => 7), throttle: abs.map(() => 100), brake: abs.map((x) => ((x % 20_000) / 20_000 > 0.9 ? 100 : 0)) },
  };
}

const laps2 = lapsOf(2, 24, [7.2, 7.2, 9.6]);

const meta = {
  sessionKey: 1,
  meetingName: "Test",
  sessionName: "Race",
  year: 2026,
  circuit: "Test",
  country: "Test",
  gmtOffset: "00:00:00",
  t0: "2026-01-01T00:00:00Z",
  duration: 120_000,
  lightsOut: 0,
  totalLaps: 6,
  drivers: [1, 2].map((number) => ({ number, acronym: `D${number}`, fullName: `Driver ${number}`, broadcastName: `D ${number}`, team: "Team", teamColour: "ffffff", headshotUrl: null })),
  grid: [],
  laps: [...lapsOf(1, 20, [6, 6, 8]), ...laps2],
  stints: [],
  pits: [],
  positions: [],
  intervals: [],
  trackStatus: [],
  raceControl: [],
  weather: [],
  radio: [],
  overtakes: [],
  results: [],
  track: { outline: { x: [0, 1, 1], y: [0, 0, 1], z: [0, 0, 0] }, pitLane: null, sectorMarks: [], bounds: { minX: 0, maxX: 1, minY: 0, maxY: 1 }, referenceLap: { driver: 0, lap: 0, duration: 0 }, rotation: 0, corners: [], marshalSectors: [], pitLoss: null },
} as unknown as SessionMeta;

const session = buildSession(meta, [car(1, () => 180), car(2, () => 150)]);

describe("race lap traces", () => {
  test("the lap length and sector boundaries are measured from the clean laps", () => {
    const g = lapGeometryOf(session);
    expect(g.lapLength).toBeCloseTo(LAP_M, 0);
    expect(g.sectorDistances[0]).toBeCloseTo(300, -1);
    expect(g.sectorDistances[1]).toBeCloseTo(600, -1);
  });

  test("a trace runs from the line to the line, the jittered start chained away", () => {
    const tr = lapTraceOf(session, 1, 3)!;
    expect(tr).not.toBeNull();
    expect(tr.t[0]).toBe(0);
    expect(tr.duration).toBe(20_000);
    expect(tr.d[0]).toBe(0);
    expect(tr.length).toBeCloseTo(LAP_M, 0);
    // Steady speed: distance is linear in time.
    expect(timeAtDistance(tr, 500)).toBeCloseTo(10_000, -1);
    expect(valueAtDistance(tr, "speed", 123)).toBeCloseTo(180, 0);
  });

  test("a slower lap is behind at the same distance", () => {
    const a = lapTraceOf(session, 1, 2)!;
    const b = lapTraceOf(session, 2, 2)!;
    // Car 2 loses 2 s by half distance and 4 s over the lap.
    expect(timeAtDistance(b, 500) - timeAtDistance(a, 500)).toBeCloseTo(2_000, -1);
    expect(timeAtDistance(b, LAP_M) - timeAtDistance(a, LAP_M)).toBeCloseTo(4_000, -1);
    expect(valueAtDistance(b, "speed", 800)).toBeCloseTo(150, 0);
  });

  test("the same lap is the same object, and a lap with no time has no trace", () => {
    expect(lapTraceOf(session, 1, 3)).toBe(lapTraceOf(session, 1, 3));
    expect(lapTraceOf(session, 1, 99)).toBeNull();
  });
});
