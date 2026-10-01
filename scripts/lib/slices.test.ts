import { describe, expect, test } from "bun:test";
import { FIRST_SLICE_UNITS, parseSliceFile, sliceFile, SLICE_MAX_UNITS, SLICE_UNIT_MS, SlicePlan, telemetrySpan, type SlicePart } from "./slices";

const U = SLICE_UNIT_MS;
const T = Date.parse("2026-09-26T10:50:00Z");
const span = { from: T, to: T + 24 * U }; // 2 hours
const units = (parts: SlicePart[]) => parts.map((p) => `${p.endpoint}:${(p.span.from - T) / U}-${(p.span.to - T) / U}`);

describe("slice files", () => {
  test("names round-trip; whole-session files aren't slices", () => {
    const part: SlicePart = { endpoint: "location", span: { from: T, to: T + U } };
    expect(sliceFile(part)).toBe(`location_${T / 1000}_${(T + U) / 1000}`);
    expect(parseSliceFile(sliceFile(part))).toEqual(part);
    expect(parseSliceFile("car_data_44")).toBeNull();
    expect(parseSliceFile("laps")).toBeNull();
  });

  test("the span: the replay window and a margin, out to the grid", () => {
    const s = telemetrySpan({ t0: T + 9 * 60_000 + 30_000, end: T + 117 * 60_000 });
    expect(s).toEqual({ from: T, to: T + 125 * 60_000 });
  });
});

describe("slice plan", () => {
  test("a short slice at a playhead that's waiting, then long ones forward, then backwards from it", () => {
    const p = new SlicePlan(span);
    const at = T + 2 * U + 30_000;
    expect(units(p.next(at))).toEqual([`location:2-${2 + FIRST_SLICE_UNITS}`, `car_data:2-${2 + FIRST_SLICE_UNITS}`]);
    expect(units(p.next(at))).toEqual([`location:3-${3 + SLICE_MAX_UNITS}`, `car_data:3-${3 + SLICE_MAX_UNITS}`]);
    // Everything ahead taken: the units before the playhead, nearest first.
    const back = new SlicePlan(span);
    back.next(T + 23 * U);
    expect(units(back.next(T + 23 * U))).toEqual([`location:17-23`, `car_data:17-23`]);
  });

  test("a playhead just before a grid line: the first slice takes the next unit too", () => {
    const p = new SlicePlan(span);
    expect(units(p.next(T + 3 * U - 30_000))).toEqual(["location:2-4", "car_data:2-4"]);
  });

  test("a playhead in a stored stretch: the next missing one after it, full length", () => {
    const stored: SlicePart[] = ["location", "car_data"].map((endpoint) => ({ endpoint, span: { from: T, to: T + 4 * U } }) as SlicePart);
    const p = new SlicePlan(span, stored);
    expect(p.complete()).toEqual([{ from: T, to: T + 4 * U }]);
    expect(units(p.next(T + U))).toEqual([`location:4-${4 + SLICE_MAX_UNITS}`, `car_data:4-${4 + SLICE_MAX_UNITS}`]);
  });

  test("each endpoint fetches only what it's missing; complete spans need both", () => {
    const p = new SlicePlan(span, [{ endpoint: "location", span: { from: T + 4 * U, to: T + 6 * U } }]);
    expect(units(p.next(T + 4 * U))).toEqual(["car_data:4-5"]);
    p.stored({ endpoint: "car_data", span: { from: T + 4 * U, to: T + 5 * U } });
    expect(p.complete()).toEqual([{ from: T + 4 * U, to: T + 5 * U }]);
  });

  test("a failed part is missing again; done once everything is stored", () => {
    const p = new SlicePlan({ from: T, to: T + 2 * U });
    const [loc, car] = p.next(T);
    p.release(loc!);
    expect(units(p.next(T))).toEqual(["location:0-1"]);
    for (const part of [loc!, car!]) p.stored(part);
    expect(p.done()).toBe(false);
    const rest = p.next(T);
    for (const part of rest) p.stored(part);
    expect(p.done()).toBe(true);
    expect(p.progress()).toBe(1);
    expect(p.next(T)).toEqual([]);
  });
});
