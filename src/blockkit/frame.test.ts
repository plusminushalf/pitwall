// The useFrame scheduler: exact clock time, off-screen blocks skipped, slow or broken blocks isolated
// (a block is slow when its recent draws typically are, not after one slow draw).

import { afterEach, describe, expect, spyOn, test, type Mock } from "bun:test";
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
// A fake performance.now(): a draw "takes" whatever it adds to it.
let now = 0;
let clockSpy: Mock<() => number> | null = null;
const fakeClock = () => {
  now = 0;
  clockSpy = spyOn(performance, "now").mockImplementation(() => now);
};
const busy = (ms: number) => {
  now += ms;
};
/** Runs `frames` frames; returns the (1-based) frames block i drew in. */
const drawsOver = (frames: number, costs: ((frame: number) => number)[]) => {
  const drew: number[][] = costs.map(() => []);
  let frame = 0;
  costs.forEach((cost, i) =>
    add(() => {
      drew[i].push(frame);
      busy(cost(frame));
    }),
  );
  for (frame = 1; frame <= frames; frame++) runFrames();
  return drew;
};
const gaps = (frames: number[]) => frames.slice(1).map((f, i) => f - frames[i]);

afterEach(() => {
  offs.splice(0).forEach((off) => off());
  useReplay.setState({ session: null });
  clockSpy?.mockRestore();
  clockSpy = null;
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

  test("one slow draw skips nothing", () => {
    useReplay.setState({ session });
    fakeClock();
    // A 100 ms draw (a GC pause, say) in frame 4 of an otherwise fast block.
    const [drew] = drawsOver(12, [(f) => (f === 4 ? 100 : 0.5)]);
    expect(drew).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  test("a block slow draw after draw skips frames in proportion, the others draw every frame", () => {
    useReplay.setState({ session });
    fakeClock();
    const [slow, fast] = drawsOver(30, [() => FRAME_BUDGET_MS * 2.5, () => 0.5]);
    // Typically 10 ms from its third draw on: each draw then skips the next 2 frames.
    expect(slow.slice(0, 3)).toEqual([1, 2, 3]);
    expect(new Set(gaps(slow.slice(2)))).toEqual(new Set([3]));
    expect(fast.length).toBe(30);
  });

  test("a very slow block still draws every 21st frame", () => {
    useReplay.setState({ session });
    fakeClock();
    const [slow, fast] = drawsOver(100, [() => 1_000, () => 0.5]);
    expect(new Set(gaps(slow.slice(2)))).toEqual(new Set([21]));
    expect(fast.length).toBe(100);
  });

  test("a block that gets fast again draws every frame after a few draws", () => {
    useReplay.setState({ session });
    fakeClock();
    const [drew] = drawsOver(60, [(f) => (f <= 20 ? FRAME_BUDGET_MS * 3 : 0.5)]);
    const late = drew.filter((f) => f > 40);
    expect(late).toEqual(Array.from({ length: 20 }, (_, i) => 41 + i));
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

  test("a block that throws is retried about once a second", () => {
    useReplay.setState({ session });
    const error = spyOn(console, "error").mockImplementation(() => {});
    const tried: number[] = [];
    let frame = 0;
    add(() => {
      tried.push(frame);
      throw new Error("broken block");
    });
    for (frame = 1; frame <= 130; frame++) runFrames();
    expect(tried).toEqual([1, 62, 123]);
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
