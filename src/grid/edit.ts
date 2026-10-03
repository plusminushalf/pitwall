// Edit mode's layout changes (H3.10): remove, move, resize and add widgets. Pure functions over the stored
// layout; the grid packs the result. Each returns a new layout with every y renumbered 0..n-1 in pack
// order, so pack order never depends on x ties. Whether a change fits is the caller's check (fits(),
// fitsAsWell()), except resizeWidget, resizeHeight, fitHeight and addWidget, which refuse steps that don't.

import type { WidgetDefinition } from "../widgetkit/defineWidget";
import { widgetIdOf, columnRange, DIVIDER, MIN_HEIGHT, pack, ROW, type GridInput, type Layout, type LayoutEntry, type Placement } from "./layout";
import { gridKind } from "./storage";

export interface EditContext {
  widgets: ReadonlyMap<string, WidgetDefinition>;
  input: GridInput;
  gridHeight: number;
}

const EPS = 1e-6;
/** Free space shorter than this isn't a slot (float noise, hairlines). */
const MIN_SLOT = 1;

const overlaps = (a: { x: number; width: number }, b: { x: number; width: number }) => a.x < b.x + b.width && b.x < a.x + a.width;
const overlapsVertically = (a: Placement, b: Placement) => a.top < b.top + b.height - EPS && b.top < a.top + a.height - EPS;
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
/** A placed widget's box top: its hairline, if any, belongs to it. */
const boxTop = (p: Placement) => p.top - (p.dividerTop ? DIVIDER : 0);

/** The layout's ids in pack order (by y, then x). */
const order = (layout: Layout) => Object.keys(layout.widgets).sort((a, b) => layout.widgets[a].y - layout.widgets[b].y || layout.widgets[a].x - layout.widgets[b].x);

/** `widgets` (every id in `ids`) with y set to each id's index in `ids`. */
const renumber = (layout: Layout, widgets: Record<string, LayoutEntry>, ids: readonly string[]): Layout => ({
  ...layout,
  widgets: Object.fromEntries(ids.map((id, y) => [id, { ...widgets[id], y }])),
});

/** Each column's bottom with stretching widgets at their minimum. */
function columnBottoms(placed: readonly Placement[], columns: number): number[] {
  const bottoms = new Array<number>(columns).fill(0);
  for (const p of placed) for (let c = Math.max(p.x, 0); c < Math.min(p.x + p.width, columns); c++) bottoms[c] = Math.max(bottoms[c], p.top + p.height);
  return bottoms;
}

/** How far the columns reach below ctx.gridHeight with stretching widgets at their minimum, summed over columns, in px. */
export function overflow(layout: Layout, ctx: EditContext): number {
  return columnBottoms(pack(layout, ctx.widgets, ctx.input, 0), layout.columns).reduce((sum, b) => sum + Math.max(0, b - ctx.gridHeight - EPS), 0);
}

/** Every column's widgets fit in ctx.gridHeight with stretching widgets at their minimum (pack at height 0). */
export function fits(layout: Layout, ctx: EditContext): boolean {
  return overflow(layout, ctx) === 0;
}

/**
 * Whether `after` fits, or overflows no more than `before` did: a layout cut off by a short window can
 * still be edited, as long as the edit doesn't cut off more.
 */
export function fitsAsWell(before: Layout, after: Layout, ctx: EditContext): boolean {
  return overflow(after, ctx) <= overflow(before, ctx) + EPS;
}

/** Ids of widgets whose bottom (stretching widgets at min) is below ctx.gridHeight: "cut off". */
export function cutOff(layout: Layout, ctx: EditContext): string[] {
  return pack(layout, ctx.widgets, ctx.input, 0)
    .filter((p) => p.top + p.height > ctx.gridHeight + EPS)
    .map((p) => p.id);
}

export function removeWidget(layout: Layout, id: string): Layout {
  if (!(id in layout.widgets)) return layout;
  return renumber(layout, layout.widgets, order(layout).filter((k) => k !== id));
}

/**
 * Where a dragged widget would land: its left column and its index among the widgets overlapping its span
 * (excluding itself), in pack order. `left` is the dragged box's left edge and `centerY` its vertical centre, in
 * grid px; `gridWidth` maps px to columns. x is rounded to the nearest column and clamped so the widget's (clamped)
 * width fits. index = the first span member whose vertical centre is below centerY, else the member count.
 */
export interface DropTarget {
  x: number;
  index: number;
}

/** The dragged widget's width as placed (clamped to its range and the grid). */
const widthOf = (layout: Layout, placements: readonly Placement[], id: string) =>
  Math.min(placements.find((p) => p.id === id)?.width ?? layout.widgets[id]?.width ?? 1, layout.columns);

const spanMembers = (placements: readonly Placement[], id: string, span: { x: number; width: number }) => placements.filter((p) => p.id !== id && overlaps(p, span));

export function dropTarget(layout: Layout, placements: readonly Placement[], id: string, left: number, centerY: number, gridWidth: number): DropTarget {
  const width = widthOf(layout, placements, id);
  const x = clamp(gridWidth > 0 ? Math.round((left * layout.columns) / gridWidth) : 0, 0, layout.columns - width);
  const members = spanMembers(placements, id, { x, width });
  const index = members.findIndex((p) => p.top + p.height / 2 > centerY);
  return { x, index: index < 0 ? members.length : index };
}

/**
 * The layout with `id` moved to `target` (keeps its width, group and settings). Build the pack-order id list,
 * take `id` out, insert it before span member `index` (or after the last member; at the end if the span is empty),
 * renumber y. `placements` are pack() of `layout` (dragged widget included). Doesn't check fit: call fits().
 */
export function moveWidget(layout: Layout, placements: readonly Placement[], id: string, target: DropTarget): Layout {
  const entry = layout.widgets[id];
  if (!entry) return layout;
  const members = spanMembers(placements, id, { x: target.x, width: widthOf(layout, placements, id) });
  const ids = order(layout).filter((k) => k !== id);
  const index = clamp(target.index, 0, members.length);
  const at = members.length === 0 ? ids.length : index < members.length ? ids.indexOf(members[index].id) : ids.indexOf(members[members.length - 1].id) + 1;
  ids.splice(at, 0, id);
  return renumber(layout, { ...layout.widgets, [id]: { ...entry, x: target.x } }, ids);
}

/**
 * One column of resize (design answer 5), or null if it's refused. Widening takes the column from the
 * neighbours whose facing edge touches it and that overlap the widget vertically: each shrinks if above its
 * min, else shifts over and passes the column on (a chain), refused at the grid edge. Narrowing hands the
 * column to such neighbours below their max; the others leave a gap.
 */
function resizeStep(layout: Layout, placed: readonly Placement[], id: string, side: "left" | "right", grow: boolean): Layout | null {
  const columns = layout.columns;
  const self = placed.find((p) => p.id === id)!;
  const range = (p: Placement) => columnRange(p.widget, columns);
  /** Neighbours whose edge touches `p`'s `side` edge and that overlap it vertically (positions before this step). */
  const touching = (p: Placement, s: "left" | "right") =>
    placed.filter((q) => q !== p && (s === "right" ? q.x === p.x + p.width : q.x + q.width === p.x) && overlapsVertically(p, q));
  const moved = new Map<string, { x: number; width: number }>();

  if (grow) {
    const width = self.width + 1;
    const x = side === "left" ? self.x - 1 : self.x;
    if (width > range(self).max || x < 0 || x + width > columns) return null;
    moved.set(id, { x, width });
    const dir = side === "right" ? 1 : -1;
    // `p` gives up its column facing the push.
    const give = (p: Placement): boolean => {
      if (moved.has(p.id)) return true;
      if (p.width > range(p).min) {
        moved.set(p.id, { x: dir > 0 ? p.x + 1 : p.x, width: p.width - 1 });
        return true;
      }
      const x = p.x + dir;
      if (x < 0 || x + p.width > columns) return false;
      moved.set(p.id, { x, width: p.width });
      return touching(p, side).every(give);
    };
    if (!touching(self, side).every(give)) return null;
  } else {
    const width = self.width - 1;
    if (width < range(self).min) return null;
    moved.set(id, { x: side === "left" ? self.x + 1 : self.x, width });
    for (const p of touching(self, side)) {
      if (p.width < range(p).max) moved.set(p.id, { x: side === "right" ? p.x - 1 : p.x, width: p.width + 1 });
    }
  }

  const widgets = { ...layout.widgets };
  for (const [k, pos] of moved) widgets[k] = { ...widgets[k], ...pos };
  return renumber(layout, widgets, order(layout));
}

/**
 * Moves one edge of `id` towards column `edge` one column at a time with neighbours giving way (design answer 5),
 * within the widget's column range; returns the layout at the furthest step that fits (the input if none).
 * "Fits" is fitsAsWell() against the input, so a layout already cut off by the window can still be resized.
 */
export function resizeWidget(layout: Layout, ctx: EditContext, id: string, side: "left" | "right", edge: number): Layout {
  if (!(id in layout.widgets) || !ctx.widgets.has(widgetIdOf(id, layout.widgets[id]))) return layout;
  const target = clamp(Math.round(edge), 0, layout.columns);
  const before = overflow(layout, ctx);
  let current = layout;
  for (let steps = 0; steps < layout.columns; steps++) {
    const placed = pack(current, ctx.widgets, ctx.input, ctx.gridHeight);
    const self = placed.find((p) => p.id === id)!;
    const at = side === "left" ? self.x : self.x + self.width;
    if (at === target) break;
    const next = resizeStep(current, placed, id, side, side === "left" ? target < at : target > at);
    if (!next || overflow(next, ctx) > before + EPS) break;
    current = next;
  }
  return current;
}

/** `id` without a height of its own (`undefined`) or at `height` px; nothing else changes. */
function withHeight(layout: Layout, id: string, height: number | undefined): Layout {
  const { height: _, ...entry } = layout.widgets[id];
  return renumber(layout, { ...layout.widgets, [id]: height === undefined ? entry : { ...entry, height } }, order(layout));
}

const placementOf = (layout: Layout, ctx: EditContext, id: string) => pack(layout, ctx.widgets, ctx.input, ctx.gridHeight).find((p) => p.id === id);

/** Where a placed widget's `side` edge is on screen (a top hairline is inside the box). */
const edgeY = (p: Placement, side: HeightEdge["side"]) => (side === "bottom" ? p.top + p.height : boxTop(p));

/** The edge of a widget that moves when its height changes, and where it is in grid px. */
export interface HeightEdge {
  side: "top" | "bottom";
  y: number;
}

/**
 * Which edge of `id` its height moves: the bottom, or the top for a widget resting on the grid's bottom
 * under a stretching widget (which gives or takes the room). null if it isn't placed.
 */
export function heightEdge(layout: Layout, ctx: EditContext, id: string): HeightEdge | null {
  const p = id in layout.widgets ? placementOf(layout, ctx, id) : undefined;
  if (!p) return null;
  // A step shorter is always placeable: does the widget's top come down, or its bottom up?
  const shorter = placementOf(withHeight(layout, id, Math.max(p.height - ROW, 1)), ctx, id)!;
  const side = Math.abs(shorter.top - p.top) > EPS ? "top" : "bottom";
  return { side, y: edgeY(p, side) };
}

/** The lines a height resize snaps to: every ROW px from the grid's top, and its bottom. */
function rowLines(gridHeight: number): number[] {
  const lines = Array.from({ length: Math.floor(gridHeight / ROW) + 1 }, (_, k) => k * ROW);
  if (gridHeight - lines[lines.length - 1] > EPS) lines.push(gridHeight);
  return lines;
}

/**
 * Moves the edge heightEdge() names to `y` (grid px), snapped like a width resize snaps to columns: to the
 * nearest row line that leaves the widget at least MIN_HEIGHT tall, or to where the widget's own height puts
 * it if that's nearer. There it goes back to having no height of its own, so a stretching widget fills its
 * column again. What's under the widget moves with its bottom; a stretching widget next to the edge gives or
 * takes the room. If that doesn't fit (fitsAsWell() against the input), the nearest line that does; the
 * input if none.
 */
export function resizeHeight(layout: Layout, ctx: EditContext, id: string, y: number): Layout {
  const edge = heightEdge(layout, ctx, id);
  if (!edge) return layout;
  const p = placementOf(layout, ctx, id)!;
  /** The widget's height with the edge at `at`. */
  const heightAt = (at: number) => (edge.side === "bottom" ? at - p.top : p.top + p.height - at - (p.dividerTop ? DIVIDER : 0));
  const lines = rowLines(ctx.gridHeight).filter((l) => heightAt(l) >= MIN_HEIGHT - EPS);
  if (lines.length === 0) return layout;
  const nearest = lines.reduce((a, b) => (Math.abs(b - y) < Math.abs(a - y) ? b : a));
  const ok = (next: Layout) => fitsAsWell(layout, next, ctx);
  const auto = withHeight(layout, id, undefined);
  if (Math.abs(edgeY(placementOf(auto, ctx, id)!, edge.side) - y) <= Math.abs(nearest - y) + EPS && ok(auto)) return auto;
  // From the nearest line down to shorter heights, which only fit better.
  const tallestFirst = lines.filter((l) => heightAt(l) <= heightAt(nearest) + EPS).sort((a, b) => heightAt(b) - heightAt(a));
  for (const l of tallestFirst) {
    const next = withHeight(layout, id, heightAt(l));
    if (ok(next)) return next;
  }
  return layout;
}

/** Back to the widget's own height (or the nearest line to it that fits): what double-clicking its edge does. */
export function fitHeight(layout: Layout, ctx: EditContext, id: string): Layout {
  const edge = heightEdge(layout, ctx, id);
  if (!edge) return layout;
  return resizeHeight(layout, ctx, id, edgeY(placementOf(withHeight(layout, id, undefined), ctx, id)!, edge.side));
}

/**
 * Free space in the grid, as maximal runs of adjacent columns with the same free top: gaps at column bottoms and
 * above multi-column widgets (design answer 3). top/height in px, x/width in columns. A run spans columns whose
 * gap has the same top and the same bottom, so every slot is a rectangle that's free all over.
 */
export interface Slot {
  x: number;
  width: number;
  top: number;
  height: number;
}

export function freeSlots(placements: readonly Placement[], columns: number, gridHeight: number): Slot[] {
  const slots: Slot[] = [];
  for (let c = 0; c < columns; c++) {
    const boxes = placements
      .filter((p) => p.x <= c && c < p.x + p.width)
      .map((p) => ({ top: boxTop(p), bottom: p.top + p.height }))
      .sort((a, b) => a.top - b.top);
    const gaps: { top: number; bottom: number }[] = [];
    let y = 0;
    for (const b of boxes) {
      if (b.top - y >= MIN_SLOT) gaps.push({ top: y, bottom: b.top });
      y = Math.max(y, b.bottom);
    }
    if (gridHeight - y >= MIN_SLOT) gaps.push({ top: y, bottom: gridHeight });
    for (const g of gaps) {
      const run = slots.find((s) => s.x + s.width === c && Math.abs(s.top - g.top) < EPS && Math.abs(s.top + s.height - g.bottom) < EPS);
      if (run) run.width++;
      else slots.push({ x: c, width: 1, top: g.top, height: g.bottom - g.top });
    }
  }
  return slots;
}

/** The key a new `widgetId` gets: the widget's id if it's free, else `<widget id>:<n>` with the least free n from 2. */
export function newKey(layout: Layout, widgetId: string): string {
  if (!(widgetId in layout.widgets)) return widgetId;
  let n = 2;
  while (`${widgetId}:${n}` in layout.widgets) n++;
  return `${widgetId}:${n}`;
}

/**
 * Places widget `widgetId`, another one if it's placed already, under newKey(). With `slot`: in that slot (width =
 * the widget's default clamped to its range and the slot, left-aligned). Without: at the bottom of the column run
 * with the most free room that fits it, trying widths from default down to min. Returns null if it fits nowhere.
 * Its entry: widgetVersion = widget.version, settings {}, no group (and `widget` if the key isn't the widget's id).
 *
 * "Free room" is first the empty space on screen (e.g. under the widgets of a column without a stretching widget);
 * if the widget fits in none, the room stretching widgets can give up (pack at height 0). Widgets for the session's
 * kind (ctx.input.info.kind) only.
 */
export function addWidget(layout: Layout, ctx: EditContext, widgetId: string, slot?: Slot): Layout | null {
  const widget = ctx.widgets.get(widgetId);
  if (!widget || !widget.sessions.includes(gridKind(ctx.input.info.kind))) return null;
  const id = newKey(layout, widgetId);
  const { columns } = layout;
  const range = columnRange(widget, columns);
  const initial = clamp(Math.round((widget.width.default * columns) / 100), range.min, range.max);
  const ids = order(layout);
  const place = (x: number, width: number, at: number): Layout => {
    const entry: LayoutEntry = { ...(id !== widgetId && { widget: widgetId }), widgetVersion: widget.version, x, y: 0, width, settings: {} };
    return renumber(layout, { ...layout.widgets, [id]: entry }, [...ids.slice(0, at), id, ...ids.slice(at)]);
  };
  const ok = (next: Layout) => fitsAsWell(layout, next, ctx);

  if (slot) {
    const width = Math.min(initial, slot.width);
    if (width < range.min || slot.x < 0 || slot.x + width > columns) return null;
    // The pack position that puts it at the slot's top and moves the other widgets least.
    const before = new Map(pack(layout, ctx.widgets, ctx.input, ctx.gridHeight).map((p) => [p.id, p.top]));
    let best: Layout | null = null;
    let bestMoved = Infinity;
    for (let at = 0; at <= ids.length; at++) {
      const next = place(slot.x, width, at);
      const placed = pack(next, ctx.widgets, ctx.input, ctx.gridHeight);
      const self = placed.find((p) => p.id === id)!;
      if (Math.abs(boxTop(self) - slot.top) > 0.5) continue;
      const movedBy = placed.reduce((sum, p) => sum + (p.id === id ? 0 : Math.abs(p.top - (before.get(p.id) ?? p.top))), 0);
      if (movedBy < bestMoved - EPS) {
        best = next;
        bestMoved = movedBy;
      }
    }
    return best && ok(best) ? best : null;
  }

  const onScreen = columnBottoms(pack(layout, ctx.widgets, ctx.input, ctx.gridHeight), columns);
  const atMin = columnBottoms(pack(layout, ctx.widgets, ctx.input, 0), columns);
  const height = pack(place(0, range.min, ids.length), ctx.widgets, ctx.input, 0).find((p) => p.id === id)!.height;
  /** The leftmost x with the most room under `bottoms` for `width` columns, and that room. */
  const roomiest = (bottoms: number[], width: number) => {
    let best = { x: 0, room: -Infinity };
    for (let x = 0; x + width <= columns; x++) {
      const room = ctx.gridHeight - Math.max(...bottoms.slice(x, x + width));
      if (room > best.room + EPS) best = { x, room };
    }
    return best;
  };
  for (let width = initial; width >= range.min; width--) {
    const empty = roomiest(onScreen, width);
    if (empty.room >= height + DIVIDER) {
      const next = place(empty.x, width, ids.length);
      if (ok(next)) return next;
    }
    const next = place(roomiest(atMin, width).x, width, ids.length);
    if (ok(next)) return next;
  }
  return null;
}

/** Whether addWidget would succeed (for the picker's "No room"). */
export function canAdd(layout: Layout, ctx: EditContext, widgetId: string, slot?: Slot): boolean {
  return addWidget(layout, ctx, widgetId, slot) !== null;
}
