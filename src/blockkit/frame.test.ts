// The useFrame scheduler: exact clock time, off-screen blocks skipped, slow or broken blocks isolated.

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { DriverData, Session } from "../data/session";
import { clock, useReplay } from "../store";
import { addFrameCallback, FRAME_BUDGET_MS, runFrames, type Frame } from "./frame";

// One car at x = t / 10 along a straight line.
const car = {
  loc: { t: Float64Array.from([0, 1_000, 2_000, 3_000]), x: Float32Array.from([0, 100, 200, 300]), y: new Float32Array(4) },
  result: null,
} as unknown as DriverData;
const session = { drivers: new Map([[7, car]]) } as unknown as Session;

const offs: (() => void)[] = [];
const add = (draw: (f: Frame) => void, visible?: () => boolean) => offs.push(addFrameCallback({ current: draw }, visible));
const busy = (ms: number) => {
  const end = performance.now() + ms;
  while (performance.now() < end);
};

afterEach(() => {
  offs.splice(0).forEach((off) => off());
  useReplay.setState({ session: null });
});

describe("frame scheduler", () => {
  test("nothing is drawn without a session", () => {
    let calls = 0;
    add(() => calls++);
    runFrames();
    expect(calls).toBe(0);
  });

  test("draws get the exact clock time and car positions", () => {
    useReplay.setState({ session });
    clock.t = 1_500;
    const seen: [number, number | undefined][] = [];
    add((f) => seen.push([f.t, f.car(7)?.x]));
    runFrames();
    expect(seen).toEqual([[1_500, 150]]);
    expect(seen.length).toBe(1);
  });

  test("off-screen blocks aren't drawn", () => {
    useReplay.setState({ session });
    let visible = false;
    let calls = 0;
    add(() => calls++, () => visible);
    runFrames();
    visible = true;
    runFrames();
    expect(calls).toBe(1);
  });

  test("a slow block drops its own frames; the others draw every frame", () => {
    useReplay.setState({ session });
    let slow = 0;
    let fast = 0;
    add(() => {
      slow++;
      busy(FRAME_BUDGET_MS * 2.5); // skips the next 2 frames
    });
    add(() => fast++);
    for (let i = 0; i < 6; i++) runFrames();
    expect(fast).toBe(6);
    expect(slow).toBe(2);
  });

  test("a block that throws doesn't stop the others", () => {
    useReplay.setState({ session });
    const error = spyOn(console, "error").mockImplementation(() => {});
    let calls = 0;
    add(() => {
      throw new Error("broken block");
    });
    add(() => calls++);
    runFrames();
    runFrames();
    expect(calls).toBe(2);
    expect(error).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });

  test("blocks share one car position per frame", () => {
    useReplay.setState({ session });
    const got: unknown[] = [];
    add((f) => got.push(f.car(7)));
    add((f) => got.push(f.car(7)));
    add((f) => got.push(f.car(99)));
    runFrames();
    expect(got[0]).toBe(got[1]);
    expect(got[2]).toBeNull();
  });
});
