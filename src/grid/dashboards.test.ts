import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { BUILTIN_WIDGETS } from "./builtins";
import {
  activeOf,
  addOwn,
  dashboardList,
  DASHBOARDS_KEY,
  emptyDashboards,
  FIRST,
  freeName,
  layoutOf,
  loadDashboards,
  parseDashboards,
  PRESETS,
  remove,
  rename,
  resetPreset,
  saveDashboards,
  setActive,
  withLayout,
} from "./dashboards";
import { DRIVER_LAYOUT } from "./driverLayout";
import { columnRange, COLUMNS, widgetIdOf, type Layout } from "./layout";
import { parseLayout, storageKey, type GridKind } from "./storage";

const items = new Map<string, string>();
const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
beforeEach(() => {
  items.clear();
  Object.defineProperty(globalThis, "localStorage", {
    value: { getItem: (k: string) => items.get(k) ?? null, setItem: (k: string, v: string) => void items.set(k, String(v)), removeItem: (k: string) => void items.delete(k) },
    configurable: true,
    writable: true,
  });
});
afterEach(() => {
  if (original) Object.defineProperty(globalThis, "localStorage", original);
  else delete (globalThis as { localStorage?: unknown }).localStorage;
});

const KINDS: GridKind[] = ["race", "practice"];
/** The driver panel layout, which race and practice both show. */
const MINE: Layout = DRIVER_LAYOUT;

describe("presets", () => {
  test("every preset reads back as it ships: its widgets show its kind, at widths in their range", () => {
    for (const kind of KINDS) {
      for (const p of PRESETS[kind]) {
        expect(parseLayout(p.layout, BUILTIN_WIDGETS, COLUMNS, kind)).toEqual(p.layout);
        for (const [id, e] of Object.entries(p.layout.widgets)) {
          const range = columnRange(BUILTIN_WIDGETS.get(widgetIdOf(id, e))!, COLUMNS);
          expect(e.width).toBeGreaterThanOrEqual(range.min);
          expect(e.width).toBeLessThanOrEqual(range.max);
          expect(e.x + e.width).toBeLessThanOrEqual(COLUMNS);
        }
      }
    }
  });

  test("each kind starts on its first, and their ids are distinct", () => {
    for (const kind of KINDS) {
      expect(PRESETS[kind][0].id).toBe(FIRST);
      expect(new Set(PRESETS[kind].map((p) => p.id)).size).toBe(PRESETS[kind].length);
    }
  });
});

describe("editing the list", () => {
  test("a preset edited keeps its place, and comes back as it ships on reset", () => {
    let d = withLayout(emptyDashboards(), "race", "strategy", MINE);
    expect(layoutOf(d, "race", "strategy")).toEqual(MINE);
    expect(layoutOf(d, "practice", "strategy")).toBe(PRESETS.practice[0].layout);
    expect(dashboardList(d, "race").map((i) => i.id)).toEqual(PRESETS.race.map((p) => p.id));
    d = resetPreset(d, "race", "strategy");
    expect(layoutOf(d, "race", "strategy")).toBe(PRESETS.race[1].layout);
  });

  test("one of the user's own is added after the presets and shown; renamed; deleted, the first is shown", () => {
    let [d, id] = addOwn(emptyDashboards(), "race", "Quali sims", MINE);
    expect(id).toBe("my-1");
    expect(d.race.active).toBe(id);
    expect(dashboardList(d, "race").at(-1)).toEqual({ id, name: "Quali sims", preset: false });
    expect(dashboardList(d, "practice").some((i) => i.id === id)).toBe(false);
    d = rename(d, "race", id, "  Pace  ");
    expect(dashboardList(d, "race").at(-1)?.name).toBe("Pace");
    expect(rename(d, "race", id, "   ")).toBe(d);
    // Presets keep their names and can't be deleted.
    expect(rename(d, "race", "overview", "Mine").race).toEqual(d.race);
    expect(remove(d, "race", "overview")).toBe(d);
    d = remove(d, "race", id);
    expect(d.race.own).toEqual([]);
    expect(d.race.active).toBe(FIRST);
  });

  test("ids aren't reused across kinds; new names don't take one in use", () => {
    const [d] = addOwn(emptyDashboards(), "race", "", MINE);
    expect(d.race.own[0].name).toBe("My dashboard");
    const [, practiceId] = addOwn(d, "practice", "x", MINE);
    expect(practiceId).toBe("my-2");
    expect(freeName(d, "race", "My dashboard")).toBe("My dashboard 2");
    expect(freeName(d, "race", "strategy")).toBe("strategy 2");
    expect(freeName(d, "practice", "My dashboard")).toBe("My dashboard");
  });

  test("only a dashboard the kind has is made active; one that's gone falls back to the first", () => {
    const d = emptyDashboards();
    expect(setActive(d, "race", "nope")).toBe(d);
    expect(setActive(d, "practice", "strategy")).toBe(d);
    expect(activeOf({ ...d, race: { ...d.race, active: "my-9" } }, "race")).toBe(FIRST);
  });
});

describe("storage", () => {
  test("round trip", () => {
    let [d] = addOwn(emptyDashboards(), "practice", "Long runs", MINE);
    d = withLayout(d, "race", "telemetry", MINE);
    saveDashboards(d);
    expect(loadDashboards(BUILTIN_WIDGETS)).toEqual(d);
  });

  test("the first time, the layouts saved before dashboards become each kind's Overview", () => {
    items.set(storageKey("race"), JSON.stringify(MINE));
    const d = loadDashboards(BUILTIN_WIDGETS);
    expect(d.race.edited).toEqual({ [FIRST]: MINE });
    expect(d.practice.edited).toEqual({});
    expect(layoutOf(d, "race", activeOf(d, "race"))).toEqual(MINE);
    // Once dashboards are saved, the old layout isn't read again.
    saveDashboards(resetPreset(d, "race", FIRST));
    expect(loadDashboards(BUILTIN_WIDGETS).race.edited).toEqual({});
  });

  test("what can't be used is dropped, the rest kept", () => {
    const raw = {
      version: 1,
      race: {
        active: "my-3",
        edited: { strategy: MINE, nope: MINE, telemetry: { version: 1, columns: COLUMNS, widgets: { "no-such-widget": {} } } },
        own: [
          { id: "my-3", name: "Ok", layout: MINE },
          { id: "my-3", name: "Twice", layout: MINE },
          { id: "overview", name: "A preset's id", layout: MINE },
          { id: "Bad Id", name: "x", layout: MINE },
          { id: "my-4", name: 7, layout: null },
        ],
      },
      practice: "nonsense",
    };
    const d = parseDashboards(raw, BUILTIN_WIDGETS)!;
    expect(Object.keys(d.race.edited)).toEqual(["strategy"]);
    expect(d.race.own.map((o) => [o.id, o.name])).toEqual([
      ["my-3", "Ok"],
      ["my-4", "My dashboard"],
    ]);
    expect(d.race.own[1].layout).toBe(PRESETS.race[0].layout);
    expect(d.race.active).toBe("my-3");
    expect(d.practice).toEqual(emptyDashboards().practice);
    expect(parseDashboards({ version: 2 }, BUILTIN_WIDGETS)).toBeNull();
  });

  test("corrupt or unreadable storage: nothing lost but what's unreadable, and it never throws", () => {
    items.set(DASHBOARDS_KEY, "{not json");
    expect(loadDashboards(BUILTIN_WIDGETS)).toEqual(emptyDashboards());
    Object.defineProperty(globalThis, "localStorage", {
      value: {
        getItem: () => {
          throw new Error("SecurityError");
        },
        setItem: () => {
          throw new Error("SecurityError");
        },
      },
      configurable: true,
    });
    expect(loadDashboards(BUILTIN_WIDGETS)).toEqual(emptyDashboards());
    expect(() => saveDashboards(emptyDashboards())).not.toThrow();
  });
});
