import { describe, expect, test } from "bun:test";
import type { BlockDefinition, ShapeInput } from "../blockkit/defineBlock";
import type { Track } from "../blockkit/select";
import type { DriverInfo } from "../types";
import { BUILTIN_BLOCKS } from "./builtins";
import { DEFAULT_LAYOUT } from "./defaultLayout";
import { boxesOf, pack, ROWS_PER_COLUMN, type Layout } from "./layout";

const block = (id: string, shape: number, width = { min: 1, default: 2, max: 4 }) =>
  ({ id, name: id, version: "1.0.0", shape, width, sessions: ["race"], settings: {}, Component: () => null }) as BlockDefinition;
const at = (x: number, y: number, width: number) => ({ blockVersion: "1.0.0", x, y, width, settings: {} });

/** An outline `aspect` times wider than tall, and `drivers` cars. */
function input(aspect: number, drivers = 22): ShapeInput {
  const track = { rotation: 0, outline: { x: [0, aspect, aspect, 0], y: [0, 0, 1, 1], z: [] }, pitLane: null } as unknown as Track;
  return { info: {} as ShapeInput["info"], drivers: Array.from({ length: drivers }, (_, i) => ({ number: i }) as DriverInfo), track };
}

describe("pack", () => {
  const blocks = new Map([block("a", 2), block("b", 1), block("c", 4), block("wide", 8, { min: 3, default: 3, max: 3 })].map((b) => [b.id, b]));

  test("heights come from shape x width, rounded up to the quarter-column step", () => {
    const [a] = pack({ version: 1, columns: 10, blocks: { a: at(0, 0, 2) } }, blocks, input(1));
    expect(a.rows).toBe(4); // 2 columns at 2:1 = 1 column tall = 4 rows
    const [c] = pack({ version: 1, columns: 10, blocks: { c: at(0, 0, 3) } }, blocks, input(1));
    expect(c.rows).toBe(3); // 0.75 columns tall
  });

  test("blocks settle upwards onto what's above them", () => {
    const layout: Layout = { version: 1, columns: 10, blocks: { a: at(0, 0, 2), b: at(0, 30, 2), c: at(2, 9, 2) } };
    const byId = Object.fromEntries(pack(layout, blocks, input(1)).map((p) => [p.id, p]));
    expect(byId.b.y).toBe(4);
    expect(byId.c.y).toBe(0);
  });

  test("widths are clamped to the block's range and the grid; unknown blocks are left out", () => {
    const placed = pack({ version: 1, columns: 10, blocks: { wide: at(9, 0, 1), gone: at(0, 0, 2) } }, blocks, input(1));
    expect(placed.map((p) => [p.id, p.x, p.width])).toEqual([["wide", 7, 3]]);
  });
});

describe("default layout", () => {
  test("places every built-in block once, within its width range", () => {
    expect(Object.keys(DEFAULT_LAYOUT.blocks).sort()).toEqual([...BUILTIN_BLOCKS.keys()].sort());
    for (const [id, e] of Object.entries(DEFAULT_LAYOUT.blocks)) {
      const b = BUILTIN_BLOCKS.get(id)!;
      expect(e.width).toBeGreaterThanOrEqual(b.width.min);
      expect(e.width).toBeLessThanOrEqual(b.width.max);
    }
  });

  test("with 22 drivers it's at most 21 rows whatever the circuit, with no overlaps", () => {
    for (const aspect of [0.6, 1.51, 3.3]) {
      const placed = pack(DEFAULT_LAYOUT, BUILTIN_BLOCKS, input(aspect));
      expect(Math.max(...placed.map((p) => p.y + p.rows))).toBeLessThanOrEqual(21);
    }
    const placed = pack(DEFAULT_LAYOUT, BUILTIN_BLOCKS, input(1.51));
    for (const a of placed) {
      for (const b of placed) {
        if (a === b) continue;
        const overlap = a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.rows && b.y < a.y + a.rows;
        expect(overlap).toBe(false);
      }
    }
  });

  test("the map's height stays between 10 and 13 rows whatever the circuit", () => {
    for (const aspect of [0.6, 1, 1.5, 2, 3.3]) {
      const map = pack(DEFAULT_LAYOUT, BUILTIN_BLOCKS, input(aspect)).find((p) => p.id === "track-map")!;
      expect(map.rows).toBeGreaterThanOrEqual(10);
      expect(map.rows).toBeLessThanOrEqual(13);
    }
  });

  test("the tower's shape fits every driver's row", () => {
    const tower = (n: number) => pack(DEFAULT_LAYOUT, BUILTIN_BLOCKS, input(1.5, n)).find((p) => p.id === "timing-tower")!;
    expect(tower(22).rows).toBe(19);
    expect(tower(20).rows).toBe(Math.ceil((60 + 20 * 28) / (144 / ROWS_PER_COLUMN)));
  });
});

describe("boxes", () => {
  test("neighbours never overlap at any width from 1000 to 2560 px", () => {
    for (const [aspect, drivers] of [[1.51, 22], [0.6, 20], [3.3, 22], [1, 24]]) {
      const placed = pack(DEFAULT_LAYOUT, BUILTIN_BLOCKS, input(aspect, drivers));
      for (let width = 1000; width <= 2560; width++) {
        const boxes = boxesOf(placed, width, DEFAULT_LAYOUT.columns);
        for (let i = 0; i < boxes.length; i++) {
          const a = boxes[i];
          expect(a.width).toBeGreaterThan(0);
          expect(a.height).toBeGreaterThan(0);
          for (let j = i + 1; j < boxes.length; j++) {
            const b = boxes[j];
            const overlap = a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height;
            if (overlap) throw new Error(`${placed[i].id} overlaps ${placed[j].id} at ${width} px`);
          }
        }
      }
    }
  });

  test("columns share edges: side by side blocks meet exactly", () => {
    const placed = pack(DEFAULT_LAYOUT, BUILTIN_BLOCKS, input(1.51));
    const box = (id: string) => boxesOf(placed, 1006, 10)[placed.findIndex((p) => p.id === id)];
    expect(box("speed-gear").left + box("speed-gear").width).toBe(box("throttle-brake-rpm").left);
    expect(box("driver-header").top + box("driver-header").height).toBeLessThanOrEqual(box("speed-gear").top);
  });
});
