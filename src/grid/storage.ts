// The saved layout (H3.11): one per browser, in localStorage (sync, so the first frame already shows it).
// What's read back is checked and repaired against the blocks the app has: unknown and non-race blocks
// are dropped, widths clamped, settings the block no longer accepts dropped, and a layout saved at another
// column count rescaled. Anything unusable falls back to the default layout.

import { settingField, type BlockDefinition, type BlockSettings, type SettingValue } from "../blockkit/defineBlock";
import { COLUMNS, columnRange, type Layout, type LayoutEntry } from "./layout";

export const STORAGE_KEY = "f1-replay:layout";

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const major = (version: string) => /^(\d+)\./.exec(version)?.[1] ?? null;

/** Whether `value` is one the block's `key` setting accepts (see settingField()). */
function accepts(block: BlockDefinition, key: string, value: unknown): value is SettingValue {
  const field = settingField(block, key);
  if (field?.kind === "choice") return field.options.some((o) => o.value === value);
  if (field?.kind === "driver") return value === "follow-selection" || (Number.isInteger(value) && (value as number) > 0);
  const initial = block.settings[key];
  if (typeof initial === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) return false;
    return field?.kind !== "number" || ((field.min == null || value >= field.min) && (field.max == null || value <= field.max));
  }
  return (typeof initial === "boolean" || typeof initial === "string") && typeof value === typeof initial;
}

/** The stored settings the block still has and accepts. */
function cleanSettings(block: BlockDefinition, stored: Record<string, unknown>): Partial<BlockSettings> {
  return Object.fromEntries(Object.entries(stored).filter(([key, value]) => Object.hasOwn(block.settings, key) && accepts(block, key, value))) as Partial<BlockSettings>;
}

/** `entry` with its width clamped to the block's range and the grid, and x clamped so it fits. */
function clampEntry(entry: LayoutEntry, block: BlockDefinition | undefined, columns: number): LayoutEntry {
  const range = block ? columnRange(block, columns) : { min: 1, max: columns };
  const width = Math.min(Math.max(entry.width, range.min), range.max, columns);
  return { ...entry, width, x: Math.min(Math.max(entry.x, 0), columns - width) };
}

/**
 * The layout at `columns` columns, scaled by edges so neighbours stay adjacent: each block's left and right
 * edges are scaled and rounded, then its width clamped to its range and the grid.
 */
export function rescaleLayout(layout: Layout, blocks: ReadonlyMap<string, BlockDefinition>, columns: number): Layout {
  if (layout.columns === columns) return layout;
  const scale = (c: number) => Math.round((c * columns) / layout.columns);
  const entries = Object.entries(layout.blocks).map(([id, e]) => {
    const x = scale(e.x);
    return [id, clampEntry({ ...e, x, width: Math.max(scale(e.x + e.width) - x, 1) }, blocks.get(id), columns)] as const;
  });
  return { ...layout, columns, blocks: Object.fromEntries(entries) };
}

/** A stored entry's shape, or null if it isn't one. */
function readEntry(raw: unknown): LayoutEntry | null {
  if (!isObject(raw) || typeof raw.blockVersion !== "string" || !isObject(raw.settings)) return null;
  const { x, y, width, group } = raw;
  if (![x, y, width].every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  if (group !== undefined && typeof group !== "string") return null;
  const entry: LayoutEntry = { blockVersion: raw.blockVersion, x: Math.round(x as number), y: y as number, width: Math.round(width as number), settings: raw.settings as Partial<BlockSettings> };
  return group === undefined ? entry : { ...entry, group };
}

/** Validates and repairs a stored layout (see the top of this file). null if it's unusable. */
export function parseLayout(raw: unknown, blocks: ReadonlyMap<string, BlockDefinition>, columns = COLUMNS): Layout | null {
  if (!isObject(raw) || raw.version !== 1 || !isObject(raw.blocks)) return null;
  const stored = raw.columns;
  if (typeof stored !== "number" || !Number.isInteger(stored) || stored < 1) return null;

  const kept: Record<string, LayoutEntry> = {};
  for (const [id, value] of Object.entries(raw.blocks)) {
    const entry = readEntry(value);
    if (!entry) return null;
    const block = blocks.get(id);
    if (!block || !block.sessions.includes("race")) continue;
    // One version of each block is available: the same major keeps the settings, another resets them.
    const settings = major(entry.blockVersion) === major(block.version) ? cleanSettings(block, entry.settings) : {};
    kept[id] = { ...entry, blockVersion: block.version, settings };
  }
  if (Object.keys(kept).length === 0) return null;

  const layout = rescaleLayout({ version: 1, columns: stored, blocks: kept }, blocks, columns);
  return { ...layout, blocks: Object.fromEntries(Object.entries(layout.blocks).map(([id, e]) => [id, clampEntry(e, blocks.get(id), columns)])) };
}

/** The saved layout, or `fallback`. Never throws (localStorage may be missing or throw). */
export function loadLayout(blocks: ReadonlyMap<string, BlockDefinition>, fallback: Layout): Layout {
  try {
    const saved = globalThis.localStorage?.getItem(STORAGE_KEY);
    return (saved != null && parseLayout(JSON.parse(saved), blocks)) || fallback;
  } catch {
    return fallback;
  }
}

export function saveLayout(layout: Layout): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(layout));
  } catch {
    // Full or blocked storage: the layout lasts until the page closes.
  }
}

export function clearSavedLayout(): void {
  try {
    globalThis.localStorage?.removeItem(STORAGE_KEY);
  } catch {
    // Nothing saved that we can reach.
  }
}
