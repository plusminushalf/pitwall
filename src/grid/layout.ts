// The block grid (H3.11): a fixed number of equal columns across the screen, exactly as tall as the space
// between the top bar and the timeline. A layout says where each block goes and how wide it is; heights
// come from the blocks: fixed ones take what their contents need, and the last stretching block in each
// column fills it to the bottom, so every column ends flush with the bottom edge. Nothing scrolls.

import { stretches, type BlockDefinition, type BlockSettings, type HeightInput, type Px } from "../blockkit/defineBlock";

/**
 * Equal columns across the grid's width. 38 fits the old fixed-width screen (tower 410 px, panel 360 px)
 * closest at 1720 px wide while the speed column still fits its contents at 1440 px (defaultLayout.ts).
 * Block widths are in percent and the default layout is worked out from px, so it's the one number to tune.
 */
export const COLUMNS = 38;
/** A hairline between neighbouring blocks of different groups, in px (taken from the later block's side). */
export const DIVIDER = 1;

/** The stored layout (H3.11): one per browser, each block at most once. Heights are derived. */
export interface Layout {
  version: 1;
  columns: number;
  blocks: Record<string, LayoutEntry>;
}

export interface LayoutEntry {
  blockVersion: string;
  /** Column of the left edge. */
  x: number;
  /** Order from the top: blocks settle upwards in order of y, then x, onto what's above them. */
  y: number;
  /** In columns. */
  width: number;
  /** Blocks in the same group read as one panel: no divider between them. By default each block is its own. */
  group?: string;
  settings: Partial<BlockSettings>;
}

/** The session and selection part of HeightInput (the block's settings are added per block). */
export type GridInput = Omit<HeightInput, "settings">;

/** Where a block ends up: x and width in columns, top and height in px. */
export interface Placement {
  id: string;
  block: BlockDefinition;
  x: number;
  width: number;
  top: number;
  height: number;
  stretch: boolean;
  /** Hairlines on the block's top and left edges (inside its box, before `top` / at its left edge). */
  dividerTop: boolean;
  dividerLeft: boolean;
}

const px = (value: Px, input: HeightInput) => {
  const v = typeof value === "function" ? value(input) : value;
  return Number.isFinite(v) && v > 0 ? v : 0;
};

/** A block's width range in whole columns (at least one). */
export function columnRange(block: BlockDefinition, columns: number): { min: number; max: number } {
  const cols = (pct: number) => Math.min(Math.max(Math.round((pct * columns) / 100), 1), columns);
  const min = cols(block.width.min);
  return { min, max: Math.max(cols(block.width.max), min) };
}

const overlaps = (a: { x: number; width: number }, b: { x: number; width: number }) => a.x < b.x + b.width && b.x < a.x + a.width;
const EPS = 1e-6;

/**
 * Places the layout's blocks in a grid `gridHeight` px tall: widths clamped to each block's range and the
 * grid, every block settled upwards (in order of y, then x) onto the blocks above it, stretching blocks at
 * their minimum, and then the last stretching block of each column grown to fill it (pushing down what's
 * under it). A stretching block grows only if it's the last in every column it spans, by the least room
 * any of them has. Without a stretching block, a column keeps its space at the bottom; if the blocks
 * don't fit, the bottom is cut off. Blocks the app doesn't have are left out.
 */
export function pack(layout: Layout, blocks: ReadonlyMap<string, BlockDefinition>, input: GridInput, gridHeight: number): Placement[] {
  const items = Object.entries(layout.blocks)
    .filter(([id]) => blocks.has(id))
    .sort(([, a], [, b]) => a.y - b.y || a.x - b.x)
    .map(([id, entry]) => {
      const block = blocks.get(id)!;
      const range = columnRange(block, layout.columns);
      const width = Math.min(Math.max(entry.width, range.min), range.max);
      const x = Math.min(Math.max(entry.x, 0), layout.columns - width);
      const at: HeightInput = { ...input, settings: { ...block.settings, ...entry.settings } as BlockSettings };
      const stretch = stretches(block);
      const height = px(stretch ? (block.height as { min: Px }).min : (block.height as Px), at);
      return { id, block, x, width, group: entry.group ?? id, stretch, height };
    });

  // Tops from the heights: each block rests on the lowest bottom above it, a hairline lower if any block
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
    // The last stretching block in each of its columns (none after it overlaps it).
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

/** A placed block in screen px, its hairlines included. */
export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Screen boxes for `gridWidth` px. Column edges are rounded once and shared by neighbours, so blocks side
 * by side meet exactly; vertically, a box is its block's height (plus the hairline above it, if any).
 */
export function boxesOf(placements: readonly Placement[], gridWidth: number, columns: number): Box[] {
  const colEdge = (c: number) => Math.round((c * gridWidth) / columns);
  return placements.map((p) => {
    const left = colEdge(p.x);
    const divider = p.dividerTop ? DIVIDER : 0;
    return { left, width: colEdge(p.x + p.width) - left, top: p.top - divider, height: p.height + divider };
  });
}
