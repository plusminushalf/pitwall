import { describe, expect, test } from "bun:test";
// (Here, not next to it: widgets may only import widget-kit, and bun:test isn't that.)
import { labelOrder, stackOrder } from "../widgets/track-map/stacking";

// Dots 1-4, back to front; `near` lists the pairs that overlap.
const overlapping = (...near: [number, number][]) => (a: number, b: number) => near.some(([p, q]) => (p === a && q === b) || (p === b && q === a));
const none = overlapping();

describe("track map stacking", () => {
  test("the first frame, and dots apart: the running order", () => {
    expect(stackOrder(null, [4, 3, 2, 1], null, none, false)).toEqual({ order: [4, 3, 2, 1], holding: false });
    expect(stackOrder([4, 3, 2, 1], [4, 2, 3, 1], null, none, false)).toEqual({ order: [4, 2, 3, 1], holding: false });
  });

  test("two overlapping dots that swap places keep their stacking until they part", () => {
    const last = [4, 3, 2, 1];
    expect(stackOrder(last, [4, 2, 3, 1], null, overlapping([2, 3]), false)).toEqual({ order: [4, 3, 2, 1], holding: true });
    // Parted: the running order.
    expect(stackOrder(last, [4, 2, 3, 1], null, none, false)).toEqual({ order: [4, 2, 3, 1], holding: false });
    // Overlapping dots that don't swap don't hold anything.
    expect(stackOrder(last, [4, 3, 1, 2], null, overlapping([2, 3]), false).holding).toBe(false);
  });

  test("...or until it's been long enough", () => {
    expect(stackOrder([4, 3, 2, 1], [4, 2, 3, 1], null, overlapping([2, 3]), true)).toEqual({ order: [4, 2, 3, 1], holding: false });
  });

  test("the focused car is on top; a car that wasn't drawn goes where the running order puts it", () => {
    expect(stackOrder([4, 3, 2, 1], [4, 2, 3, 1], 3, overlapping([2, 3]), false)).toEqual({ order: [4, 2, 1, 3], holding: false });
    expect(stackOrder([4, 3, 1], [4, 2, 1, 3], null, overlapping([1, 3]), false)).toEqual({ order: [4, 2, 3, 1], holding: true });
  });
});

describe("track map label order", () => {
  test("focused first, then the cars labelled last frame, then the rest, each from the top of the stack", () => {
    const drawOrder = [5, 4, 3, 2, 1];
    expect(labelOrder(drawOrder, (n) => n === 4, (n) => n === 3 || n === 5)).toEqual([4, 3, 5, 1, 2]);
  });
});
