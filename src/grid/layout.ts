// The block grid (H3.8, H3.11): a fixed number of columns, unlimited rows of a quarter column each.
// A layout says where each block goes and how wide it is; heights come from each block's shape.

import type { BlockDefinition, BlockSettings, ShapeInput } from "../blockkit/defineBlock";

/** Placeholder: the right number comes from trying layouts on real screens. */
export const COLUMNS = 10;
/** The vertical snap step: rows are a quarter of a column's width. */
export const ROWS_PER_COLUMN = 4;

/** The stored layout (H3.11): one per browser, each block at most once. Heights are derived. */
export interface Layout {
  version: 1;
  columns: number;
  blocks: Record<string, { blockVersion: string; x: number; y: number; width: number; settings: Partial<BlockSettings> }>;
}

/** Where a block ends up: x and width in columns, y and rows in grid rows. */
export interface Placement {
  id: string;
  block: BlockDefinition;
  x: number;
  y: number;
  width: number;
  /** Width : height. */
  shape: number;
  /** Rows taken (the height rounded up to the snap step). */
  rows: number;
}

function shapeOf(block: BlockDefinition, input: ShapeInput): number {
  const s = typeof block.shape === "number" ? block.shape : block.shape(input);
  return Number.isFinite(s) && s > 0 ? s : 1;
}

/**
 * Places the layout's blocks: widths clamped to each block's range, and every block settled upwards
 * (in order of y, then x) until it rests on a block above it, so there are no holes under blocks.
 * Blocks the app doesn't have are left out.
 */
export function pack(layout: Layout, blocks: ReadonlyMap<string, BlockDefinition>, input: ShapeInput): Placement[] {
  const entries = Object.entries(layout.blocks)
    .filter(([id]) => blocks.has(id))
    .sort(([, a], [, b]) => a.y - b.y || a.x - b.x);
  const placed: Placement[] = [];
  for (const [id, entry] of entries) {
    const block = blocks.get(id)!;
    const width = Math.min(Math.max(entry.width, block.width.min), block.width.max, layout.columns);
    const x = Math.min(Math.max(entry.x, 0), layout.columns - width);
    const shape = shapeOf(block, input);
    const rows = Math.ceil((ROWS_PER_COLUMN * width) / shape - 1e-9);
    const y = placed.reduce((top, p) => (p.x < x + width && x < p.x + p.width ? Math.max(top, p.y + p.rows) : top), 0);
    placed.push({ id, block, x, y, width, shape, rows });
  }
  return placed;
}

/** A placed block in screen px. */
export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Screen boxes for `gridWidth` px. Column and row edges are rounded once and shared by neighbours, and a
 * box never reaches past its own rows, so blocks meet exactly and never overlap.
 */
export function boxesOf(placements: readonly Placement[], gridWidth: number, columns: number): Box[] {
  const column = gridWidth / columns;
  const row = column / ROWS_PER_COLUMN;
  const colEdge = (c: number) => Math.round(c * column);
  const rowEdge = (r: number) => Math.round(r * row);
  return placements.map((p) => {
    const left = colEdge(p.x);
    const width = colEdge(p.x + p.width) - left;
    const top = rowEdge(p.y);
    const height = Math.min(Math.round(width / p.shape), rowEdge(p.y + p.rows) - top);
    return { left, top, width, height };
  });
}

/** Height of the packed grid in px. */
export const gridHeight = (placements: readonly Placement[], gridWidth: number, columns: number) =>
  Math.round(Math.max(0, ...placements.map((p) => p.y + p.rows)) * (gridWidth / columns / ROWS_PER_COLUMN));
