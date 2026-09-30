// Edit mode's layout changes (H3.10): remove, move, resize and add blocks. Pure functions over the stored
// layout; the grid packs the result. Each returns a new layout with every y renumbered 0..n-1 in pack
// order, so pack order never depends on x ties. Whether a change fits is the caller's check (fits(),
// fitsAsWell()), except resizeBlock and addBlock, which refuse steps that don't.

import type { BlockDefinition } from "../blockkit/defineBlock";
import { columnRange, DIVIDER, pack, type GridInput, type Layout, type LayoutEntry, type Placement } from "./layout";

export interface EditContext {
  blocks: ReadonlyMap<string, BlockDefinition>;
  input: GridInput;
  gridHeight: number;
}

const EPS = 1e-6;
/** Free space shorter than this isn't a slot (float noise, hairlines). */
const MIN_SLOT = 1;

const overlaps = (a: { x: number; width: number }, b: { x: number; width: number }) => a.x < b.x + b.width && b.x < a.x + a.width;
const overlapsVertically = (a: Placement, b: Placement) => a.top < b.top + b.height - EPS && b.top < a.top + a.height - EPS;
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
/** A placed block's box top: its hairline, if any, belongs to it. */
const boxTop = (p: Placement) => p.top - (p.dividerTop ? DIVIDER : 0);

/** The layout's ids in pack order (by y, then x). */
const order = (layout: Layout) => Object.keys(layout.blocks).sort((a, b) => layout.blocks[a].y - layout.blocks[b].y || layout.blocks[a].x - layout.blocks[b].x);

/** `blocks` (every id in `ids`) with y set to each id's index in `ids`. */
const renumber = (layout: Layout, blocks: Record<string, LayoutEntry>, ids: readonly string[]): Layout => ({
  ...layout,
  blocks: Object.fromEntries(ids.map((id, y) => [id, { ...blocks[id], y }])),
});

/** Each column's bottom with stretching blocks at their minimum. */
function columnBottoms(placed: readonly Placement[], columns: number): number[] {
  const bottoms = new Array<number>(columns).fill(0);
  for (const p of placed) for (let c = Math.max(p.x, 0); c < Math.min(p.x + p.width, columns); c++) bottoms[c] = Math.max(bottoms[c], p.top + p.height);
  return bottoms;
}

/** How far the columns reach below ctx.gridHeight with stretching blocks at their minimum, summed over columns, in px. */
export function overflow(layout: Layout, ctx: EditContext): number {
  return columnBottoms(pack(layout, ctx.blocks, ctx.input, 0), layout.columns).reduce((sum, b) => sum + Math.max(0, b - ctx.gridHeight - EPS), 0);
}

/** Every column's blocks fit in ctx.gridHeight with stretching blocks at their minimum (pack at height 0). */
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

/** Ids of blocks whose bottom (stretching blocks at min) is below ctx.gridHeight: "cut off". */
export function cutOff(layout: Layout, ctx: EditContext): string[] {
  return pack(layout, ctx.blocks, ctx.input, 0)
    .filter((p) => p.top + p.height > ctx.gridHeight + EPS)
    .map((p) => p.id);
}

export function removeBlock(layout: Layout, id: string): Layout {
  if (!(id in layout.blocks)) return layout;
  return renumber(layout, layout.blocks, order(layout).filter((k) => k !== id));
}

/**
 * Where a dragged block would land: its left column and its index among the blocks overlapping its span
 * (excluding itself), in pack order. `left` is the dragged box's left edge and `centerY` its vertical centre, in
 * grid px; `gridWidth` maps px to columns. x is rounded to the nearest column and clamped so the block's (clamped)
 * width fits. index = the first span member whose vertical centre is below centerY, else the member count.
 */
export interface DropTarget {
  x: number;
  index: number;
}

/** The dragged block's width as placed (clamped to its range and the grid). */
const widthOf = (layout: Layout, placements: readonly Placement[], id: string) =>
  Math.min(placements.find((p) => p.id === id)?.width ?? layout.blocks[id]?.width ?? 1, layout.columns);

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
 * renumber y. `placements` are pack() of `layout` (dragged block included). Doesn't check fit: call fits().
 */
export function moveBlock(layout: Layout, placements: readonly Placement[], id: string, target: DropTarget): Layout {
  const entry = layout.blocks[id];
  if (!entry) return layout;
  const members = spanMembers(placements, id, { x: target.x, width: widthOf(layout, placements, id) });
  const ids = order(layout).filter((k) => k !== id);
  const index = clamp(target.index, 0, members.length);
  const at = members.length === 0 ? ids.length : index < members.length ? ids.indexOf(members[index].id) : ids.indexOf(members[members.length - 1].id) + 1;
  ids.splice(at, 0, id);
  return renumber(layout, { ...layout.blocks, [id]: { ...entry, x: target.x } }, ids);
}

/**
 * One column of resize (design answer 5), or null if it's refused. Widening takes the column from the
 * neighbours whose facing edge touches it and that overlap the block vertically: each shrinks if above its
 * min, else shifts over and passes the column on (a chain), refused at the grid edge. Narrowing hands the
 * column to such neighbours below their max; the others leave a gap.
 */
function resizeStep(layout: Layout, placed: readonly Placement[], id: string, side: "left" | "right", grow: boolean): Layout | null {
  const columns = layout.columns;
  const self = placed.find((p) => p.id === id)!;
  const range = (p: Placement) => columnRange(p.block, columns);
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

  const blocks = { ...layout.blocks };
  for (const [k, pos] of moved) blocks[k] = { ...blocks[k], ...pos };
  return renumber(layout, blocks, order(layout));
}

/**
 * Moves one edge of `id` towards column `edge` one column at a time with neighbours giving way (design answer 5),
 * within the block's column range; returns the layout at the furthest step that fits (the input if none).
 * "Fits" is fitsAsWell() against the input, so a layout already cut off by the window can still be resized.
 */
export function resizeBlock(layout: Layout, ctx: EditContext, id: string, side: "left" | "right", edge: number): Layout {
  if (!ctx.blocks.has(id) || !(id in layout.blocks)) return layout;
  const target = clamp(Math.round(edge), 0, layout.columns);
  const before = overflow(layout, ctx);
  let current = layout;
  for (let steps = 0; steps < layout.columns; steps++) {
    const placed = pack(current, ctx.blocks, ctx.input, ctx.gridHeight);
    const self = placed.find((p) => p.id === id)!;
    const at = side === "left" ? self.x : self.x + self.width;
    if (at === target) break;
    const next = resizeStep(current, placed, id, side, side === "left" ? target < at : target > at);
    if (!next || overflow(next, ctx) > before + EPS) break;
    current = next;
  }
  return current;
}

/**
 * Free space in the grid, as maximal runs of adjacent columns with the same free top: gaps at column bottoms and
 * above multi-column blocks (design answer 3). top/height in px, x/width in columns. A run spans columns whose
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

/**
 * Adds an unplaced block. With `slot`: in that slot (width = the block's default clamped to its range and the slot,
 * left-aligned). Without: at the bottom of the column run with the most free room that fits it, trying widths from
 * default down to min. Returns null if it fits nowhere. Its entry: blockVersion = block.version, settings {}, no group.
 *
 * "Free room" is first the empty space on screen (e.g. under the blocks of a column without a stretching block);
 * if the block fits in none, the room stretching blocks can give up (pack at height 0). Race blocks only.
 */
export function addBlock(layout: Layout, ctx: EditContext, id: string, slot?: Slot): Layout | null {
  const block = ctx.blocks.get(id);
  if (!block || id in layout.blocks || !block.sessions.includes("race")) return null;
  const { columns } = layout;
  const range = columnRange(block, columns);
  const initial = clamp(Math.round((block.width.default * columns) / 100), range.min, range.max);
  const ids = order(layout);
  const place = (x: number, width: number, at: number): Layout => {
    const entry: LayoutEntry = { blockVersion: block.version, x, y: 0, width, settings: {} };
    return renumber(layout, { ...layout.blocks, [id]: entry }, [...ids.slice(0, at), id, ...ids.slice(at)]);
  };
  const ok = (next: Layout) => fitsAsWell(layout, next, ctx);

  if (slot) {
    const width = Math.min(initial, slot.width);
    if (width < range.min || slot.x < 0 || slot.x + width > columns) return null;
    // The pack position that puts it at the slot's top and moves the other blocks least.
    const before = new Map(pack(layout, ctx.blocks, ctx.input, ctx.gridHeight).map((p) => [p.id, p.top]));
    let best: Layout | null = null;
    let bestMoved = Infinity;
    for (let at = 0; at <= ids.length; at++) {
      const next = place(slot.x, width, at);
      const placed = pack(next, ctx.blocks, ctx.input, ctx.gridHeight);
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

  const onScreen = columnBottoms(pack(layout, ctx.blocks, ctx.input, ctx.gridHeight), columns);
  const atMin = columnBottoms(pack(layout, ctx.blocks, ctx.input, 0), columns);
  const height = pack(place(0, range.min, ids.length), ctx.blocks, ctx.input, 0).find((p) => p.id === id)!.height;
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

/** Whether addBlock would succeed (for the picker's "No room"). */
export function canAdd(layout: Layout, ctx: EditContext, id: string, slot?: Slot): boolean {
  return addBlock(layout, ctx, id, slot) !== null;
}
