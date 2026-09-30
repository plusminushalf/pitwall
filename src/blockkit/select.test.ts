// The block hooks' data at t: nothing after t, and today's selected-driver rule.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { buildSession, type CarSeries, type DriverData, type Session } from "../data/session";
import { driverStateAt, raceStateAt } from "../engine/raceState";
import type { DriverTelemetry, Lap, SessionMeta, Stint } from "../types";
import { feedEndAt, feedUpTo, historyRange, historySlice, lapsAt, selectedDriverOf, stintsAt, trackOf } from "./select";

const lap = (n: number, start: number, end: number | null): Lap => ({
  driver: 1,
  lap: n,
  start,
  end,
  duration: end == null ? null : (end - start) / 1000,
  sectors: [null, null, null],
  segments: [[], [], []],
  speedTrap: { i1: null, i2: null, st: null },
  pitOut: false,
});

const stint = (n: number, lapStart: number, lapEnd: number, compound: string): Stint => ({ driver: 1, stint: n, lapStart, lapEnd, compound, ageAtStart: 0 });

// Laps of 100 s from t = 1000; a stop after lap 3 (stint 2 from lap 4), another after lap 6.
const laps = [1, 2, 3, 4, 5, 6, 7].map((n) => lap(n, 1_000 + (n - 1) * 100_000, 1_000 + n * 100_000));
const driver = {
  laps,
  lapStarts: Float64Array.from(laps, (l) => l.start),
  stints: [stint(1, 1, 3, "SOFT"), stint(2, 4, 6, "HARD"), stint(3, 7, 7, "MEDIUM")],
} as unknown as DriverData;

describe("laps", () => {
  test("only completed laps, none in progress", () => {
    expect(lapsAt(driver, 0)).toEqual([]);
    expect(lapsAt(driver, 150_000).map((l) => l.lap)).toEqual([1]);
    expect(lapsAt(driver, 101_000).map((l) => l.lap)).toEqual([1]); // lap 1 ends exactly at t
    expect(lapsAt(driver, 350_000).map((l) => l.lap)).toEqual([1, 2, 3]);
  });

  test("a lap without an end isn't complete", () => {
    const d = { laps: [lap(1, 0, 50_000), lap(2, 50_000, null)] } as unknown as DriverData;
    expect(lapsAt(d, 1e9).map((l) => l.lap)).toEqual([1]);
  });
});

describe("stints", () => {
  test("only stints started by the current lap, the current one open and cut at that lap", () => {
    expect(stintsAt(driver, 0)).toEqual([{ ...driver.stints[0], lapEnd: 1, open: true }]);
    expect(stintsAt(driver, 2)).toEqual([{ ...driver.stints[0], lapEnd: 2, open: true }]);
    expect(stintsAt(driver, 5)).toEqual([
      { ...driver.stints[0], open: false },
      { ...driver.stints[1], lapEnd: 5, open: true },
    ]);
    expect(stintsAt(driver, 7).map((s) => [s.stint, s.lapEnd, s.open])).toEqual([
      [1, 3, false],
      [2, 6, false],
      [3, 7, true],
    ]);
  });

  test("nothing past the current lap leaks, even from bad data", () => {
    const d = { stints: [stint(1, 1, 9, "SOFT"), stint(2, 3, 9, "HARD")] } as unknown as DriverData;
    expect(Math.max(...stintsAt(d, 4).map((s) => s.lapEnd))).toBe(4);
  });
});

describe("car history", () => {
  const ts = [0, 250, 500, 750, 1_000, 1_250, 1_500];
  const car: CarSeries = {
    t: Float64Array.from(ts),
    speed: Float32Array.from(ts, (t) => t / 10),
    rpm: Float32Array.from(ts),
    gear: Uint8Array.from(ts, () => 5),
    throttle: Float32Array.from(ts, () => 100),
    brake: Float32Array.from(ts, () => 0),
    drs: null,
  };

  test("samples in [t - window, t] only", () => {
    const { from, to } = historyRange(car, 1_100, 600);
    expect(Array.from(historySlice(car, from, to).t)).toEqual([500, 750, 1_000]);
    const edge = historyRange(car, 1_000, 500);
    expect(Array.from(historySlice(car, edge.from, edge.to).t)).toEqual([500, 750, 1_000]);
    const before = historyRange(car, -10, 1_000);
    expect(historySlice(car, before.from, before.to).t.length).toBe(0);
  });

  test("copies: the future isn't reachable through the buffer", () => {
    const { from, to } = historyRange(car, 600, 1_000);
    const h = historySlice(car, from, to);
    expect(new Float64Array(h.t.buffer).length).toBe(3);
    expect(Array.from(h.speed)).toEqual([0, 25, 50]);
  });
});

describe("selected driver", () => {
  const order = [16, 1, 44, 63, 4];

  test("the leader when nothing is selected", () => {
    expect(selectedDriverOf(order, [], null, null)).toBe(16);
  });

  test("the best-placed selected driver, whatever the order they were picked in", () => {
    expect(selectedDriverOf(order, [63, 44], null, null)).toBe(44);
  });

  test("the focused driver beats the selection", () => {
    expect(selectedDriverOf(order, [44, 4], 4, null)).toBe(4);
    expect(selectedDriverOf(order, [], 63, null)).toBe(63);
  });

  test("a pinned driver beats everything; one not in the session is ignored", () => {
    expect(selectedDriverOf(order, [44], 4, 1)).toBe(1);
    expect(selectedDriverOf(order, [44], 4, 99)).toBe(4);
    expect(selectedDriverOf(order, [99], 98, null)).toBe(16);
  });

  test("no drivers, no driver", () => {
    expect(selectedDriverOf([], [], null, null)).toBeNull();
  });
});

// Against the real 2026 Azerbaijan GP (run `bun run ingest 11377` first).
const dir = new URL("../../data/sessions/11377/", import.meta.url).pathname;
const available = existsSync(`${dir}meta.json`);

function load(): Session {
  const meta: SessionMeta = JSON.parse(readFileSync(`${dir}meta.json`, "utf8"));
  const telemetry: DriverTelemetry[] = meta.drivers.map((d) => JSON.parse(readFileSync(`${dir}drivers/${d.number}.json`, "utf8")));
  return buildSession(meta, telemetry);
}

describe.skipIf(!available)("Baku 2026 at t", () => {
  const s = available ? load() : (null as unknown as Session);
  const times = [s?.meta.lightsOut - 5_000, s?.lapStartTimes[20] + 30_000, s?.lapStartTimes[40]];

  test("laps, stints and feed stop at t", () => {
    for (const t of times) {
      for (const d of s.drivers.values()) {
        expect(lapsAt(d, t).every((l) => l.end! <= t)).toBe(true);
        const state = driverStateAt(d, t);
        const stints = stintsAt(d, state.lap);
        expect(stints.every((st) => st.lapStart <= Math.max(state.lap, 1) && st.lapEnd <= Math.max(state.lap, 1))).toBe(true);
        // The open stint is the one the tyre badge shows.
        if (stints.length > 0) expect(stints.at(-1)!.stint).toBe(state.stint!);
      }
      expect(feedUpTo(s, feedEndAt(s, t)).every((f) => f.t <= t)).toBe(true);
    }
  });

  test("SAI's second stint only shows once he's pitted", () => {
    const pit = s.meta.pits.find((p) => p.driver === 55 && p.lap === 20)!;
    const sai = s.drivers.get(55)!;
    expect(stintsAt(sai, driverStateAt(sai, pit.entry - 5_000).lap).map((x) => x.stint)).toEqual([1]);
    expect(stintsAt(sai, driverStateAt(sai, pit.exit + 5_000).lap).map((x) => x.stint)).toEqual([1, 2]);
  });

  test("the feed at the end includes post-race stewards' decisions", () => {
    expect(feedUpTo(s, feedEndAt(s, s.meta.duration)).some((f) => f.kind === "stewards" && f.t > s.meta.duration)).toBe(true);
  });

  test("the selected driver follows the running order", () => {
    const race = raceStateAt(s, s.lapStartTimes[20]);
    const order = race.drivers.map((d) => d.driver);
    expect(selectedDriverOf(order, [], null, null)).toBe(race.drivers[0].driver);
    expect(selectedDriverOf(order, [order[5], order[2]], null, null)).toBe(order[2]);
  });

  test("the track leaves out the race's reference lap", () => {
    expect("referenceLap" in trackOf(s.meta.track)).toBe(false);
    expect(trackOf(s.meta.track).outline).toBe(s.meta.track.outline);
  });
});
