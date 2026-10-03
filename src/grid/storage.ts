// The saved layouts (H3.11): one per browser for races and one for free practice, in localStorage (sync, so the first
// frame already shows it). What's read back is checked and repaired against the widgets the app has: entries of
// unknown widgets and widgets for other sessions are dropped, widths clamped, heights kept to at least MIN_HEIGHT,
// settings the widget no longer accepts dropped, and a layout saved at another column count rescaled. Anything
// unusable falls back to the default layout.

import { settingField, type WidgetDefinition, type WidgetSettings, type SettingValue } from "../widgetkit/defineWidget";
import type { SessionKind } from "../widgetkit/select";
import { widgetIdOf, COLUMNS, columnRange, MIN_HEIGHT, type Layout, type LayoutEntry } from "./layout";

/** The sessions shown on the grid, each with its own layout (qualifying has its own screen). */
export type GridKind = Exclude<SessionKind, "qualifying">;

/** The layout a session of `kind` is shown with. */
export const gridKind = (kind: SessionKind | undefined): GridKind => (kind === "practice" ? "practice" : "race");

export const STORAGE_KEY = "f1-replay:layout";
/** Where each kind's layout is saved: races where the only layout was before practice had its own. */
export const storageKey = (kind: GridKind) => (kind === "race" ? STORAGE_KEY : `${STORAGE_KEY}:${kind}`);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const major = (version: string) => /^(\d+)\./.exec(version)?.[1] ?? null;

/**
 * Layouts saved before widgets were called widgets (until 2026-10-02) name them `blocks`, `block` and
 * `blockVersion`, and browsers still hold them. Those are read as `widgets`, `widget` and `widgetVersion`
 * (the new name wins if a layout has both); saving always writes the new names.
 */
const SAVED_AS = { widgets: "blocks", widget: "block", widgetVersion: "blockVersion" } as const;
const saved = (raw: Record<string, unknown>, name: keyof typeof SAVED_AS) => (raw[name] !== undefined ? raw[name] : raw[SAVED_AS[name]]);

/** Whether `value` is one the widget's `key` setting accepts (see settingField()). */
function accepts(widget: WidgetDefinition, key: string, value: unknown): value is SettingValue {
  const field = settingField(widget, key);
  if (field?.kind === "choice") return field.options.some((o) => o.value === value);
  if (field?.kind === "driver") return value === "follow-selection" || (Number.isInteger(value) && (value as number) > 0);
  const initial = widget.settings[key];
  if (typeof initial === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) return false;
    return field?.kind !== "number" || ((field.min == null || value >= field.min) && (field.max == null || value <= field.max));
  }
  return (typeof initial === "boolean" || typeof initial === "string") && typeof value === typeof initial;
}

/** The stored settings the widget still has and accepts. */
function cleanSettings(widget: WidgetDefinition, stored: Record<string, unknown>): Partial<WidgetSettings> {
  return Object.fromEntries(Object.entries(stored).filter(([key, value]) => Object.hasOwn(widget.settings, key) && accepts(widget, key, value))) as Partial<WidgetSettings>;
}

/** `entry` with its width clamped to the widget's range and the grid, and x clamped so it fits. */
function clampEntry(entry: LayoutEntry, widget: WidgetDefinition | undefined, columns: number): LayoutEntry {
  const range = widget ? columnRange(widget, columns) : { min: 1, max: columns };
  const width = Math.min(Math.max(entry.width, range.min), range.max, columns);
  return { ...entry, width, x: Math.min(Math.max(entry.x, 0), columns - width) };
}

/**
 * The layout at `columns` columns, scaled by edges so neighbours stay adjacent: each widget's left and right
 * edges are scaled and rounded, then its width clamped to its range and the grid.
 */
export function rescaleLayout(layout: Layout, widgets: ReadonlyMap<string, WidgetDefinition>, columns: number): Layout {
  if (layout.columns === columns) return layout;
  const scale = (c: number) => Math.round((c * columns) / layout.columns);
  const entries = Object.entries(layout.widgets).map(([id, e]) => {
    const x = scale(e.x);
    return [id, clampEntry({ ...e, x, width: Math.max(scale(e.x + e.width) - x, 1) }, widgets.get(widgetIdOf(id, e)), columns)] as const;
  });
  return { ...layout, columns, widgets: Object.fromEntries(entries) };
}

/** A stored entry's shape (in the new names), or null if it isn't one. */
function readEntry(raw: unknown): LayoutEntry | null {
  if (!isObject(raw)) return null;
  const widgetVersion = saved(raw, "widgetVersion");
  const widget = saved(raw, "widget");
  if (typeof widgetVersion !== "string" || !isObject(raw.settings)) return null;
  const { x, y, width, height, group } = raw;
  if (![x, y, width].every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  if ((group !== undefined && typeof group !== "string") || (widget !== undefined && typeof widget !== "string")) return null;
  const entry: LayoutEntry = { widgetVersion, x: Math.round(x as number), y: y as number, width: Math.round(width as number), settings: raw.settings as Partial<WidgetSettings> };
  if (widget !== undefined) entry.widget = widget;
  // A height that isn't one is dropped: the widget takes its own.
  if (typeof height === "number" && Number.isFinite(height)) entry.height = Math.max(height, MIN_HEIGHT);
  return group === undefined ? entry : { ...entry, group };
}

/** Validates and repairs a stored layout of `kind` sessions (see the top of this file). null if it's unusable. */
export function parseLayout(raw: unknown, widgets: ReadonlyMap<string, WidgetDefinition>, columns = COLUMNS, kind: GridKind = "race"): Layout | null {
  if (!isObject(raw) || raw.version !== 1) return null;
  const entries = saved(raw, "widgets");
  const stored = raw.columns;
  if (!isObject(entries) || typeof stored !== "number" || !Number.isInteger(stored) || stored < 1) return null;

  const kept: Record<string, LayoutEntry> = {};
  for (const [id, value] of Object.entries(entries)) {
    const entry = readEntry(value);
    if (!entry) return null;
    const widget = widgets.get(widgetIdOf(id, entry));
    if (!widget || !widget.sessions.includes(kind)) continue;
    // One version of each widget is available: the same major keeps the settings, another resets them.
    const settings = major(entry.widgetVersion) === major(widget.version) ? cleanSettings(widget, entry.settings) : {};
    kept[id] = { ...entry, widgetVersion: widget.version, settings };
  }
  if (Object.keys(kept).length === 0) return null;

  const layout = rescaleLayout({ version: 1, columns: stored, widgets: kept }, widgets, columns);
  return { ...layout, widgets: Object.fromEntries(Object.entries(layout.widgets).map(([id, e]) => [id, clampEntry(e, widgets.get(widgetIdOf(id, e)), columns)])) };
}

/** The saved layout for `kind` sessions, or `fallback`. Never throws (localStorage may be missing or throw). */
export function loadLayout(widgets: ReadonlyMap<string, WidgetDefinition>, fallback: Layout, kind: GridKind = "race"): Layout {
  try {
    const saved = globalThis.localStorage?.getItem(storageKey(kind));
    return (saved != null && parseLayout(JSON.parse(saved), widgets, COLUMNS, kind)) || fallback;
  } catch {
    return fallback;
  }
}

export function saveLayout(layout: Layout, kind: GridKind = "race"): void {
  try {
    globalThis.localStorage?.setItem(storageKey(kind), JSON.stringify(layout));
  } catch {
    // Full or blocked storage: the layout lasts until the page closes.
  }
}

export function clearSavedLayout(kind: GridKind = "race"): void {
  try {
    globalThis.localStorage?.removeItem(storageKey(kind));
  } catch {
    // Nothing saved that we can reach.
  }
}
