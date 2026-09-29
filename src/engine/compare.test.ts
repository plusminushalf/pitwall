import { describe, expect, test } from "bun:test";
import type { LapTrace } from "../types";
import { decodeLapTrace, deltaAt, deltaSeries, distanceAtTime, miniSectors, timeAtDistance, valueAtDistance } from "./compare";

/** A lap at constant speed (km/h) over `metres`, sampled every `stepMs`. */
function constantLap(lap: number, kmh: number, metres = 1000, stepMs = 250): LapTrace {
  const duration = Math.round((metres / (kmh / 3.6)) * 1000);
  const ts: number[] = [];
  for (let t = 0; t < duration; t += stepMs) ts.push(t);
  ts.push(duration);
  const ds = ts.map((t) => Math.round(((kmh / 3.6) * t) / 100)); // decimetres
  ds[ds.length - 1] = metres * 10;
  const enc = (xs: number[]) => xs.map((x, i) => (i ? x - xs[i - 1] : x));
  return {
    lap,
    t: enc(ts),
    d: enc(ds),
    speed: ts.map(() => kmh),
    throttle: ts.map(() => 100),
    brake: ts.map(() => 0),
    gear: ts.map(() => 7),
    x: ds,
    y: ds.map(() => 0),
  };
}

describe("lap comparison", () => {
  const fast = decodeLapTrace(1, constantLap(1, 360)); // 100 m/s: 10 s
  const slow = decodeLapTrace(2, constantLap(2, 180)); // 50 m/s: 20 s

  test("decodes delta-encoded time and distance", () => {
    expect(fast.duration).toBe(10_000);
    expect(fast.length).toBe(1000);
    expect(timeAtDistance(fast, 500)).toBeCloseTo(5_000, 0);
    expect(distanceAtTime(slow, 10_000)).toBeCloseTo(500, 0);
    expect(valueAtDistance(fast, "gear", 400)).toBe(7);
  });

  test("delta grows with distance and ends at the lap-time difference", () => {
    const s = deltaSeries(fast, slow, 10);
    expect(s.d[s.d.length - 1]).toBe(1000);
    expect(s.delta[s.delta.length - 1]).toBeCloseTo(10, 3);
    expect(deltaAt(fast, slow, 250)).toBeCloseTo(2.5, 2);
    for (let i = 1; i < s.delta.length; i++) expect(s.delta[i]).toBeGreaterThanOrEqual(s.delta[i - 1] - 1e-9);
  });

  test("mini-sectors go to the faster lap", () => {
    const ms = miniSectors([slow, fast], 5);
    expect(ms).toHaveLength(5);
    expect(ms.every((m) => m.winner === 1)).toBe(true);
    expect(ms[0].times[0]).toBeCloseTo(4, 2);
  });
});
