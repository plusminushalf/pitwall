// Selectors run on the hooks' spoiler-free values: whatever a widget picks, nothing after t reaches it.

import { describe, expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import { buildSession } from "../data/session";
import { raceStateAt } from "../engine/raceState";
import { clock, useReplay } from "../store";
import type { DriverTelemetry, Lap, SessionMeta } from "../types";
import { useCarHistory, useDriver, useFeed, useLaps, useStints, useWholeSession } from "./hooks";

const T = 45_000;
const secs = (n: number) => Array.from({ length: n }, (_, i) => i);
const lap = (n: number): Lap => ({
  driver: 1,
  lap: n,
  start: (n - 1) * 20_000,
  end: n * 20_000,
  duration: 20,
  sectors: [6, 7, 7],
  segments: [[], [], []],
  speedTrap: { i1: null, i2: null, st: null },
  pitOut: false,
});

// One car, five 20 s laps, a stop after lap 3, a race control message every 10 s, telemetry every second.
const meta = {
  sessionKey: 7,
  meetingName: "Test",
  sessionName: "Race",
  year: 2026,
  circuit: "Test",
  country: "Test",
  gmtOffset: "00:00:00",
  t0: "2026-01-01T00:00:00Z",
  duration: 100_000,
  lightsOut: 0,
  totalLaps: 5,
  drivers: [{ number: 1, acronym: "ONE", fullName: "Driver One", broadcastName: "D ONE", team: "Team", teamColour: "ffffff", headshotUrl: null }],
  grid: [{ driver: 1, position: 1 }],
  laps: [1, 2, 3, 4, 5].map(lap),
  stints: [
    { driver: 1, stint: 1, lapStart: 1, lapEnd: 3, compound: "SOFT", ageAtStart: 0 },
    { driver: 1, stint: 2, lapStart: 4, lapEnd: 5, compound: "HARD", ageAtStart: 0 },
  ],
  pits: [],
  positions: [],
  intervals: [],
  trackStatus: [],
  raceControl: secs(10).map((i) => ({ t: (i + 1) * 10_000, lap: null, category: "Other", flag: null, scope: null, sector: null, driver: null, message: `M${i}` })),
  weather: [],
  radio: [],
  overtakes: [],
  results: [],
  track: { outline: { x: [0, 1, 1], y: [0, 0, 1], z: [0, 0, 0] }, pitLane: null, sectorMarks: [], bounds: { minX: 0, maxX: 1, minY: 0, maxY: 1 }, referenceLap: { driver: 0, lap: 0, duration: 0 }, rotation: 0, corners: [], marshalSectors: [], pitLoss: null },
} as unknown as SessionMeta;

const ones = (n: number) => secs(n).map(() => 1);
const telemetry: DriverTelemetry[] = [
  { driver: 1, loc: { t: [0, ...ones(99).map(() => 1000)], x: ones(100), y: ones(100), z: ones(100) }, car: { t: [0, ...ones(99).map(() => 1000)], speed: ones(100), rpm: ones(100), gear: ones(100), throttle: ones(100), brake: ones(100) } },
];

describe("hook selectors see only data up to t", () => {
  const session = buildSession(meta, telemetry);
  clock.t = T;
  useReplay.setState({ session, race: raceStateAt(session, T), t: T });

  const seen: Record<string, unknown> = {};
  function Probe() {
    // Each selector hands back everything it's given, as a widget trying to peek would.
    seen.laps = useLaps(1, (laps) => laps.map((l) => l.end));
    seen.stints = useStints(1, (stints) => stints.map((s) => [s.stint, s.lapEnd]));
    seen.feed = useFeed((feed) => feed.map((f) => f.t));
    seen.history = useCarHistory(1, 1e9, (h) => Array.from(h.t));
    seen.driver = useDriver(1, (d) => [d.lap, d.lastLap?.end, d.bestLap?.end]);
    seen.whole = useWholeSession((w) => w.meta.laps.length);
    return null;
  }
  renderToString(<Probe />);

  test("laps, feed and telemetry stop at t", () => {
    expect(seen.laps).toEqual([20_000, 40_000]);
    expect((seen.feed as number[]).every((t) => t <= T)).toBe(true);
    expect((seen.feed as number[]).length).toBe(4);
    expect(Math.max(...(seen.history as number[]))).toBeLessThanOrEqual(T);
    expect((seen.driver as unknown[])[1]).toBe(40_000);
  });

  test("the next stint doesn't show, and the current one is cut at the current lap", () => {
    expect(seen.stints).toEqual([[1, 3]]);
  });

  test("only useWholeSession sees the future", () => {
    expect(seen.whole).toBe(5);
  });
});
