// The useFrame scheduler: exact clock time and the frame's wall-clock time, off-screen blocks skipped, slow
// or broken blocks isolated (a block is slow when its recent draws typically are, not after one slow draw).

import { afterEach, describe, expect, spyOn, test, type Mock } from "bun:test";
import type { DriverData, Session } from "../data/session";
import { clock, useReplay } from "../store";
import { addFrameCallback, FRAME_BUDGET_MS, runFrames, type Frame } from "./frame";

// One car at x = t / 10 along a straight line, in the pit lane from 2.6 to 2.8 s.
const car = {
  loc: { t: Float64Array.from([0, 1_000, 2_000, 3_000]), x: Float32Array.from([0, 100, 200, 300]), y: new Float32Array(4) },
  pits: [{ driver: 7, lap: 1, entry: 2_600, exit: 2_800, laneDuration: 0.2, stopDuration: null }],
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
  for (frame = 1; frame <= frames; frame++) runFrames(frame * 16.7);
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
    runFrames(0);
    expect(calls).toBe(0);
  });

  test("draws get the exact clock time and car positions", () => {
    useReplay.setState({ session });
    clock.t = 1_500;
    const seen: [number, number | undefined][] = [];
    add((f) => seen.push([f.t, f.car(7)?.x]));
    runFrames(0);
    expect(seen).toEqual([[1_500, 150]]);
    expect(seen.length).toBe(1);
  });

  test("cars say when they're in the pit lane (entry and exit included), and on its trace (2 s more each side)", () => {
    useReplay.setState({ session });
    const pit: [number, boolean | undefined, boolean | undefined][] = [];
    let t = 0;
    add((f) => pit.push([t, f.car(7)?.pit, f.car(7)?.pitLane]));
    for (t of [599, 600, 2_599, 2_600, 2_700, 2_800, 2_801]) {
      clock.t = t;
      runFrames(t);
    }
    expect(pit).toEqual([
      [599, false, false],
      [600, false, true],
      [2_599, false, true],
      [2_600, true, true],
      [2_700, true, true],
      [2_800, true, true],
      [2_801, false, true],
    ]);
  });

  test("draws get the frame's wall-clock time, whatever the replay clock does", () => {
    useReplay.setState({ session });
    clock.t = 1_500;
    const seen: [number, number][] = [];
    add((f) => seen.push([f.t, f.now]));
    add((f) => seen.push([f.t, f.now]));
    runFrames(10_016.5);
    runFrames(10_033.2); // paused: same replay time, later frame
    expect(seen).toEqual([
      [1_500, 10_016.5],
      [1_500, 10_016.5],
      [1_500, 10_033.2],
      [1_500, 10_033.2],
    ]);
  });

  test("off-screen blocks aren't drawn", () => {
    useReplay.setState({ session });
    let visible = false;
    let calls = 0;
    add(() => calls++, () => visible);
    runFrames(0);
    visible = true;
    runFrames(16.7);
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
    runFrames(0);
    runFrames(16.7);
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
    for (frame = 1; frame <= 130; frame++) runFrames(frame * 16.7);
    expect(tried).toEqual([1, 62, 123]);
    error.mockRestore();
  });

  test("blocks share one car position per frame", () => {
    useReplay.setState({ session });
    const got: unknown[] = [];
    add((f) => got.push(f.car(7)));
    add((f) => got.push(f.car(7)));
    add((f) => got.push(f.car(99)));
    runFrames(0);
    expect(got[0]).toBe(got[1]);
    expect(got[2]).toBeNull();
  });
});
