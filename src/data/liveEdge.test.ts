import { describe, expect, test } from "bun:test";
import { FOLLOW_BUFFER_MS, followStep, LiveEdge } from "./liveEdge";

describe("LiveEdge", () => {
  test("measures how fast the edge moves and extrapolates between updates", () => {
    const e = new LiveEdge();
    e.update(60_000, 1_000, true);
    expect(e.rate).toBe(1); // not enough history yet
    // A 10x simulation: +5 s of session time every 0.5 s.
    for (let i = 1; i <= 6; i++) e.update(60_000 + i * 5_000, 1_000 + i * 500);
    expect(e.rate).toBeCloseTo(10, 5);
    expect(e.at(4_000 + 250)).toBeCloseTo(90_000 + 2_500, 5);
    // No updates for a while: stops extrapolating after 2 s of wall time.
    expect(e.at(4_000 + 60_000)).toBeCloseTo(90_000 + 20_000, 5);
    expect(e.buffer()).toBeCloseTo(FOLLOW_BUFFER_MS * 10, 5);
    expect(e.target(4_000)).toBeCloseTo(90_000 - 30_000, 5);
    expect(e.target(4_000, true)).toBe(90_000); // ended: the very end
  });

  test("real-time edge: follows ~3 s behind", () => {
    const e = new LiveEdge();
    for (let i = 0; i <= 10; i++) e.update(100_000 + i * 500, i * 500, i === 0);
    expect(e.rate).toBeCloseTo(1, 5);
    expect(e.target(5_000)).toBeCloseTo(105_000 - FOLLOW_BUFFER_MS, 5);
  });

  test("an edge that arrives late every few messages doesn't skew the rate or pull the edge back", () => {
    const e = new LiveEdge();
    // Every 4th message was computed 700 ms before it was sent (10x: 7 s of session time old).
    for (let i = 0; i <= 40; i++) {
      const wall = i * 500;
      e.update(wall * 10 - (i % 4 === 3 ? 7_000 : 0), wall, i === 0);
    }
    expect(e.rate).toBeGreaterThan(9.5);
    expect(e.rate).toBeLessThan(10.5);
    expect(e.at(20_000)).toBeGreaterThanOrEqual(200_000 - 1_000);
  });

  test("restart forgets old samples (reconnect) but keeps the rate until measured again", () => {
    const e = new LiveEdge();
    for (let i = 0; i <= 4; i++) e.update(i * 5_000, i * 500, i === 0);
    expect(e.rate).toBeCloseTo(10, 5);
    e.update(500_000, 100_000, true);
    expect(e.rate).toBeCloseTo(10, 5);
    expect(e.at(100_000)).toBe(500_000);
  });
});

describe("followStep", () => {
  test("eases onto a moving target without overshooting it", () => {
    let t = 10_000;
    let target = 12_000;
    for (let i = 0; i < 600; i++) {
      target += 16;
      t = followStep(t, target, 16, 1, Infinity);
      expect(t).toBeLessThanOrEqual(target);
    }
    expect(target - t).toBeLessThan(50);
  });

  test("jumps when far off, never steps backwards, respects the limit", () => {
    expect(followStep(0, 60_000, 16, 1, Infinity)).toBe(60_000);
    const ahead = followStep(10_000, 9_500, 16, 1, Infinity);
    expect(ahead).toBeGreaterThan(10_000); // slows down instead of stepping back
    expect(ahead).toBeLessThan(10_016);
    expect(followStep(10_000, 8_000, 16, 1, Infinity)).toBe(10_000); // well ahead: waits
    expect(followStep(10_000, 10_500, 16, 1, 10_005)).toBe(10_005);
  });
});
