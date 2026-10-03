// The widget grid (H3.11): a fixed number of equal columns across the screen, exactly as tall as the space
// between the top bar and the timeline. A layout says where each widget goes and how wide it is; heights
// come from the widgets: fixed ones take what their contents need, and the last stretching widget in each
// column fills it to the bottom, so every column ends flush with the bottom edge. The user can give a
// widget a height of its own instead (edit mode): it then neither stretches nor follows its contents, and
// scrolls if its contents need more. The grid itself never scrolls.

import { stretches, type WidgetDefinition, type WidgetSettings, type HeightInput, type Px } from "../widgetkit/defineWidget";

/**
 * Equal columns across the grid's width. 38 fits the old fixed-width screen (tower 410 px, panel 360 px)
 * closest at 1720 px wide while the speed column still fits its contents at 1440 px (defaultLayout.ts).
 * Widget widths are in percent and the default layout is worked out from px, so it's the one number to tune.
 */
export const COLUMNS = 38;
/** A hairline between neighbouring widgets of different groups, in px (taken from the later widget's side). */
export const DIVIDER = 1;
/** The least height a widget can be given (edit mode): room for edit mode's name tag and handles. */
export const MIN_HEIGHT = 40;
/**
 * Rows for heights set in edit mode, in px: a height resize snaps the widget's edge to a line every ROW px
 * from the grid's top (or to its bottom), as a width resize snaps to columns. Fixed px, not a share of the
 * grid, so a height doesn't change with the window.
 */
export const ROW = 20;

/**
 * The stored layout (H3.11): one per browser. Its keys name what's placed, and a widget can be placed more
 * than once. Heights are derived unless set.
 */
export interface Layout {
  version: 1;
  columns: number;
  widgets: Record<string, LayoutEntry>;
}

export interface LayoutEntry {
  /**
   * The widget this places when the key isn't its id: the first of a kind is keyed by its widget's id, more
   * by `<widget id>:<n>` (widgetIdOf()).
   */
  widget?: string;
  widgetVersion: string;
  /** Column of the left edge. */
  x: number;
  /** Order from the top: widgets settle upwards in order of y, then x, onto what's above them. */
  y: number;
  /** In columns. */
  width: number;
  /** In px, set in edit mode: the widget is this tall instead of its own height (and doesn't stretch). */
  height?: number;
  /** Widgets in the same group read as one panel: no divider between them. By default each widget is its own. */
  group?: string;
  settings: Partial<WidgetSettings>;
}

/** The session and selection part of HeightInput (the widget's settings are added per widget). */
export type GridInput = Omit<HeightInput, "settings">;

/** Where a widget ends up: x and width in columns, top and height in px. */
export interface Placement {
  /** Its key in the layout. */
  id: string;
  widget: WidgetDefinition;
  x: number;
  width: number;
  top: number;
  height: number;
  /**
   * What the widget's contents take: its own height, or a stretching widget's minimum. A box shorter than
   * that (a height set in edit mode) keeps its contents at this height and scrolls.
   */
  contentHeight: number;
  stretch: boolean;
  /** Hairlines on the widget's top and left edges (inside its box, before `top` / at its left edge). */
  dividerTop: boolean;
  dividerLeft: boolean;
}

/** The id of the widget that `layout.widgets[key]` places. */
export const widgetIdOf = (key: string, entry: Pick<LayoutEntry, "widget">) => entry.widget ?? key;

const px = (value: Px, input: HeightInput) => {
  const v = typeof value === "function" ? value(input) : value;
  return Number.isFinite(v) && v > 0 ? v : 0;
};

/** A widget's width range in whole columns (at least one). */
export function columnRange(widget: WidgetDefinition, columns: number): { min: number; max: number } {
  const cols = (pct: number) => Math.min(Math.max(Math.round((pct * columns) / 100), 1), columns);
  const min = cols(widget.width.min);
  return { min, max: Math.max(cols(widget.width.max), min) };
}

const overlaps = (a: { x: number; width: number }, b: { x: number; width: number }) => a.x < b.x + b.width && b.x < a.x + a.width;
const EPS = 1e-6;

/**
 * Places the layout's widgets in a grid `gridHeight` px tall: widths clamped to each widget's range and the
 * grid, every widget settled upwards (in order of y, then x) onto the widgets above it, stretching widgets at
 * their minimum, and then the last stretching widget of each column grown to fill it (pushing down what's
 * under it). A stretching widget grows only if it's the last in every column it spans, by the least room
 * any of them has. A widget with a height of its own is that tall and doesn't stretch. Without a stretching
 * widget, a column keeps its space at the bottom; if the widgets don't fit, the bottom is cut off. Widgets the
 * app doesn't have are left out.
 */
export function pack(layout: Layout, widgets: ReadonlyMap<string, WidgetDefinition>, input: GridInput, gridHeight: number): Placement[] {
  const items = Object.entries(layout.widgets)
    .filter(([id, entry]) => widgets.has(widgetIdOf(id, entry)))
    .sort(([, a], [, b]) => a.y - b.y || a.x - b.x)
    .map(([id, entry]) => {
      const widget = widgets.get(widgetIdOf(id, entry))!;
      const range = columnRange(widget, layout.columns);
      const width = Math.min(Math.max(entry.width, range.min), range.max);
      const x = Math.min(Math.max(entry.x, 0), layout.columns - width);
      const at: HeightInput = { ...input, settings: { ...widget.settings, ...entry.settings } as WidgetSettings };
      const contentHeight = px(stretches(widget) ? (widget.height as { min: Px }).min : (widget.height as Px), at);
      const chosen = entry.height != null && Number.isFinite(entry.height) && entry.height > 0 ? entry.height : null;
      const stretch = chosen == null && stretches(widget);
      return { id, widget, x, width, group: entry.group ?? id, stretch, height: chosen ?? contentHeight, contentHeight };
    });

  // Tops from the heights: each widget rests on the lowest bottom above it, a hairline lower if any widget
  // it rests on is in another group.
  const settle = () =>
    items.reduce<(Placement & { group: string })[]>((placed, it) => {
      const above = placed.filter((p) => overlaps(p, it));
      const rest = Math.max(0, ...above.map((p) => p.top + p.height));
      const dividerTop = above.some((p) => Math.abs(p.top + p.height - rest) < EPS && p.group !== it.group);
      placed.push({ ...it, top: rest + (dividerTop ? DIVIDER : 0), dividerTop, dividerLeft: false });
      return placed;
    }, []);

  let placed = settle();
  items.forEach((it, i) => {
    if (!it.stretch) return;
    // The last stretching widget in each of its columns (none after it overlaps it).
    if (items.some((later, j) => j > i && later.stretch && overlaps(later, it))) return;
    let room = Infinity;
    for (let c = it.x; c < it.x + it.width; c++) {
      const bottom = Math.max(0, ...placed.filter((p) => p.x <= c && c < p.x + p.width).map((p) => p.top + p.height));
      room = Math.min(room, gridHeight - bottom);
    }
    if (room > 0) {
      it.height += room;
      placed = settle();
    }
  });

  return placed.map(({ group, ...p }) => ({
    ...p,
    dividerLeft: placed.some((q) => q.x + q.width === p.x && q.top < p.top + p.height && p.top < q.top + q.height && q.group !== group),
  }));
}

/** A placed widget in screen px, its hairlines included. */
export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Screen boxes for `gridWidth` px. Column edges are rounded once and shared by neighbours, so widgets side
 * by side meet exactly; vertically, a box is its widget's height (plus the hairline above it, if any).
 */
export function boxesOf(placements: readonly Placement[], gridWidth: number, columns: number): Box[] {
  const colEdge = (c: number) => Math.round((c * gridWidth) / columns);
  return placements.map((p) => {
    const left = colEdge(p.x);
    const divider = p.dividerTop ? DIVIDER : 0;
    return { left, width: colEdge(p.x + p.width) - left, top: p.top - divider, height: p.height + divider };
  });
}
