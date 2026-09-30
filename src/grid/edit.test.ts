import { describe, expect, test } from "bun:test";
import type { BlockDefinition, HeightInput } from "../blockkit/defineBlock";
import type { Track } from "../blockkit/select";
import type { DriverInfo } from "../types";
import { BUILTIN_BLOCKS } from "./builtins";
import { DEFAULT_LAYOUT } from "./defaultLayout";
import { addBlock, canAdd, cutOff, dropTarget, fits, fitsAsWell, freeSlots, moveBlock, overflow, removeBlock, resizeBlock, type EditContext } from "./edit";
import { COLUMNS, DIVIDER, pack, type GridInput, type Layout, type Placement } from "./layout";

const block = (id: string, height: BlockDefinition["height"], width = { min: 10, default: 20, max: 50 }, sessions: BlockDefinition["sessions"] = ["race"]) =>
  ({ id, name: id, version: "1.0.0", height, width, sessions, settings: {}, Component: () => null }) as BlockDefinition;
const at = (x: number, y: number, width: number, group?: string) => ({ blockVersion: "1.0.0", x, y, width, ...(group && { group }), settings: {} });

function input(): GridInput {
  const track = { rotation: 0, outline: { x: [0, 1, 1, 0], y: [0, 0, 1, 1], z: [] }, pitLane: null } as unknown as Track;
  return {
    info: {} as HeightInput["info"],
    drivers: Array.from({ length: 22 }, (_, i) => ({ number: i }) as DriverInfo),
    track,
    selection: { selected: [], focused: null },
  };
}

/** The race screen at 1440x900's grid height. */
const ctx = (gridHeight = 767, blocks: ReadonlyMap<string, BlockDefinition> = BUILTIN_BLOCKS): EditContext => ({ blocks, input: input(), gridHeight });
const placed = (layout: Layout, c: EditContext = ctx()) => pack(layout, c.blocks, c.input, c.gridHeight);
const byId = (p: Placement[]) => Object.fromEntries(p.map((q) => [q.id, q]));
const bottom = (p: Placement) => p.top + p.height;
/** Ids in pack order, and their y's are 0..n-1. */
const orderOf = (layout: Layout) => {
  const ids = Object.keys(layout.blocks).sort((a, b) => layout.blocks[a].y - layout.blocks[b].y);
  expect(ids.map((id) => layout.blocks[id].y)).toEqual(ids.map((_, i) => i));
  return ids;
};
const xw = (layout: Layout, id: string) => [layout.blocks[id].x, layout.blocks[id].width];

// The default layout's columns: tower 0-8, map 9-29, the driver panel 30-37 (speed & gear 30-32).
const TOWER = DEFAULT_LAYOUT.blocks["timing-tower"].width;
const RIGHT = DEFAULT_LAYOUT.blocks["driver-header"].x;
const frozen = structuredClone(DEFAULT_LAYOUT);

// Synthetic blocks on a 10-column grid (10% = one column).
const small = new Map(
  [
    block("a", 100),
    block("b", 50),
    block("wide", 30, { min: 40, default: 40, max: 40 }),
    block("tiny", 40),
    block("one", 100, { min: 10, default: 10, max: 10 }),
    block("u", 50, { min: 10, default: 10, max: 10 }),
    block("q", 50, { min: 10, default: 10, max: 10 }),
    block("grow", 100, { min: 10, default: 10, max: 30 }),
    block("full", 100, { min: 100, default: 100, max: 100 }),
    block("quali", 50, undefined, ["qualifying"]),
  ].map((b) => [b.id, b]),
);
const grid = (entries: Layout["blocks"]): Layout => ({ version: 1, columns: 10, blocks: entries });

describe("fits and cut off", () => {
  test("the default layout fits from about 610 px; below that the bottom of the panel is cut off", () => {
    expect(fits(DEFAULT_LAYOUT, ctx(767))).toBe(true);
    expect(fits(DEFAULT_LAYOUT, ctx(610))).toBe(true);
    expect(fits(DEFAULT_LAYOUT, ctx(400))).toBe(false);
    expect(overflow(DEFAULT_LAYOUT, ctx(767))).toBe(0);
    const cut = cutOff(DEFAULT_LAYOUT, ctx(400));
    expect(cut).toContain("race-feed");
    expect(cut).not.toContain("timing-tower");
    expect(cutOff(DEFAULT_LAYOUT, ctx(767))).toEqual([]);
  });

  test("fitsAsWell: an already cut-off layout accepts edits that don't cut off more", () => {
    const c = ctx(400);
    const lighter = removeBlock(DEFAULT_LAYOUT, "race-feed");
    expect(fitsAsWell(DEFAULT_LAYOUT, lighter, c)).toBe(true);
    expect(fitsAsWell(lighter, DEFAULT_LAYOUT, c)).toBe(false);
    expect(fitsAsWell(DEFAULT_LAYOUT, DEFAULT_LAYOUT, c)).toBe(true);
  });
});

describe("remove", () => {
  test("removing the feed leaves a slot at the bottom of the panel; y's renumbered, input untouched", () => {
    const l = removeBlock(DEFAULT_LAYOUT, "race-feed");
    expect(DEFAULT_LAYOUT).toEqual(frozen);
    expect("race-feed" in l.blocks).toBe(false);
    expect(orderOf(l)).toEqual(["timing-tower", "track-map", "driver-header", "speed-gear", "throttle-brake-rpm", "speed-trace", "lap-times", "sectors", "tyre-strip"]);
    const p = byId(placed(l));
    expect(freeSlots(placed(l), COLUMNS, 767)).toEqual([{ x: RIGHT, width: COLUMNS - RIGHT, top: bottom(p["tyre-strip"]), height: 767 - bottom(p["tyre-strip"]) }]);
  });

  test("the full default layout has no free slots; removing the tower frees its columns top to bottom", () => {
    expect(freeSlots(placed(DEFAULT_LAYOUT), COLUMNS, 767)).toEqual([]);
    const l = removeBlock(DEFAULT_LAYOUT, "timing-tower");
    expect(freeSlots(placed(l), COLUMNS, 767)).toEqual([{ x: 0, width: TOWER, top: 0, height: 767 }]);
  });

  test("removing a block that isn't there returns the layout", () => {
    expect(removeBlock(DEFAULT_LAYOUT, "weather")).toBe(DEFAULT_LAYOUT);
  });
});

describe("drop target and move", () => {
  const gridWidth = 1720;
  const column = gridWidth / COLUMNS;

  test("lap times dropped at the top of the tower column go above the tower", () => {
    const p = placed(DEFAULT_LAYOUT);
    const target = dropTarget(DEFAULT_LAYOUT, p, "lap-times", 0.3 * column, 10, gridWidth);
    // Its 8 columns at x 0 overlap the tower (0-8) only.
    expect(target).toEqual({ x: 0, index: 0 });
    const l = moveBlock(DEFAULT_LAYOUT, p, "lap-times", target);
    expect(DEFAULT_LAYOUT).toEqual(frozen);
    expect(l.blocks["lap-times"]).toEqual({ ...DEFAULT_LAYOUT.blocks["lap-times"], x: 0, y: 0 });
    const after = byId(placed(l));
    expect(after["lap-times"].top).toBe(0);
    expect(after["timing-tower"].top).toBeCloseTo(after["lap-times"].height + DIVIDER, 6);
    expect(bottom(after["timing-tower"])).toBeCloseTo(767, 6);
    // Sectors, left behind by its group-mate, gets its hairline back.
    expect(after.sectors.dividerTop).toBe(true);
  });

  test("whether it fits depends on the height: the tower keeps its minimum under it", () => {
    const l = moveBlock(DEFAULT_LAYOUT, placed(DEFAULT_LAYOUT), "lap-times", { x: 0, index: 0 });
    expect(fits(l, ctx(767))).toBe(true);
    expect(fits(l, ctx(620))).toBe(true);
    // Lap times (46.3) + hairline + the tower's minimum (206) is 253.3 px.
    expect(fits(l, ctx(250))).toBe(false);
    expect(cutOff(l, ctx(250))).toContain("timing-tower");
    expect(cutOff(l, ctx(260))).not.toContain("timing-tower");
  });

  test("moving within the panel reorders it; groups rejoin when blocks touch again", () => {
    const p = placed(DEFAULT_LAYOUT);
    const laps = byId(p)["lap-times"];
    // The tyres dragged up over lap times: above lap times' centre.
    const target = dropTarget(DEFAULT_LAYOUT, p, "tyre-strip", RIGHT * column + 3, laps.top + 2, gridWidth);
    expect(target.x).toBe(RIGHT);
    const l = moveBlock(DEFAULT_LAYOUT, p, "tyre-strip", target);
    expect(orderOf(l).slice(5)).toEqual(["speed-trace", "tyre-strip", "lap-times", "sectors", "race-feed"]);
    const after = byId(placed(l));
    expect(after["tyre-strip"].top).toBeCloseTo(bottom(after["speed-trace"]) + DIVIDER, 6);
    expect(after["lap-times"].dividerTop).toBe(true);
    // Lap times and sectors are still one panel.
    expect([l.blocks["lap-times"].group, l.blocks.sectors.group]).toEqual(["laps", "laps"]);
    expect(after.sectors.dividerTop).toBe(false);

    // Sectors moved under the tyres splits the panel; moving it back under lap times rejoins it.
    const tyresDown = moveBlock(l, placed(l), "tyre-strip", { x: RIGHT, index: 6 });
    expect(orderOf(tyresDown).slice(5)).toEqual(["speed-trace", "lap-times", "sectors", "tyre-strip", "race-feed"]);
    const sectorsDown = moveBlock(tyresDown, placed(tyresDown), "sectors", { x: RIGHT, index: 8 });
    expect(orderOf(sectorsDown).slice(5)).toEqual(["speed-trace", "lap-times", "tyre-strip", "race-feed", "sectors"]);
    expect(byId(placed(sectorsDown)).sectors.dividerTop).toBe(true);
    // Just under lap times' centre: before the tyres (header, speed, bars, trace, lap times, tyres, feed).
    const lapsNow = byId(placed(sectorsDown))["lap-times"];
    const back = moveBlock(sectorsDown, placed(sectorsDown), "sectors", dropTarget(sectorsDown, placed(sectorsDown), "sectors", RIGHT * column, lapsNow.top + lapsNow.height / 2 + 1, gridWidth));
    expect(orderOf(back)).toEqual(orderOf(tyresDown));
    expect(byId(placed(back)).sectors.dividerTop).toBe(false);
  });

  test("x rounds to the nearest column and clamps at the grid's edges; index clamps to the span", () => {
    const p = placed(DEFAULT_LAYOUT);
    const panelSpan = p.filter((q) => q.id !== "tyre-strip" && q.x + q.width > RIGHT).length;
    expect(dropTarget(DEFAULT_LAYOUT, p, "tyre-strip", -500, -100, gridWidth)).toEqual({ x: 0, index: 0 });
    expect(dropTarget(DEFAULT_LAYOUT, p, "tyre-strip", gridWidth + 500, 5000, gridWidth)).toEqual({ x: COLUMNS - 8, index: panelSpan });
    expect(dropTarget(DEFAULT_LAYOUT, p, "tyre-strip", 4.4 * column, 0, gridWidth).x).toBe(4);
    expect(dropTarget(DEFAULT_LAYOUT, p, "tyre-strip", 4.6 * column, 0, gridWidth).x).toBe(5);
    // An index past the span means after its last member.
    const l = moveBlock(DEFAULT_LAYOUT, p, "tyre-strip", { x: RIGHT, index: 99 });
    expect(orderOf(l).at(-1)).toBe("tyre-strip");
  });

  test("a block spanning columns with different stacks rests below the lowest; the shorter column gets a slot", () => {
    const l = grid({ a: at(0, 0, 2), b: at(2, 0, 2), wide: at(0, 1, 4) });
    const c = ctx(400, small);
    const p = byId(placed(l, c));
    expect(p.wide.top).toBe(100 + DIVIDER);
    expect(freeSlots(placed(l, c), 10, 400)).toEqual([
      { x: 0, width: 4, top: bottom(p.wide), height: 400 - bottom(p.wide) },
      { x: 2, width: 2, top: 50, height: 50 },
      { x: 4, width: 6, top: 0, height: 400 },
    ]);
    // Dragging tiny (2 columns) over columns 1-2: its span holds a (0-1), b (2-3) and wide, in pack order;
    // at 60 px it's below a's and b's centres (50, 25) and above wide's.
    const withTiny = grid({ ...l.blocks, tiny: at(6, 2, 2) });
    const q = placed(withTiny, c);
    expect(dropTarget(withTiny, q, "tiny", 1 * 40, 60, 400)).toEqual({ x: 1, index: 2 });
    const moved = moveBlock(withTiny, q, "tiny", { x: 1, index: 2 });
    expect(orderOf(moved)).toEqual(["a", "b", "tiny", "wide"]);
    const r = byId(placed(moved, c));
    // Below the lowest of a and b, and wide below it.
    expect(r.tiny.top).toBe(100 + DIVIDER);
    expect(r.wide.top).toBe(bottom(r.tiny) + DIVIDER);
    // Before b (after a): it sits on a, and b follows it.
    const early = moveBlock(withTiny, q, "tiny", { x: 1, index: 1 });
    expect(orderOf(early)).toEqual(["a", "tiny", "b", "wide"]);
    expect(byId(placed(early, c)).b.top).toBe(bottom(r.tiny) + DIVIDER);
  });

  test("a multi-column block dropped at the top goes first; the stacks under it settle below it", () => {
    const l = grid({ a: at(0, 0, 2), b: at(2, 0, 2), wide: at(0, 1, 4) });
    const moved = moveBlock(l, placed(l, ctx(400, small)), "wide", { x: 0, index: 0 });
    expect(orderOf(moved)).toEqual(["wide", "a", "b"]);
    const p = byId(placed(moved, ctx(400, small)));
    expect([p.wide.top, p.a.top, p.b.top]).toEqual([0, 30 + DIVIDER, 30 + DIVIDER]);
  });

  test("into an empty span it goes at the end", () => {
    const l = grid({ a: at(0, 0, 2), b: at(2, 1, 2) });
    const moved = moveBlock(l, placed(l, ctx(400, small)), "a", { x: 6, index: 0 });
    expect(orderOf(moved)).toEqual(["b", "a"]);
    expect(xw(moved, "a")).toEqual([6, 2]);
  });
});

describe("resize", () => {
  const c = ctx(767);

  test("widening the tower takes a column from the map", () => {
    const l = resizeBlock(DEFAULT_LAYOUT, c, "timing-tower", "right", TOWER + 1);
    expect(DEFAULT_LAYOUT).toEqual(frozen);
    expect(xw(l, "timing-tower")).toEqual([0, TOWER + 1]);
    expect(xw(l, "track-map")).toEqual([TOWER + 1, 20]);
    expect(orderOf(l)).toHaveLength(10);
  });

  test("widening the map to the right shrinks the panel, shifts speed & gear (at its min) and shrinks the bars", () => {
    const l = resizeBlock(DEFAULT_LAYOUT, c, "track-map", "right", RIGHT + 1);
    expect(xw(l, "track-map")).toEqual([TOWER, 22]);
    expect(xw(l, "speed-gear")).toEqual([RIGHT + 1, 3]);
    expect(xw(l, "throttle-brake-rpm")).toEqual([RIGHT + 4, 4]);
    for (const id of ["driver-header", "speed-trace", "lap-times", "sectors", "tyre-strip", "race-feed"]) expect(xw(l, id)).toEqual([RIGHT + 1, 7]);
    expect(fits(l, c)).toBe(true);
    // The next column would push the bars (now at their min) off the grid: the resize stops at one.
    expect(resizeBlock(DEFAULT_LAYOUT, c, "track-map", "right", RIGHT + 3)).toEqual(l);
  });

  test("stops at the block's min and max; each column goes to or comes from the map", () => {
    const narrow = resizeBlock(DEFAULT_LAYOUT, c, "timing-tower", "right", 2);
    expect(xw(narrow, "timing-tower")).toEqual([0, 8]);
    expect(xw(narrow, "track-map")).toEqual([8, 22]);
    const wide = resizeBlock(DEFAULT_LAYOUT, c, "timing-tower", "right", 30);
    expect(xw(wide, "timing-tower")).toEqual([0, 15]);
    expect(xw(wide, "track-map")).toEqual([15, 15]);
  });

  test("refused at the grid's edges: the input comes back", () => {
    expect(resizeBlock(DEFAULT_LAYOUT, c, "timing-tower", "left", -3)).toBe(DEFAULT_LAYOUT);
    expect(resizeBlock(DEFAULT_LAYOUT, c, "driver-header", "right", 40)).toBe(DEFAULT_LAYOUT);
    expect(resizeBlock(DEFAULT_LAYOUT, c, "race-feed", "right", COLUMNS)).toBe(DEFAULT_LAYOUT);
    expect(resizeBlock(DEFAULT_LAYOUT, c, "weather", "right", 5)).toBe(DEFAULT_LAYOUT);
  });

  test("a chain that reaches the grid's edge is refused: speed & gear widens once", () => {
    const l = resizeBlock(DEFAULT_LAYOUT, c, "speed-gear", "right", RIGHT + 5);
    expect(xw(l, "speed-gear")).toEqual([RIGHT, 4]);
    expect(xw(l, "throttle-brake-rpm")).toEqual([RIGHT + 4, 4]);
    // The header above and the trace below don't overlap it vertically, so they're untouched.
    expect(xw(l, "driver-header")).toEqual([RIGHT, 8]);
  });

  test("widening a panel block to the left takes the column from the map", () => {
    const l = resizeBlock(DEFAULT_LAYOUT, c, "lap-times", "left", RIGHT - 1);
    expect(xw(l, "lap-times")).toEqual([RIGHT - 1, 9]);
    expect(xw(l, "track-map")).toEqual([TOWER, 20]);
  });

  test("narrowing hands the column to the neighbour below its max, else leaves a gap", () => {
    const l = resizeBlock(DEFAULT_LAYOUT, c, "track-map", "left", TOWER + 1);
    expect(xw(l, "track-map")).toEqual([TOWER + 1, 20]);
    expect(xw(l, "timing-tower")).toEqual([0, TOWER + 1]);
    const s = grid({ one: at(0, 0, 1), grow: at(1, 0, 3) });
    const g = resizeBlock(s, ctx(400, small), "grow", "left", 2);
    expect(xw(g, "grow")).toEqual([2, 2]);
    expect(xw(g, "one")).toEqual([0, 1]);
    expect(freeSlots(placed(g, ctx(400, small)), 10, 400)).toContainEqual({ x: 1, width: 1, top: 0, height: 400 });
  });

  test("a step that doesn't fit is refused", () => {
    // q sits beside a's bottom half's column but above it; widening a over q's column puts q under a.
    const l = grid({ u: at(0, 0, 1), grow: at(0, 1, 1), q: at(1, 2, 1) });
    const c180 = ctx(180, small);
    expect(fits(l, c180)).toBe(true);
    expect(resizeBlock(l, c180, "grow", "right", 3)).toBe(l);
    const roomy = resizeBlock(l, ctx(400, small), "grow", "right", 3);
    expect(xw(roomy, "grow")).toEqual([0, 3]);
  });
});

describe("free slots", () => {
  test("adjacent columns merge only when their gap has the same top and bottom", () => {
    const l = grid({ a: at(0, 0, 2), b: at(2, 0, 2) });
    expect(freeSlots(placed(l, ctx(300, small)), 10, 300)).toEqual([
      { x: 0, width: 2, top: 100, height: 200 },
      { x: 2, width: 2, top: 50, height: 250 },
      { x: 4, width: 6, top: 0, height: 300 },
    ]);
    expect(freeSlots([], 10, 300)).toEqual([{ x: 0, width: 10, top: 0, height: 300 }]);
  });
});

describe("add", () => {
  test("into a full default layout: at the bottom of the roomiest columns (under the map, which gives way)", () => {
    const c = ctx(767);
    const l = addBlock(DEFAULT_LAYOUT, c, "weather")!;
    expect(DEFAULT_LAYOUT).toEqual(frozen);
    expect(l.blocks.weather).toEqual({ blockVersion: "1.0.0", x: TOWER, y: 10, width: 4, settings: {} });
    const p = byId(placed(l, c));
    expect(bottom(p.weather)).toBe(767);
    expect(p["track-map"].height).toBeCloseTo(767 - 72 - DIVIDER, 6);
    expect(canAdd(DEFAULT_LAYOUT, c, "weather")).toBe(true);
  });

  test("prefers empty space on screen: with the feed gone, the panel's free bottom", () => {
    const c = ctx(767);
    const l = addBlock(removeBlock(DEFAULT_LAYOUT, "race-feed"), c, "weather")!;
    expect(xw(l, "weather")).toEqual([RIGHT, 4]);
    expect(byId(placed(l, c))["track-map"].height).toBe(767);
  });

  test("into a slot: left-aligned, the default width clamped to the slot, at the slot's top", () => {
    const c = ctx(767);
    const l = removeBlock(DEFAULT_LAYOUT, "race-feed");
    const [slot] = freeSlots(placed(l, c), COLUMNS, 767);
    const back = addBlock(l, c, "race-feed", slot)!;
    expect(xw(back, "race-feed")).toEqual([RIGHT, 8]);
    expect(placed(back, c).map((p) => [p.id, p.x, p.width, p.top, p.height])).toEqual(placed(DEFAULT_LAYOUT, c).map((p) => [p.id, p.x, p.width, p.top, p.height]));
    const narrow = addBlock(l, c, "weather", { ...slot, width: 3 })!;
    expect(xw(narrow, "weather")).toEqual([RIGHT, 3]);
    expect(byId(placed(narrow, c)).weather.top).toBeCloseTo(slot.top + DIVIDER, 6);
    // Narrower than the block's minimum (weather's is 3 columns).
    expect(addBlock(l, c, "weather", { ...slot, width: 2 })).toBeNull();
  });

  test("into the gap above a multi-column block: nothing else moves", () => {
    const c = ctx(400, small);
    const l = grid({ a: at(0, 0, 2), b: at(2, 0, 2), wide: at(0, 1, 4) });
    const gap = freeSlots(placed(l, c), 10, 400).find((s) => s.x === 2)!;
    const next = addBlock(l, c, "tiny", gap)!;
    const before = byId(placed(l, c));
    const p = byId(placed(next, c));
    expect([p.tiny.x, p.tiny.width, p.tiny.top - DIVIDER]).toEqual([2, 2, 50]);
    expect([p.a.top, p.b.top, p.wide.top]).toEqual([before.a.top, before.b.top, before.wide.top]);
    // Taller than the gap would push the wide block down past 150 px: refused there.
    expect(canAdd(l, ctx(150, small), "grow", gap)).toBe(false);
    expect(canAdd(l, ctx(400, small), "grow", gap)).toBe(true);
  });

  test("null when it fits nowhere, it's placed already, unknown or not a race block", () => {
    const c = ctx(150, small);
    const full = grid({ full: at(0, 0, 10) });
    expect(addBlock(full, c, "b")).toBeNull();
    expect(canAdd(full, c, "b")).toBe(false);
    expect(addBlock(full, ctx(200, small), "b")!.blocks.b).toEqual({ blockVersion: "1.0.0", x: 0, y: 1, width: 2, settings: {} });
    expect(addBlock(full, c, "full")).toBeNull();
    expect(addBlock(full, c, "nope")).toBeNull();
    expect(addBlock(grid({}), c, "quali")).toBeNull();
  });
});
