import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { defineBlock, settingField, type BlockDefinition } from "../blockkit/defineBlock";
import { BUILTIN_BLOCKS } from "./builtins";
import { DEFAULT_LAYOUT } from "./defaultLayout";
import { COLUMNS, MIN_HEIGHT, type Layout } from "./layout";
import { clearSavedLayout, loadLayout, parseLayout, rescaleLayout, saveLayout, STORAGE_KEY } from "./storage";

/** A Map-backed localStorage; `broken` makes every call throw (private mode, quota, blocked). */
function fakeStorage(broken = false) {
  const items = new Map<string, string>();
  const guard = () => {
    if (broken) throw new Error("SecurityError");
  };
  return {
    items,
    getItem: (k: string) => (guard(), items.get(k) ?? null),
    setItem: (k: string, v: string) => (guard(), void items.set(k, String(v))),
    removeItem: (k: string) => (guard(), void items.delete(k)),
  };
}

const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const useStorage = (s: unknown) => Object.defineProperty(globalThis, "localStorage", { value: s, configurable: true, writable: true });
let storage: ReturnType<typeof fakeStorage>;
beforeEach(() => {
  storage = fakeStorage();
  useStorage(storage);
});
afterEach(() => {
  if (original) Object.defineProperty(globalThis, "localStorage", original);
  else delete (globalThis as { localStorage?: unknown }).localStorage;
});

const stored = (blocks: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ version: 1, columns: COLUMNS, blocks, ...extra });
const entry = (x: number, y: number, width: number, settings: Record<string, unknown> = {}, blockVersion = "1.0.0") => ({ blockVersion, x, y, width, settings });

describe("load and save", () => {
  test("round trip: what's saved comes back as it was", () => {
    saveLayout(DEFAULT_LAYOUT);
    expect(storage.items.has(STORAGE_KEY)).toBe(true);
    expect(loadLayout(BUILTIN_BLOCKS, DEFAULT_LAYOUT)).toEqual(DEFAULT_LAYOUT);
    const tweaked: Layout = { ...DEFAULT_LAYOUT, blocks: { ...DEFAULT_LAYOUT.blocks, "timing-tower": { ...DEFAULT_LAYOUT.blocks["timing-tower"], settings: { gapMode: "interval" } } } };
    saveLayout(tweaked);
    expect(loadLayout(BUILTIN_BLOCKS, DEFAULT_LAYOUT)).toEqual(tweaked);
  });

  test("a height of its own comes back as it was; one that isn't a number is dropped, and it's at least MIN_HEIGHT", () => {
    const sized: Layout = { ...DEFAULT_LAYOUT, blocks: { ...DEFAULT_LAYOUT.blocks, "timing-tower": { ...DEFAULT_LAYOUT.blocks["timing-tower"], height: 480 } } };
    saveLayout(sized);
    expect(loadLayout(BUILTIN_BLOCKS, DEFAULT_LAYOUT)).toEqual(sized);
    const read = (height: unknown) => parseLayout(stored({ "timing-tower": { ...entry(0, 0, 9), height } }), BUILTIN_BLOCKS)!.blocks["timing-tower"];
    expect(read("480")).not.toHaveProperty("height");
    expect(read(null)).not.toHaveProperty("height");
    expect(read(Number.POSITIVE_INFINITY)).not.toHaveProperty("height");
    expect(read(-5).height).toBe(MIN_HEIGHT);
    expect(read(212.6).height).toBe(212.6);
  });

  test("more than one of a block comes back; copies of blocks the app doesn't have are dropped", () => {
    const tower = DEFAULT_LAYOUT.blocks["timing-tower"];
    const two: Layout = { ...DEFAULT_LAYOUT, blocks: { ...DEFAULT_LAYOUT.blocks, "lap-times:2": { ...DEFAULT_LAYOUT.blocks["lap-times"], block: "lap-times", y: 10, settings: { driver: 44 } } } };
    saveLayout(two);
    expect(loadLayout(BUILTIN_BLOCKS, DEFAULT_LAYOUT)).toEqual(two);
    const read = parseLayout(stored({ "timing-tower": entry(0, 0, 9), "x:2": { ...entry(0, 1, 9), block: "nope" }, "tower-copy": { ...entry(0, 2, 9), block: "timing-tower" } }), BUILTIN_BLOCKS)!;
    expect(Object.keys(read.blocks).sort()).toEqual(["timing-tower", "tower-copy"]);
    expect(read.blocks["tower-copy"]).toMatchObject({ block: "timing-tower", width: tower.width });
  });

  test("nothing saved, corrupt JSON, the wrong version or a broken shape: the fallback", () => {
    expect(loadLayout(BUILTIN_BLOCKS, DEFAULT_LAYOUT)).toBe(DEFAULT_LAYOUT);
    for (const raw of [
      "{not json",
      "null",
      "[]",
      JSON.stringify({ ...DEFAULT_LAYOUT, version: 2 }),
      JSON.stringify({ ...DEFAULT_LAYOUT, columns: 0 }),
      JSON.stringify({ ...DEFAULT_LAYOUT, columns: "38" }),
      JSON.stringify({ ...DEFAULT_LAYOUT, blocks: [] }),
      JSON.stringify(stored({ "timing-tower": { ...entry(0, 0, 9), x: "0" } })),
      JSON.stringify(stored({ "timing-tower": { ...entry(0, 0, 9), settings: null } })),
      JSON.stringify(stored({ "timing-tower": { ...entry(0, 0, 9), group: 3 } })),
      JSON.stringify(stored({ "timing-tower": { ...entry(0, 0, 9), block: 7 } })),
      JSON.stringify(stored({ "timing-tower": entry(0, Number.NaN, 9) })),
    ]) {
      storage.items.set(STORAGE_KEY, raw);
      expect(loadLayout(BUILTIN_BLOCKS, DEFAULT_LAYOUT)).toBe(DEFAULT_LAYOUT);
    }
  });

  test("never throws: storage missing or throwing", () => {
    useStorage(fakeStorage(true));
    expect(loadLayout(BUILTIN_BLOCKS, DEFAULT_LAYOUT)).toBe(DEFAULT_LAYOUT);
    expect(() => saveLayout(DEFAULT_LAYOUT)).not.toThrow();
    expect(() => clearSavedLayout()).not.toThrow();
    useStorage(undefined);
    expect(loadLayout(BUILTIN_BLOCKS, DEFAULT_LAYOUT)).toBe(DEFAULT_LAYOUT);
    expect(() => saveLayout(DEFAULT_LAYOUT)).not.toThrow();
    expect(() => clearSavedLayout()).not.toThrow();
  });

  test("clearSavedLayout forgets it", () => {
    saveLayout(DEFAULT_LAYOUT);
    clearSavedLayout();
    expect(storage.items.has(STORAGE_KEY)).toBe(false);
    expect(loadLayout(BUILTIN_BLOCKS, DEFAULT_LAYOUT)).toBe(DEFAULT_LAYOUT);
  });
});

describe("parse", () => {
  const quali = defineBlock({ ...(BUILTIN_BLOCKS.get("weather") as BlockDefinition), id: "quali-only", sessions: ["qualifying"] });
  const blocks = new Map([...BUILTIN_BLOCKS, [quali.id, quali]]);

  test("unknown blocks and blocks without race sessions are dropped; nothing left is unusable", () => {
    const l = parseLayout(stored({ "timing-tower": entry(0, 0, 9), gone: entry(9, 0, 5), "quali-only": entry(20, 0, 4) }), blocks)!;
    expect(Object.keys(l.blocks)).toEqual(["timing-tower"]);
    expect(parseLayout(stored({ gone: entry(0, 0, 5), "quali-only": entry(0, 0, 4) }), blocks)).toBeNull();
    expect(parseLayout(stored({}), blocks)).toBeNull();
  });

  test("widths clamp to the block's range and x to the grid", () => {
    const l = parseLayout(stored({ "timing-tower": entry(0, 0, 2), "track-map": entry(36, 1, 40), "speed-gear": entry(-4, 2, 3.4) }), blocks)!;
    expect(l.blocks["timing-tower"]).toMatchObject({ x: 0, width: 8 });
    expect(l.blocks["track-map"]).toMatchObject({ x: COLUMNS - 30, width: 30 });
    expect(l.blocks["speed-gear"]).toMatchObject({ x: 0, width: 3 });
  });

  test("the same major version keeps the settings and pins the current version; another major resets them", () => {
    const l = parseLayout(
      stored({
        "timing-tower": entry(0, 0, 9, { gapMode: "interval" }, "1.4.2"),
        "lap-times": entry(30, 1, 8, { driver: 44 }, "2.0.0"),
        sectors: entry(30, 2, 8, { driver: 16 }, "not-semver"),
      }),
      blocks,
    )!;
    expect(l.blocks["timing-tower"]).toMatchObject({ blockVersion: "1.0.0", settings: { gapMode: "interval" }, x: 0, width: 9 });
    expect(l.blocks["lap-times"]).toMatchObject({ blockVersion: "1.0.0", settings: {}, x: 30, width: 8 });
    expect(l.blocks.sectors.settings).toEqual({});
  });

  test("settings the block doesn't have or doesn't accept are dropped (so the default applies)", () => {
    const setting = (id: string, settings: Record<string, unknown>) => parseLayout(stored({ [id]: entry(0, 0, 9, settings) }), blocks)!.blocks[id].settings;
    expect(setting("timing-tower", { gapMode: "bogus", extra: 1 })).toEqual({});
    expect(setting("timing-tower", { gapMode: "leader" })).toEqual({ gapMode: "leader" });
    expect(setting("lap-times", { driver: "follow-selection" })).toEqual({ driver: "follow-selection" });
    expect(setting("lap-times", { driver: 44 })).toEqual({ driver: 44 });
    for (const driver of [0, -3, 2.5, "44", null, true, [44]]) expect(setting("lap-times", { driver })).toEqual({});

    // Toggles, numbers and strings keep a value of the default's type (numbers within the field's range).
    const custom = defineBlock({
      ...(BUILTIN_BLOCKS.get("weather") as BlockDefinition),
      id: "custom",
      settings: { on: false, count: 3, name: "x", list: [1] },
      fields: { count: { kind: "number", label: "Count", min: 1, max: 5 } },
    });
    const parsed = (settings: Record<string, unknown>) => parseLayout(stored({ custom: entry(0, 0, 4, settings) }), new Map([[custom.id, custom as BlockDefinition]]))!.blocks.custom.settings;
    expect(parsed({ on: true, count: 4, name: "y", list: [2] })).toEqual({ on: true, count: 4, name: "y" });
    expect(parsed({ on: "yes", count: 9, name: 1 })).toEqual({});
    expect(parsed({ count: Number.NaN })).toEqual({});
  });
});

describe("rescale", () => {
  const edges = (l: Layout) => Object.fromEntries(Object.entries(l.blocks).map(([id, e]) => [id, [e.x, e.x + e.width]]));
  const adjacent = (l: Layout) => {
    const e = edges(l);
    expect(e["timing-tower"][1]).toBe(e["track-map"][0]);
    expect(e["track-map"][1]).toBe(e["driver-header"][0]);
    expect(e["speed-gear"][1]).toBe(e["throttle-brake-rpm"][0]);
    expect(e["throttle-brake-rpm"][1]).toBe(l.columns);
    for (const id of ["driver-header", "speed-trace", "lap-times", "sectors", "tyre-strip", "race-feed"]) expect(e[id]).toEqual([e["speed-gear"][0], l.columns]);
  };

  test("38 -> 19 -> 38 scales by edges, so neighbours stay adjacent", () => {
    const half = rescaleLayout(DEFAULT_LAYOUT, BUILTIN_BLOCKS, 19);
    expect(half.columns).toBe(19);
    adjacent(half);
    expect(edges(half)["timing-tower"]).toEqual([0, 5]);
    const back = rescaleLayout(half, BUILTIN_BLOCKS, 38);
    adjacent(back);
    expect(edges(back)["timing-tower"]).toEqual([0, 10]);
    // Groups, order and settings come along.
    expect(back.blocks["lap-times"]).toMatchObject({ group: "laps", y: DEFAULT_LAYOUT.blocks["lap-times"].y, settings: {} });
  });

  test("a layout saved at another column count is rescaled on load", () => {
    const half = rescaleLayout(DEFAULT_LAYOUT, BUILTIN_BLOCKS, 19);
    saveLayout(half);
    const l = loadLayout(BUILTIN_BLOCKS, DEFAULT_LAYOUT);
    expect(l.columns).toBe(COLUMNS);
    adjacent(l);
  });
});

describe("setting fields", () => {
  const base = BUILTIN_BLOCKS.get("weather") as BlockDefinition;

  test("declared fields win; driver, booleans and numbers are inferred; other settings aren't shown", () => {
    const tower = BUILTIN_BLOCKS.get("timing-tower")!;
    expect(settingField(tower, "gapMode")).toMatchObject({ kind: "choice", options: [{ value: "leader" }, { value: "interval" }] });
    expect(settingField(BUILTIN_BLOCKS.get("lap-times")!, "driver")).toEqual({ kind: "driver" });
    const b = defineBlock({ ...base, id: "custom", settings: { showGaps: true, maxRows: 5, name: "x" } });
    expect(settingField(b, "showGaps")).toEqual({ kind: "toggle", label: "Show gaps" });
    expect(settingField(b, "maxRows")).toEqual({ kind: "number", label: "Max rows" });
    expect(settingField(b, "name")).toBeNull();
    expect(settingField(b, "missing")).toBeNull();
  });

  test("defineBlock checks fields against the settings", () => {
    expect(() => defineBlock({ ...base, id: "bad", settings: {}, fields: { nope: { kind: "toggle", label: "Nope" } } as never })).toThrow("isn't a setting");
    const options = [{ value: "a", label: "A" }];
    expect(() => defineBlock({ ...base, id: "bad", settings: { mode: "b" }, fields: { mode: { kind: "choice", label: "Mode", options } } })).toThrow("isn't one of its options");
    expect(() => defineBlock({ ...base, id: "ok", settings: { mode: "a" }, fields: { mode: { kind: "choice", label: "Mode", options } } })).not.toThrow();
  });
});
