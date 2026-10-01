import { describe, expect, test } from "bun:test";
import type { BlockDefinition, HeightInput } from "../blockkit/defineBlock";
import type { Track } from "../blockkit/select";
import type { DriverInfo } from "../types";
import { BUILTIN_BLOCKS } from "./builtins";
import { DEFAULT_LAYOUT } from "./defaultLayout";
import { boxesOf, COLUMNS, columnRange, DIVIDER, pack, type GridInput, type Layout, type Placement } from "./layout";

const block = (id: string, height: BlockDefinition["height"], width = { min: 10, default: 20, max: 50 }) =>
  ({ id, name: id, version: "1.0.0", height, width, sessions: ["race"], settings: {}, Component: () => null }) as BlockDefinition;
const at = (x: number, y: number, width: number, group?: string) => ({ blockVersion: "1.0.0", x, y, width, group, settings: {} });

function input(drivers = 22, selected: number[] = [], focused: number | null = null): GridInput {
  const track = { rotation: 0, outline: { x: [0, 1, 1, 0], y: [0, 0, 1, 1], z: [] }, pitLane: null } as unknown as Track;
  return {
    info: {} as HeightInput["info"],
    drivers: Array.from({ length: drivers }, (_, i) => ({ number: i }) as DriverInfo),
    track,
    selection: { selected, focused },
  };
}

const byId = (placed: Placement[]) => Object.fromEntries(placed.map((p) => [p.id, p]));
const bottom = (p: Placement) => p.top + p.height;

describe("pack", () => {
  const blocks = new Map(
    [
      block("a", 100),
      block("b", 50),
      block("fill", { min: 80 }),
      block("fill2", { min: 40 }),
      block("wide", 30, { min: 50, default: 50, max: 50 }),
      block("chips", ({ selection }) => (selection.selected.length > 0 ? 60 : 20)),
    ].map((b) => [b.id, b]),
  );
  const layout = (entries: Layout["blocks"]): Layout => ({ version: 1, columns: 10, blocks: entries });

  test("fixed blocks stack at their heights, with a hairline between groups and none inside one", () => {
    const p = byId(pack(layout({ a: at(0, 0, 2), b: at(0, 1, 2, "g"), chips: at(0, 2, 2, "g") }), blocks, input(), 1000));
    expect([p.a.top, p.a.height, p.a.dividerTop]).toEqual([0, 100, false]);
    expect([p.b.top, p.b.dividerTop]).toEqual([100 + DIVIDER, true]);
    expect([p.chips.top, p.chips.dividerTop]).toEqual([bottom(p.b), false]);
  });

  test("blocks settle upwards onto what's above them, in order of y then x", () => {
    const p = byId(pack(layout({ a: at(0, 0, 2), b: at(0, 30, 2), chips: at(2, 9, 2) }), blocks, input(), 1000));
    expect(p.b.top).toBe(100 + DIVIDER);
    expect(p.chips.top).toBe(0);
  });

  test("the last stretching block in a column fills it to the bottom and pushes what's under it down", () => {
    const p = byId(pack(layout({ fill: at(0, 0, 2), a: at(0, 1, 2), fill2: at(2, 0, 2) }), blocks, input(), 600));
    expect(bottom(p.a)).toBe(600);
    expect(p.fill.height).toBe(600 - 100 - DIVIDER);
    expect(bottom(p.fill2)).toBe(600);
  });

  test("only the last stretching block in a column grows; the others keep their minimum", () => {
    const p = byId(pack(layout({ fill2: at(0, 0, 2), fill: at(0, 1, 2) }), blocks, input(), 600));
    expect(p.fill2.height).toBe(40);
    expect(bottom(p.fill)).toBe(600);
  });

  test("a stretching block across columns grows by the least room any of them has", () => {
    const p = byId(pack(layout({ a: at(0, 0, 2), b: at(2, 0, 2), fill: at(0, 1, 4) }), blocks, input(), 600));
    expect(p.fill.top).toBe(100 + DIVIDER);
    expect(bottom(p.fill)).toBe(600);
  });

  test("when the blocks don't fit, stretching blocks keep their minimum (the bottom is cut off)", () => {
    const p = byId(pack(layout({ a: at(0, 0, 2), fill: at(0, 1, 2) }), blocks, input(), 120));
    expect(p.fill.height).toBe(80);
  });

  test("a block with a height of its own is that tall and doesn't stretch; its contents keep what they take", () => {
    const p = byId(pack(layout({ fill: { ...at(0, 0, 2), height: 300 }, a: { ...at(2, 0, 2), height: 60 }, b: at(2, 1, 2) }), blocks, input(), 600));
    expect([p.fill.height, p.fill.stretch, p.fill.contentHeight]).toEqual([300, false, 80]);
    // Shorter than its contents: the box scrolls (Grid), and what's under it rests on the box.
    expect([p.a.height, p.a.contentHeight]).toEqual([60, 100]);
    expect(p.b.top).toBe(60 + DIVIDER);
    // Without one, a block's contents take its own height (a stretching block's minimum).
    const auto = byId(pack(layout({ fill: at(0, 0, 2), a: at(2, 0, 2) }), blocks, input(), 600));
    expect([auto.fill.height, auto.fill.contentHeight, auto.a.contentHeight]).toEqual([600, 80, 100]);
  });

  test("heights can depend on the selection", () => {
    const l = layout({ chips: at(0, 0, 2) });
    expect(pack(l, blocks, input(), 500)[0].height).toBe(20);
    expect(pack(l, blocks, input(22, [1]), 500)[0].height).toBe(60);
  });

  test("hairlines on the left edge only next to another group", () => {
    const p = byId(pack(layout({ a: at(0, 0, 2, "g"), b: at(2, 0, 2, "g"), chips: at(4, 0, 2) }), blocks, input(), 500));
    expect([p.a.dividerLeft, p.b.dividerLeft, p.chips.dividerLeft]).toEqual([false, false, true]);
  });

  test("widths (percent of the grid) snap to whole columns and clamp; unknown blocks are left out", () => {
    expect(columnRange(blocks.get("wide")!, 10)).toEqual({ min: 5, max: 5 });
    const placed = pack(layout({ wide: at(9, 0, 1), gone: at(0, 0, 2) }), blocks, input(), 500);
    expect(placed.map((p) => [p.id, p.x, p.width])).toEqual([["wide", 5, 5]]);
  });
});

describe("default layout", () => {
  // The old screen: the tower and map full height; on the right the header, telemetry, laps, tyres, feed.
  // From about 610 px (the driver panel and the feed's minimum) up; 767 is 1440x900's grid.
  const heights = [610, 767, 947, 1427];
  const states = [input(), input(22, [63, 12]), input(22, [63, 12], 63), input(20, [1])];
  // Weather is in the top bar; the analysis blocks are added from the block picker.
  const NOT_IN_DEFAULT = ["weather", "gap-chart", "pit-strategy", "battles"];

  test("places every built-in block but those off the default screen once, within its width range", () => {
    expect(Object.keys(DEFAULT_LAYOUT.blocks).sort()).toEqual([...BUILTIN_BLOCKS.keys()].filter((id) => !NOT_IN_DEFAULT.includes(id)).sort());
    expect(DEFAULT_LAYOUT.columns).toBe(COLUMNS);
    for (const [id, e] of Object.entries(DEFAULT_LAYOUT.blocks)) {
      const { min, max } = columnRange(BUILTIN_BLOCKS.get(id)!, COLUMNS);
      expect(e.width).toBeGreaterThanOrEqual(min);
      expect(e.width).toBeLessThanOrEqual(max);
    }
  });

  test("every column ends flush with the bottom, and no blocks overlap", () => {
    for (const h of heights) {
      for (const s of states) {
        const placed = pack(DEFAULT_LAYOUT, BUILTIN_BLOCKS, s, h);
        for (let c = 0; c < COLUMNS; c++) {
          const inColumn = placed.filter((p) => p.x <= c && c < p.x + p.width);
          expect(Math.max(...inColumn.map(bottom))).toBeCloseTo(h, 6);
        }
        for (const a of placed) {
          for (const b of placed) {
            if (a === b) continue;
            const overlap = a.x < b.x + b.width && b.x < a.x + a.width && a.top < bottom(b) - 1e-9 && b.top < bottom(a) - 1e-9;
            if (overlap) throw new Error(`${a.id} overlaps ${b.id} at ${h} px`);
          }
        }
      }
    }
  });

  test("tower, map and feed stretch; the driver panel keeps the old screen's heights", () => {
    const p = byId(pack(DEFAULT_LAYOUT, BUILTIN_BLOCKS, input(22, [63, 12], 63), 1427));
    expect(p["timing-tower"].height).toBe(1427);
    expect(p["track-map"].height).toBe(1427);
    // Measured on the old screen (07d720a): chips 33 + header 70.2, telemetry 175.28, laps 87.56, tyres 53.
    expect(p["driver-header"].height).toBeCloseTo(103.21, 1);
    expect(bottom(p["speed-trace"]) - p["driver-header"].height).toBeCloseTo(175.28, 1);
    // The old tyre section began at 418.05 px on screen (52 px top bar), its hairline included.
    expect(p["tyre-strip"].top).toBeCloseTo(418.05 + 1 - 52, 1);
    expect(bottom(p["race-feed"])).toBe(1427);
  });

  test("hairlines only where the old screen had them", () => {
    const p = byId(pack(DEFAULT_LAYOUT, BUILTIN_BLOCKS, input(22, [63, 12], 63), 900));
    const top = Object.fromEntries(Object.entries(p).map(([id, x]) => [id, x.dividerTop]));
    expect(top).toEqual({
      "timing-tower": false,
      "track-map": false,
      "driver-header": false,
      "speed-gear": true,
      "throttle-brake-rpm": true,
      "speed-trace": false,
      "lap-times": true,
      sectors: false,
      "tyre-strip": true,
      "race-feed": true,
    });
    const left = Object.entries(p).filter(([, x]) => x.dividerLeft).map(([id]) => id).sort();
    expect(left).toEqual(["driver-header", "lap-times", "race-feed", "sectors", "speed-gear", "speed-trace", "track-map", "tyre-strip"]);
  });
});

describe("boxes", () => {
  test("neighbours never overlap at any width from 1000 to 2560 px", () => {
    for (const s of [input(), input(22, [63, 12])]) {
      const placed = pack(DEFAULT_LAYOUT, BUILTIN_BLOCKS, s, 800);
      for (let width = 1000; width <= 2560; width++) {
        const boxes = boxesOf(placed, width, DEFAULT_LAYOUT.columns);
        for (let i = 0; i < boxes.length; i++) {
          const a = boxes[i];
          expect(a.width).toBeGreaterThan(0);
          expect(a.height).toBeGreaterThan(0);
          for (let j = i + 1; j < boxes.length; j++) {
            const b = boxes[j];
            const overlap = a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height - 1e-9 && b.top < a.top + a.height - 1e-9;
            if (overlap) throw new Error(`${placed[i].id} overlaps ${placed[j].id} at ${width} px`);
          }
        }
      }
    }
  });

  test("side by side blocks meet exactly; a box includes the hairline above its block", () => {
    const placed = pack(DEFAULT_LAYOUT, BUILTIN_BLOCKS, input(), 800);
    const boxes = boxesOf(placed, 1720, COLUMNS);
    const box = (id: string) => boxes[placed.findIndex((p) => p.id === id)];
    expect(box("speed-gear").left + box("speed-gear").width).toBe(box("throttle-brake-rpm").left);
    expect(box("timing-tower").left + box("timing-tower").width).toBe(box("track-map").left);
    expect(box("speed-gear").top).toBeCloseTo(box("driver-header").top + box("driver-header").height, 6);
  });

  test("the default widths at 1720 px are the old screen's, to the nearest column", () => {
    const placed = pack(DEFAULT_LAYOUT, BUILTIN_BLOCKS, input(), 800);
    const boxes = boxesOf(placed, 1720, COLUMNS);
    const box = (id: string) => boxes[placed.findIndex((p) => p.id === id)];
    const column = 1720 / COLUMNS;
    expect(Math.abs(box("timing-tower").width - 410)).toBeLessThanOrEqual(column / 2);
    expect(Math.abs(box("driver-header").width - 360)).toBeLessThanOrEqual(column / 2);
    // The speed column fits its contents (109 px) down to 1440 px wide.
    const at1440 = boxesOf(placed, 1440, COLUMNS)[placed.findIndex((p) => p.id === "speed-gear")];
    expect(at1440.width).toBeGreaterThanOrEqual(109);
  });
});
