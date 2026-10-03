import { describe, expect, test } from "bun:test";
import type { WidgetDefinition, HeightInput } from "../widgetkit/defineWidget";
import type { Track } from "../widgetkit/select";
import type { DriverInfo } from "../types";
import { BUILTIN_WIDGETS } from "./builtins";
import { DEFAULT_LAYOUT, PRACTICE_LAYOUT } from "./defaultLayout";
import { DRIVER_LAYOUT } from "./driverLayout";
import { boxesOf, COLUMNS, columnRange, DIVIDER, pack, type GridInput, type Layout, type Placement } from "./layout";

const widget = (id: string, height: WidgetDefinition["height"], width = { min: 10, default: 20, max: 50 }) =>
  ({ id, name: id, version: "1.0.0", height, width, sessions: ["race"], settings: {}, Component: () => null }) as WidgetDefinition;
const at = (x: number, y: number, width: number, group?: string) => ({ widgetVersion: "1.0.0", x, y, width, group, settings: {} });

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
  const widgets = new Map(
    [
      widget("a", 100),
      widget("b", 50),
      widget("fill", { min: 80 }),
      widget("fill2", { min: 40 }),
      widget("wide", 30, { min: 50, default: 50, max: 50 }),
      widget("chips", ({ selection }) => (selection.selected.length > 0 ? 60 : 20)),
    ].map((b) => [b.id, b]),
  );
  const layout = (entries: Layout["widgets"]): Layout => ({ version: 1, columns: 10, widgets: entries });

  test("fixed widgets stack at their heights, with a hairline between groups and none inside one", () => {
    const p = byId(pack(layout({ a: at(0, 0, 2), b: at(0, 1, 2, "g"), chips: at(0, 2, 2, "g") }), widgets, input(), 1000));
    expect([p.a.top, p.a.height, p.a.dividerTop]).toEqual([0, 100, false]);
    expect([p.b.top, p.b.dividerTop]).toEqual([100 + DIVIDER, true]);
    expect([p.chips.top, p.chips.dividerTop]).toEqual([bottom(p.b), false]);
  });

  test("widgets settle upwards onto what's above them, in order of y then x", () => {
    const p = byId(pack(layout({ a: at(0, 0, 2), b: at(0, 30, 2), chips: at(2, 9, 2) }), widgets, input(), 1000));
    expect(p.b.top).toBe(100 + DIVIDER);
    expect(p.chips.top).toBe(0);
  });

  test("the last stretching widget in a column fills it to the bottom and pushes what's under it down", () => {
    const p = byId(pack(layout({ fill: at(0, 0, 2), a: at(0, 1, 2), fill2: at(2, 0, 2) }), widgets, input(), 600));
    expect(bottom(p.a)).toBe(600);
    expect(p.fill.height).toBe(600 - 100 - DIVIDER);
    expect(bottom(p.fill2)).toBe(600);
  });

  test("only the last stretching widget in a column grows; the others keep their minimum", () => {
    const p = byId(pack(layout({ fill2: at(0, 0, 2), fill: at(0, 1, 2) }), widgets, input(), 600));
    expect(p.fill2.height).toBe(40);
    expect(bottom(p.fill)).toBe(600);
  });

  test("a stretching widget across columns grows by the least room any of them has", () => {
    const p = byId(pack(layout({ a: at(0, 0, 2), b: at(2, 0, 2), fill: at(0, 1, 4) }), widgets, input(), 600));
    expect(p.fill.top).toBe(100 + DIVIDER);
    expect(bottom(p.fill)).toBe(600);
  });

  test("when the widgets don't fit, stretching widgets keep their minimum (the bottom is cut off)", () => {
    const p = byId(pack(layout({ a: at(0, 0, 2), fill: at(0, 1, 2) }), widgets, input(), 120));
    expect(p.fill.height).toBe(80);
  });

  test("a widget with a height of its own is that tall and doesn't stretch; its contents keep what they take", () => {
    const p = byId(pack(layout({ fill: { ...at(0, 0, 2), height: 300 }, a: { ...at(2, 0, 2), height: 60 }, b: at(2, 1, 2) }), widgets, input(), 600));
    expect([p.fill.height, p.fill.stretch, p.fill.contentHeight]).toEqual([300, false, 80]);
    // Shorter than its contents: the box scrolls (Grid), and what's under it rests on the box.
    expect([p.a.height, p.a.contentHeight]).toEqual([60, 100]);
    expect(p.b.top).toBe(60 + DIVIDER);
    // Without one, a widget's contents take its own height (a stretching widget's minimum).
    const auto = byId(pack(layout({ fill: at(0, 0, 2), a: at(2, 0, 2) }), widgets, input(), 600));
    expect([auto.fill.height, auto.fill.contentHeight, auto.a.contentHeight]).toEqual([600, 80, 100]);
  });

  test("heights can depend on the selection", () => {
    const l = layout({ chips: at(0, 0, 2) });
    expect(pack(l, widgets, input(), 500)[0].height).toBe(20);
    expect(pack(l, widgets, input(22, [1]), 500)[0].height).toBe(60);
  });

  test("hairlines on the left edge only next to another group", () => {
    const p = byId(pack(layout({ a: at(0, 0, 2, "g"), b: at(2, 0, 2, "g"), chips: at(4, 0, 2) }), widgets, input(), 500));
    expect([p.a.dividerLeft, p.b.dividerLeft, p.chips.dividerLeft]).toEqual([false, false, true]);
  });

  test("widths (percent of the grid) snap to whole columns and clamp; unknown widgets are left out", () => {
    expect(columnRange(widgets.get("wide")!, 10)).toEqual({ min: 5, max: 5 });
    const placed = pack(layout({ wide: at(9, 0, 1), gone: at(0, 0, 2) }), widgets, input(), 500);
    expect(placed.map((p) => [p.id, p.x, p.width])).toEqual([["wide", 5, 5]]);
  });
});

describe("default layout", () => {
  // Arranged on a 1512 px wide window, whose grid is 776 px tall; from 767 (1440x900's grid) up.
  const heights = [767, 776, 947, 1427];
  const states = [input(), input(22, [63, 12]), input(22, [63, 12], 63), input(20, [1])];

  test("the tower, map and feed, and the analysis widgets, once each and within their width ranges", () => {
    expect(Object.keys(DEFAULT_LAYOUT.widgets).sort()).toEqual(["battles", "gap-chart", "pit-strategy", "race-feed", "stint-pace", "timing-tower", "track-map"]);
    expect(DEFAULT_LAYOUT.columns).toBe(COLUMNS);
    for (const [id, e] of Object.entries(DEFAULT_LAYOUT.widgets)) {
      const { min, max } = columnRange(BUILTIN_WIDGETS.get(id)!, COLUMNS);
      expect(e.width).toBeGreaterThanOrEqual(min);
      expect(e.width).toBeLessThanOrEqual(max);
    }
  });

  test("every column ends flush with the bottom, and no widgets overlap", () => {
    for (const h of heights) {
      for (const s of states) {
        const placed = pack(DEFAULT_LAYOUT, BUILTIN_WIDGETS, s, h);
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

  test("as arranged: tower and map 21 rows, the gap chart at its least over the stint pace, the feed full height", () => {
    const p = byId(pack(DEFAULT_LAYOUT, BUILTIN_WIDGETS, input(), 776));
    expect([p["timing-tower"].height, p["track-map"].height]).toEqual([420, 420]);
    // Under them, each below its hairline.
    for (const id of ["gap-chart", "battles", "pit-strategy"]) expect(p[id].top).toBe(421);
    expect(p["gap-chart"].height).toBe(p["gap-chart"].contentHeight);
    expect(p["stint-pace"].top).toBe(bottom(p["gap-chart"]) + 1);
    expect(p["race-feed"].top).toBe(0);
    for (const id of ["stint-pace", "battles", "pit-strategy", "race-feed"]) expect(bottom(p[id])).toBe(776);
  });

  test("the bottom row fits from a 738 px grid; below that it's cut off", () => {
    const fitsIn = (h: number) => pack(DEFAULT_LAYOUT, BUILTIN_WIDGETS, input(), h).every((p) => bottom(p) <= h + 1e-6);
    expect(fitsIn(738)).toBe(true);
    expect(fitsIn(737)).toBe(false);
  });
});

describe("driver layout", () => {
  // The old screen: the tower and map full height; on the right the header, telemetry, laps, tyres, feed.
  // From about 610 px (the driver panel and the feed's minimum) up.
  const heights = [610, 767, 947, 1427];
  const states = [input(), input(22, [63, 12]), input(22, [63, 12], 63), input(20, [1])];
  // Weather is in the top bar; the analysis widgets (and practice's long runs) came after it.
  const NOT_IN_IT = ["weather", "gap-chart", "stint-pace", "pit-strategy", "battles", "long-runs"];

  test("places every built-in widget but those off its screen once, within its width range", () => {
    expect(Object.keys(DRIVER_LAYOUT.widgets).sort()).toEqual([...BUILTIN_WIDGETS.keys()].filter((id) => !NOT_IN_IT.includes(id)).sort());
    expect(DRIVER_LAYOUT.columns).toBe(COLUMNS);
    for (const [id, e] of Object.entries(DRIVER_LAYOUT.widgets)) {
      const { min, max } = columnRange(BUILTIN_WIDGETS.get(id)!, COLUMNS);
      expect(e.width).toBeGreaterThanOrEqual(min);
      expect(e.width).toBeLessThanOrEqual(max);
    }
  });

  test("every column ends flush with the bottom, and no widgets overlap", () => {
    for (const h of heights) {
      for (const s of states) {
        const placed = pack(DRIVER_LAYOUT, BUILTIN_WIDGETS, s, h);
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
    const p = byId(pack(DRIVER_LAYOUT, BUILTIN_WIDGETS, input(22, [63, 12], 63), 1427));
    expect(p["timing-tower"].height).toBe(1427);
    expect(p["track-map"].height).toBe(1427);
    // Measured on the old screen (07d720a): chips 33 + header 70.2, telemetry 175.28, laps 87.56, tyres 53. Then the
    // labels went from 10 to 11 px (DESIGN.md), a line of them 10/7 px taller: one in the 60 s trace's title, one
    // in the lap times; and the sectors' line became 16 px (16.28 measured before).
    const label = (11 - 10) * (20 / 14);
    expect(p["driver-header"].height).toBeCloseTo(103.21, 1);
    expect(bottom(p["speed-trace"]) - p["driver-header"].height).toBeCloseTo(175.28 + label, 1);
    // The old tyre section began at 418.05 px on screen (52 px top bar), its hairline included.
    expect(p["tyre-strip"].top).toBeCloseTo(418.05 + 1 - 52 + 2 * label - 0.28, 1);
    expect(bottom(p["race-feed"])).toBe(1427);
  });

  test("hairlines only where the old screen had them", () => {
    const p = byId(pack(DRIVER_LAYOUT, BUILTIN_WIDGETS, input(22, [63, 12], 63), 900));
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

describe("practice's default layout", () => {
  // From 610 px up; 767 is 1440x900's grid and 867 1720x1000's (the user's window).
  const heights = [610, 767, 867, 947, 1427];
  const states = [input(), input(22, [63, 12]), input(22, [63, 12], 63), input(20, [1])];

  test("the tower, map and feed, long runs and stint pace, once each and within their width ranges", () => {
    expect(Object.keys(PRACTICE_LAYOUT.widgets).sort()).toEqual(["long-runs", "race-feed", "stint-pace", "timing-tower", "track-map"]);
    expect(PRACTICE_LAYOUT.columns).toBe(COLUMNS);
    for (const [id, e] of Object.entries(PRACTICE_LAYOUT.widgets)) {
      const widget = BUILTIN_WIDGETS.get(id)!;
      expect(widget.sessions).toContain("practice");
      const { min, max } = columnRange(widget, COLUMNS);
      expect(e.width).toBeGreaterThanOrEqual(min);
      expect(e.width).toBeLessThanOrEqual(max);
    }
  });

  test("every column ends flush with the bottom, and no widgets overlap", () => {
    for (const h of heights) {
      for (const s of states) {
        const placed = pack(PRACTICE_LAYOUT, BUILTIN_WIDGETS, s, h);
        expect(placed).toHaveLength(Object.keys(PRACTICE_LAYOUT.widgets).length);
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

  test("the race screen's top (tower, map, feed), with long runs under the tower and the stint pace under the map", () => {
    const race = byId(pack(DEFAULT_LAYOUT, BUILTIN_WIDGETS, input(), 767));
    const p = byId(pack(PRACTICE_LAYOUT, BUILTIN_WIDGETS, input(), 767));
    for (const id of ["timing-tower", "track-map", "race-feed"]) {
      expect([p[id].x, p[id].width, p[id].top, p[id].height]).toEqual([race[id].x, race[id].width, race[id].top, race[id].height]);
    }
    // Practice's tower shows the gap to the fastest lap (the widget's default), not the race's interval.
    expect(PRACTICE_LAYOUT.widgets["timing-tower"].settings).toEqual({});
    expect([p["long-runs"].x, p["long-runs"].width]).toEqual([p["timing-tower"].x, p["timing-tower"].width]);
    expect([p["stint-pace"].x, p["stint-pace"].width]).toEqual([p["track-map"].x, p["track-map"].width]);
    for (const id of ["long-runs", "stint-pace"]) {
      expect(p[id].top).toBe(421);
      expect(bottom(p[id])).toBe(767);
    }
  });

  test("readable at 1440x900 and 1720x1000: long runs over 560 px wide and 340 px tall", () => {
    for (const [width, h] of [
      [1440, 767],
      [1720, 867],
    ]) {
      const placed = pack(PRACTICE_LAYOUT, BUILTIN_WIDGETS, input(22, [63, 12], 63), h);
      const boxes = boxesOf(placed, width, COLUMNS);
      const box = (id: string) => boxes[placed.findIndex((q) => q.id === id)];
      expect(box("long-runs").width).toBeGreaterThanOrEqual(560);
      expect(box("long-runs").height).toBeGreaterThanOrEqual(340);
      expect(box("stint-pace").width).toBeGreaterThanOrEqual(560);
    }
  });

  test("the bottom row fits from a 581 px grid; below that it's cut off", () => {
    const fitsIn = (h: number) => pack(PRACTICE_LAYOUT, BUILTIN_WIDGETS, input(), h).every((q) => bottom(q) <= h + 1e-6);
    expect(fitsIn(581)).toBe(true);
    expect(fitsIn(580)).toBe(false);
  });

  test("neighbours never overlap at any width from 1000 to 2560 px", () => {
    const placed = pack(PRACTICE_LAYOUT, BUILTIN_WIDGETS, input(22, [63, 12]), 800);
    for (let width = 1000; width <= 2560; width++) {
      const boxes = boxesOf(placed, width, COLUMNS);
      for (let i = 0; i < boxes.length; i++) {
        const a = boxes[i];
        expect(a.width).toBeGreaterThan(0);
        for (let j = i + 1; j < boxes.length; j++) {
          const b = boxes[j];
          const overlap = a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height - 1e-9 && b.top < a.top + a.height - 1e-9;
          if (overlap) throw new Error(`${placed[i].id} overlaps ${placed[j].id} at ${width} px`);
        }
      }
    }
  });
});

describe("boxes", () => {
  test("neighbours never overlap at any width from 1000 to 2560 px", () => {
    for (const s of [input(), input(22, [63, 12])]) {
      const placed = pack(DRIVER_LAYOUT, BUILTIN_WIDGETS, s, 800);
      for (let width = 1000; width <= 2560; width++) {
        const boxes = boxesOf(placed, width, DRIVER_LAYOUT.columns);
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

  test("side by side widgets meet exactly; a box includes the hairline above its widget", () => {
    const placed = pack(DRIVER_LAYOUT, BUILTIN_WIDGETS, input(), 800);
    const boxes = boxesOf(placed, 1720, COLUMNS);
    const box = (id: string) => boxes[placed.findIndex((p) => p.id === id)];
    expect(box("speed-gear").left + box("speed-gear").width).toBe(box("throttle-brake-rpm").left);
    expect(box("timing-tower").left + box("timing-tower").width).toBe(box("track-map").left);
    expect(box("speed-gear").top).toBeCloseTo(box("driver-header").top + box("driver-header").height, 6);
  });

  test("its widths at 1720 px are the old screen's, to the nearest column", () => {
    const placed = pack(DRIVER_LAYOUT, BUILTIN_WIDGETS, input(), 800);
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
