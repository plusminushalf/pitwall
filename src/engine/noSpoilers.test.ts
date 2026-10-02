import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import type { Lap, SessionMeta } from "../types";
import { projectedEnd, spoilerFreeEnd } from "./noSpoilers";

type Meta = Parameters<typeof projectedEnd>[0];

const lap = (duration: number | null): Lap => ({
  driver: 1,
  lap: 1,
  start: 0,
  end: null,
  duration,
  sectors: [null, null, null],
  segments: [[], [], []],
  speedTrap: { i1: null, i2: null, st: null },
  pitOut: false,
});

// Suzuka: 53 laps scheduled.
const race = (over: Partial<Meta>): Meta => ({
  circuit: "Suzuka",
  sessionName: "Race",
  totalLaps: 53,
  laps: [90, 91, 140, null].map(lap),
  lightsOut: 300_000,
  chequered: 5_200_000,
  duration: 5_380_000,
  ...over,
});

describe("no-spoiler timeline length", () => {
  test("the scheduled distance at the median lap time, with a margin and the cool-down", () => {
    expect(projectedEnd(race({}))).toBe(Math.round(300_000 + 53 * 91_000 * 1.05 + 180_000));
  });

  test("a race cut short is still projected over its scheduled distance", () => {
    expect(projectedEnd(race({ totalLaps: 30 }))).toBe(projectedEnd(race({})));
  });

  test("racing time is capped at the 2-hour limit", () => {
    expect(projectedEnd(race({ laps: [200].map(lap) }))).toBe(300_000 + 7_200_000 + 180_000);
  });

  test("the projection until the flag, growing once watched past it, then the real end", () => {
    const meta = race({ chequered: 9_000_000, duration: 9_180_000 }); // a long red flag
    const projected = projectedEnd(meta);
    expect(spoilerFreeEnd(meta, 0)).toBe(projected);
    expect(spoilerFreeEnd(meta, projected + 60_000)).toBe(projected + 60_000);
    expect(spoilerFreeEnd(meta, 9_000_000)).toBe(9_180_000);
  });

  test("practice runs to the clock: the scheduled end and the cool-down, whatever the laps", () => {
    const fp = race({ practice: { scheduledEnd: 3_660_000 }, lightsOut: 60_000, chequered: 3_660_000, duration: 3_900_000, laps: [80, 130].map(lap) });
    expect(projectedEnd(fp)).toBe(3_660_000 + 180_000);
    expect(spoilerFreeEnd(fp, 3_659_999)).toBe(3_840_000);
    expect(spoilerFreeEnd(fp, 3_660_000)).toBe(3_900_000);
  });

  test("a race that ends before the projection only shows its real end at the flag", () => {
    const meta = race({});
    expect(spoilerFreeEnd(meta, 5_199_999)).toBe(projectedEnd(meta));
    expect(spoilerFreeEnd(meta, 5_200_000)).toBe(5_380_000);
  });
});

// Against a real race (run `bun run ingest 11377` first): the flag falls inside the projected bar.
const dir = new URL("../../data/sessions/11377/", import.meta.url).pathname;
const available = existsSync(`${dir}meta.json`);

describe.skipIf(!available)("session 11377", () => {
  const meta: SessionMeta = available ? JSON.parse(readFileSync(`${dir}meta.json`, "utf8")) : (null as unknown as SessionMeta);

  test("the projection ends after the flag, but not long after", () => {
    const projected = projectedEnd(meta);
    expect(projected).toBeGreaterThan(meta.chequered!);
    expect(projected - meta.duration).toBeLessThan(10 * 60_000);
  });
});
