import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { defineWidget, settingField, type WidgetDefinition } from "../widgetkit/defineWidget";
import { BUILTIN_WIDGETS } from "./builtins";
import { DEFAULT_LAYOUT, DEFAULT_LAYOUTS } from "./defaultLayout";
import { DRIVER_LAYOUT } from "./driverLayout";
import { COLUMNS, MIN_HEIGHT, type Layout } from "./layout";
import { clearSavedLayout, loadLayout, parseLayout, rescaleLayout, saveLayout, STORAGE_KEY, storageKey } from "./storage";

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

const stored = (widgets: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ version: 1, columns: COLUMNS, widgets, ...extra });
const entry = (x: number, y: number, width: number, settings: Record<string, unknown> = {}, widgetVersion = "1.0.0") => ({ widgetVersion, x, y, width, settings });

describe("load and save", () => {
  test("round trip: what's saved comes back as it was", () => {
    saveLayout(DRIVER_LAYOUT);
    expect(storage.items.has(STORAGE_KEY)).toBe(true);
    expect(loadLayout(BUILTIN_WIDGETS, DRIVER_LAYOUT)).toEqual(DRIVER_LAYOUT);
    const tweaked: Layout = { ...DRIVER_LAYOUT, widgets: { ...DRIVER_LAYOUT.widgets, "timing-tower": { ...DRIVER_LAYOUT.widgets["timing-tower"], settings: { gapMode: "interval" } } } };
    saveLayout(tweaked);
    expect(loadLayout(BUILTIN_WIDGETS, DRIVER_LAYOUT)).toEqual(tweaked);
  });

  test("a height of its own comes back as it was; one that isn't a number is dropped, and it's at least MIN_HEIGHT", () => {
    const sized: Layout = { ...DRIVER_LAYOUT, widgets: { ...DRIVER_LAYOUT.widgets, "timing-tower": { ...DRIVER_LAYOUT.widgets["timing-tower"], height: 480 } } };
    saveLayout(sized);
    expect(loadLayout(BUILTIN_WIDGETS, DRIVER_LAYOUT)).toEqual(sized);
    const read = (height: unknown) => parseLayout(stored({ "timing-tower": { ...entry(0, 0, 9), height } }), BUILTIN_WIDGETS)!.widgets["timing-tower"];
    expect(read("480")).not.toHaveProperty("height");
    expect(read(null)).not.toHaveProperty("height");
    expect(read(Number.POSITIVE_INFINITY)).not.toHaveProperty("height");
    expect(read(-5).height).toBe(MIN_HEIGHT);
    expect(read(212.6).height).toBe(212.6);
  });

  test("more than one of a widget comes back; copies of widgets the app doesn't have are dropped", () => {
    const tower = DRIVER_LAYOUT.widgets["timing-tower"];
    const two: Layout = { ...DRIVER_LAYOUT, widgets: { ...DRIVER_LAYOUT.widgets, "lap-times:2": { ...DRIVER_LAYOUT.widgets["lap-times"], widget: "lap-times", y: 10, settings: { driver: 44 } } } };
    saveLayout(two);
    expect(loadLayout(BUILTIN_WIDGETS, DRIVER_LAYOUT)).toEqual(two);
    const read = parseLayout(stored({ "timing-tower": entry(0, 0, 9), "x:2": { ...entry(0, 1, 9), widget: "nope" }, "tower-copy": { ...entry(0, 2, 9), widget: "timing-tower" } }), BUILTIN_WIDGETS)!;
    expect(Object.keys(read.widgets).sort()).toEqual(["timing-tower", "tower-copy"]);
    expect(read.widgets["tower-copy"]).toMatchObject({ widget: "timing-tower", width: tower.width });
  });

  test("nothing saved, corrupt JSON, the wrong version or a broken shape: the fallback", () => {
    expect(loadLayout(BUILTIN_WIDGETS, DRIVER_LAYOUT)).toBe(DRIVER_LAYOUT);
    for (const raw of [
      "{not json",
      "null",
      "[]",
      JSON.stringify({ ...DRIVER_LAYOUT, version: 2 }),
      JSON.stringify({ ...DRIVER_LAYOUT, columns: 0 }),
      JSON.stringify({ ...DRIVER_LAYOUT, columns: "38" }),
      JSON.stringify({ ...DRIVER_LAYOUT, widgets: [] }),
      JSON.stringify(stored({ "timing-tower": { ...entry(0, 0, 9), x: "0" } })),
      JSON.stringify(stored({ "timing-tower": { ...entry(0, 0, 9), settings: null } })),
      JSON.stringify(stored({ "timing-tower": { ...entry(0, 0, 9), group: 3 } })),
      JSON.stringify(stored({ "timing-tower": { ...entry(0, 0, 9), widget: 7 } })),
      JSON.stringify(stored({ "timing-tower": entry(0, Number.NaN, 9) })),
    ]) {
      storage.items.set(STORAGE_KEY, raw);
      expect(loadLayout(BUILTIN_WIDGETS, DRIVER_LAYOUT)).toBe(DRIVER_LAYOUT);
    }
  });

  test("never throws: storage missing or throwing", () => {
    useStorage(fakeStorage(true));
    expect(loadLayout(BUILTIN_WIDGETS, DRIVER_LAYOUT)).toBe(DRIVER_LAYOUT);
    expect(() => saveLayout(DRIVER_LAYOUT)).not.toThrow();
    expect(() => clearSavedLayout()).not.toThrow();
    useStorage(undefined);
    expect(loadLayout(BUILTIN_WIDGETS, DRIVER_LAYOUT)).toBe(DRIVER_LAYOUT);
    expect(() => saveLayout(DRIVER_LAYOUT)).not.toThrow();
    expect(() => clearSavedLayout()).not.toThrow();
  });

  test("practice has a layout of its own, of widgets that show practice", () => {
    saveLayout(DEFAULT_LAYOUT);
    expect(storageKey("practice")).not.toBe(STORAGE_KEY);
    expect(loadLayout(BUILTIN_WIDGETS, DEFAULT_LAYOUTS.practice, "practice")).toBe(DEFAULT_LAYOUTS.practice);
    // Practice's own widgets don't go into a race layout.
    storage.items.set(STORAGE_KEY, JSON.stringify(DEFAULT_LAYOUTS.practice));
    expect(loadLayout(BUILTIN_WIDGETS, DEFAULT_LAYOUT, "race").widgets["long-runs"]).toBeUndefined();
    expect(loadLayout(BUILTIN_WIDGETS, DEFAULT_LAYOUT, "race").widgets["stint-pace"]).toBeDefined();
    // The race layout read as practice's leaves out the race-only widgets (gap chart, battles, pit stops).
    storage.items.set(storageKey("practice"), JSON.stringify(DEFAULT_LAYOUT));
    expect(Object.keys(loadLayout(BUILTIN_WIDGETS, DEFAULT_LAYOUTS.practice, "practice").widgets).sort()).toEqual(["race-feed", "stint-pace", "timing-tower", "track-map"]);
    saveLayout(DEFAULT_LAYOUT);
    expect(loadLayout(BUILTIN_WIDGETS, DEFAULT_LAYOUTS.practice, "race").widgets["gap-chart"]).toBeDefined();
    clearSavedLayout("practice");
    expect(storage.items.has(storageKey("practice"))).toBe(false);
    expect(storage.items.has(STORAGE_KEY)).toBe(true);
  });

  test("clearSavedLayout forgets it", () => {
    saveLayout(DRIVER_LAYOUT);
    clearSavedLayout();
    expect(storage.items.has(STORAGE_KEY)).toBe(false);
    expect(loadLayout(BUILTIN_WIDGETS, DRIVER_LAYOUT)).toBe(DRIVER_LAYOUT);
  });
});

describe("layouts saved before widgets were called widgets", () => {
  // Exactly what the app saved until 2026-10-02 (`blocks`, `block`, `blockVersion`): the driver-panel layout with
  // the tower on intervals and a second lap times pinned to car 44.
  const OLD = `{"version":1,"columns":38,"blocks":{
    "timing-tower":{"blockVersion":"1.0.0","x":0,"y":0,"width":9,"settings":{"gapMode":"interval"}},
    "track-map":{"blockVersion":"1.0.0","x":9,"y":0,"width":21,"settings":{}},
    "driver-header":{"blockVersion":"1.0.0","x":30,"y":0,"width":8,"settings":{}},
    "speed-gear":{"blockVersion":"1.0.0","x":30,"y":1,"width":3,"group":"telemetry","settings":{}},
    "throttle-brake-rpm":{"blockVersion":"1.0.0","x":33,"y":1,"width":5,"group":"telemetry","settings":{}},
    "speed-trace":{"blockVersion":"1.0.0","x":30,"y":2,"width":8,"group":"telemetry","settings":{}},
    "lap-times":{"blockVersion":"1.0.0","x":30,"y":3,"width":8,"group":"laps","settings":{}},
    "sectors":{"blockVersion":"1.0.0","x":30,"y":4,"width":8,"group":"laps","settings":{}},
    "tyre-strip":{"blockVersion":"1.0.0","x":30,"y":5,"width":8,"settings":{}},
    "race-feed":{"blockVersion":"1.0.0","x":30,"y":6,"width":8,"settings":{}},
    "lap-times:2":{"blockVersion":"1.0.0","x":30,"y":10,"width":8,"group":"laps","settings":{"driver":44},"block":"lap-times"}}}`;
  const NEW: Layout = {
    ...DRIVER_LAYOUT,
    widgets: {
      ...DRIVER_LAYOUT.widgets,
      "timing-tower": { ...DRIVER_LAYOUT.widgets["timing-tower"], settings: { gapMode: "interval" } },
      "lap-times:2": { ...DRIVER_LAYOUT.widgets["lap-times"], widget: "lap-times", y: 10, settings: { driver: 44 } },
    },
  };

  test("an old saved layout loads unchanged, in the new names", () => {
    storage.items.set(STORAGE_KEY, OLD);
    const loaded = loadLayout(BUILTIN_WIDGETS, DEFAULT_LAYOUT);
    expect(loaded).toEqual(NEW);
    expect(loaded).not.toHaveProperty("blocks");
    for (const e of Object.values(loaded.widgets)) {
      expect(e).not.toHaveProperty("blockVersion");
      expect(e).not.toHaveProperty("block");
    }
    // Free practice's saved layout too.
    storage.items.set(storageKey("practice"), JSON.stringify({ version: 1, columns: COLUMNS, blocks: { "long-runs": { blockVersion: "1.0.0", x: 0, y: 0, width: 15, settings: { minLaps: 8 } } } }));
    expect(loadLayout(BUILTIN_WIDGETS, DEFAULT_LAYOUTS.practice, "practice").widgets).toEqual({ "long-runs": { widgetVersion: "1.0.0", x: 0, y: 0, width: 15, settings: { minLaps: 8 } } });
  });

  test("an old blockVersion still pins: another major resets the settings", () => {
    const read = parseLayout(JSON.parse(OLD.replace('"blockVersion":"1.0.0","x":0', '"blockVersion":"0.9.0","x":0')), BUILTIN_WIDGETS)!;
    expect(read.widgets["timing-tower"]).toEqual({ ...DRIVER_LAYOUT.widgets["timing-tower"], settings: {} });
    expect(read.widgets["lap-times:2"].settings).toEqual({ driver: 44 });
  });

  test("saving writes the new names, and what's saved loads back the same", () => {
    storage.items.set(STORAGE_KEY, OLD);
    saveLayout(loadLayout(BUILTIN_WIDGETS, DEFAULT_LAYOUT));
    const raw = JSON.parse(storage.items.get(STORAGE_KEY)!);
    expect(Object.keys(raw).sort()).toEqual(["columns", "version", "widgets"]);
    expect(raw.widgets["lap-times:2"]).toEqual({ widget: "lap-times", widgetVersion: "1.0.0", x: 30, y: 10, width: 8, group: "laps", settings: { driver: 44 } });
    for (const e of Object.values(raw.widgets) as Record<string, unknown>[]) {
      expect(typeof e.widgetVersion).toBe("string");
      expect(e).not.toHaveProperty("blockVersion");
      expect(e).not.toHaveProperty("block");
    }
    expect(loadLayout(BUILTIN_WIDGETS, DEFAULT_LAYOUT)).toEqual(NEW);
  });

  test("with both names the new one wins; a broken old shape still falls back", () => {
    const both = { ...JSON.parse(OLD), widgets: { "race-feed": { widgetVersion: "1.0.0", blockVersion: "0.1.0", widget: "race-feed", block: "nope", x: 0, y: 0, width: 8, settings: {} } } };
    expect(parseLayout(both, BUILTIN_WIDGETS)!.widgets).toEqual({ "race-feed": { widgetVersion: "1.0.0", widget: "race-feed", x: 0, y: 0, width: 8, settings: {} } });
    for (const raw of [
      { version: 1, columns: COLUMNS, blocks: [] },
      { version: 1, columns: COLUMNS, blocks: { "timing-tower": { x: 0, y: 0, width: 9, settings: {} } } },
      { version: 1, columns: COLUMNS, blocks: { "timing-tower": { blockVersion: "1.0.0", block: 7, x: 0, y: 0, width: 9, settings: {} } } },
    ]) {
      storage.items.set(STORAGE_KEY, JSON.stringify(raw));
      expect(loadLayout(BUILTIN_WIDGETS, DRIVER_LAYOUT)).toBe(DRIVER_LAYOUT);
    }
  });
});

describe("parse", () => {
  const quali = defineWidget({ ...(BUILTIN_WIDGETS.get("weather") as WidgetDefinition), id: "quali-only", sessions: ["qualifying"] });
  const widgets = new Map([...BUILTIN_WIDGETS, [quali.id, quali]]);

  test("unknown widgets and widgets without race sessions are dropped; nothing left is unusable", () => {
    const l = parseLayout(stored({ "timing-tower": entry(0, 0, 9), gone: entry(9, 0, 5), "quali-only": entry(20, 0, 4) }), widgets)!;
    expect(Object.keys(l.widgets)).toEqual(["timing-tower"]);
    expect(parseLayout(stored({ gone: entry(0, 0, 5), "quali-only": entry(0, 0, 4) }), widgets)).toBeNull();
    expect(parseLayout(stored({}), widgets)).toBeNull();
  });

  test("widths clamp to the widget's range and x to the grid", () => {
    const l = parseLayout(stored({ "timing-tower": entry(0, 0, 2), "track-map": entry(36, 1, 40), "speed-gear": entry(-4, 2, 3.4) }), widgets)!;
    expect(l.widgets["timing-tower"]).toMatchObject({ x: 0, width: 8 });
    expect(l.widgets["track-map"]).toMatchObject({ x: COLUMNS - 30, width: 30 });
    expect(l.widgets["speed-gear"]).toMatchObject({ x: 0, width: 3 });
  });

  test("the same major version keeps the settings and pins the current version; another major resets them", () => {
    const l = parseLayout(
      stored({
        "timing-tower": entry(0, 0, 9, { gapMode: "interval" }, "1.4.2"),
        "lap-times": entry(30, 1, 8, { driver: 44 }, "2.0.0"),
        sectors: entry(30, 2, 8, { driver: 16 }, "not-semver"),
      }),
      widgets,
    )!;
    expect(l.widgets["timing-tower"]).toMatchObject({ widgetVersion: "1.0.0", settings: { gapMode: "interval" }, x: 0, width: 9 });
    expect(l.widgets["lap-times"]).toMatchObject({ widgetVersion: "1.0.0", settings: {}, x: 30, width: 8 });
    expect(l.widgets.sectors.settings).toEqual({});
  });

  test("settings the widget doesn't have or doesn't accept are dropped (so the default applies)", () => {
    const setting = (id: string, settings: Record<string, unknown>) => parseLayout(stored({ [id]: entry(0, 0, 9, settings) }), widgets)!.widgets[id].settings;
    expect(setting("timing-tower", { gapMode: "bogus", extra: 1 })).toEqual({});
    expect(setting("timing-tower", { gapMode: "leader" })).toEqual({ gapMode: "leader" });
    expect(setting("lap-times", { driver: "follow-selection" })).toEqual({ driver: "follow-selection" });
    expect(setting("lap-times", { driver: 44 })).toEqual({ driver: 44 });
    for (const driver of [0, -3, 2.5, "44", null, true, [44]]) expect(setting("lap-times", { driver })).toEqual({});

    // Toggles, numbers and strings keep a value of the default's type (numbers within the field's range).
    const custom = defineWidget({
      ...(BUILTIN_WIDGETS.get("weather") as WidgetDefinition),
      id: "custom",
      settings: { on: false, count: 3, name: "x", list: [1] },
      fields: { count: { kind: "number", label: "Count", min: 1, max: 5 } },
    });
    const parsed = (settings: Record<string, unknown>) => parseLayout(stored({ custom: entry(0, 0, 4, settings) }), new Map([[custom.id, custom as WidgetDefinition]]))!.widgets.custom.settings;
    expect(parsed({ on: true, count: 4, name: "y", list: [2] })).toEqual({ on: true, count: 4, name: "y" });
    expect(parsed({ on: "yes", count: 9, name: 1 })).toEqual({});
    expect(parsed({ count: Number.NaN })).toEqual({});
  });
});

describe("rescale", () => {
  const edges = (l: Layout) => Object.fromEntries(Object.entries(l.widgets).map(([id, e]) => [id, [e.x, e.x + e.width]]));
  const adjacent = (l: Layout) => {
    const e = edges(l);
    expect(e["timing-tower"][1]).toBe(e["track-map"][0]);
    expect(e["track-map"][1]).toBe(e["driver-header"][0]);
    expect(e["speed-gear"][1]).toBe(e["throttle-brake-rpm"][0]);
    expect(e["throttle-brake-rpm"][1]).toBe(l.columns);
    for (const id of ["driver-header", "speed-trace", "lap-times", "sectors", "tyre-strip", "race-feed"]) expect(e[id]).toEqual([e["speed-gear"][0], l.columns]);
  };

  test("38 -> 19 -> 38 scales by edges, so neighbours stay adjacent", () => {
    const half = rescaleLayout(DRIVER_LAYOUT, BUILTIN_WIDGETS, 19);
    expect(half.columns).toBe(19);
    adjacent(half);
    expect(edges(half)["timing-tower"]).toEqual([0, 5]);
    const back = rescaleLayout(half, BUILTIN_WIDGETS, 38);
    adjacent(back);
    expect(edges(back)["timing-tower"]).toEqual([0, 10]);
    // Groups, order and settings come along.
    expect(back.widgets["lap-times"]).toMatchObject({ group: "laps", y: DRIVER_LAYOUT.widgets["lap-times"].y, settings: {} });
  });

  test("a layout saved at another column count is rescaled on load", () => {
    const half = rescaleLayout(DRIVER_LAYOUT, BUILTIN_WIDGETS, 19);
    saveLayout(half);
    const l = loadLayout(BUILTIN_WIDGETS, DRIVER_LAYOUT);
    expect(l.columns).toBe(COLUMNS);
    adjacent(l);
  });
});

describe("setting fields", () => {
  const base = BUILTIN_WIDGETS.get("weather") as WidgetDefinition;

  test("declared fields win; driver, booleans and numbers are inferred; other settings aren't shown", () => {
    const tower = BUILTIN_WIDGETS.get("timing-tower")!;
    expect(settingField(tower, "gapMode")).toMatchObject({ kind: "choice", options: [{ value: "leader" }, { value: "interval" }] });
    expect(settingField(BUILTIN_WIDGETS.get("lap-times")!, "driver")).toEqual({ kind: "driver" });
    const b = defineWidget({ ...base, id: "custom", settings: { showGaps: true, maxRows: 5, name: "x" } });
    expect(settingField(b, "showGaps")).toEqual({ kind: "toggle", label: "Show gaps" });
    expect(settingField(b, "maxRows")).toEqual({ kind: "number", label: "Max rows" });
    expect(settingField(b, "name")).toBeNull();
    expect(settingField(b, "missing")).toBeNull();
  });

  test("defineWidget checks fields against the settings", () => {
    expect(() => defineWidget({ ...base, id: "bad", settings: {}, fields: { nope: { kind: "toggle", label: "Nope" } } as never })).toThrow("isn't a setting");
    const options = [{ value: "a", label: "A" }];
    expect(() => defineWidget({ ...base, id: "bad", settings: { mode: "b" }, fields: { mode: { kind: "choice", label: "Mode", options } } })).toThrow("isn't one of its options");
    expect(() => defineWidget({ ...base, id: "ok", settings: { mode: "a" }, fields: { mode: { kind: "choice", label: "Mode", options } } })).not.toThrow();
  });
});
