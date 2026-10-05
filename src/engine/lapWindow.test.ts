import { describe, expect, test } from "bun:test";
import { lapEdges, lapWindowIn, nearestEdge } from "./lapWindow";

describe("lapWindowIn", () => {
  test("nothing picked: the whole race", () => {
    expect(lapWindowIn(null, 57)).toEqual({ from: 1, to: 57, zoomed: false });
  });

  test("a window inside the race", () => {
    expect(lapWindowIn([12, 30], 57)).toEqual({ from: 12, to: 30, zoomed: true });
  });

  test("cut to the race (a link from a longer race), at least two laps wide", () => {
    expect(lapWindowIn([40, 70], 57)).toEqual({ from: 40, to: 57, zoomed: true });
    expect(lapWindowIn([60, 70], 57)).toEqual({ from: 56, to: 57, zoomed: true });
  });

  test("the whole race picked isn't zoomed", () => {
    expect(lapWindowIn([1, 57], 57).zoomed).toBe(false);
  });
});

describe("lapEdges", () => {
  // Lap n starts at n * 100 (index 0 unused); the flag at 400.
  const starts = [undefined, 100, 200, 300];

  test("every lap run: its starts, then the flag", () => {
    expect(lapEdges(starts, 3, 90, 400, Infinity)).toEqual([100, 200, 300, 400]);
  });

  test("laps not run yet go on at the average lap", () => {
    expect(lapEdges(starts, 5, 90, null, Infinity)).toEqual([100, 200, 300, 400, 500, 600]);
  });

  test("no spoilers: laps past what's been watched are placed, not read", () => {
    expect(lapEdges([undefined, 100, 200, 330], 3, 90, 400, 250)).toEqual([100, 200, 300, 400]);
  });

  test("before the start: from lights out at a typical lap", () => {
    expect(lapEdges([], 2, 90, null, Infinity)).toEqual([90, 95_090, 190_090]);
  });
});

test("nearestEdge", () => {
  expect(nearestEdge([100, 200, 300], 240)).toBe(1);
  expect(nearestEdge([100, 200, 300], 260)).toBe(2);
  expect(nearestEdge([100, 200, 300], -5)).toBe(0);
});
