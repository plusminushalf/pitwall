// Dashboards: named layouts, any of which can show any session of its kind. Each kind (races, free practice) has the
// dashboards the app ships (PRESETS) and the user's own, and one of them on screen. A preset the user edits keeps
// its name and place: the edit is saved over it, and Reset brings the preset back. The user's own can be renamed
// and deleted. All of it is one localStorage entry, read back checked and repaired like a saved layout
// (storage.ts's parseLayout). Before dashboards (until 2026-10-07) each kind had one saved layout; the first read
// takes it as that kind's Overview, edited, so nobody's screen changes.

import type { WidgetDefinition } from "../widgetkit/defineWidget";
import { DEFAULT_LAYOUT, PRACTICE_LAYOUT, STRATEGY_LAYOUT, TELEMETRY_LAYOUT } from "./defaultLayout";
import { COLUMNS, type Layout } from "./layout";
import { parseLayout, storageKey, type GridKind } from "./storage";

export interface Preset {
  id: string;
  name: string;
  /** What it's for, as a tooltip. */
  description: string;
  layout: Layout;
}

export const PRESETS: Record<GridKind, readonly Preset[]> = {
  race: [
    { id: "overview", name: "Overview", description: "The race at a glance, and the analysis of it underneath", layout: DEFAULT_LAYOUT },
    { id: "strategy", name: "Strategy", description: "Tyres, stints, pit stops and the gaps they made", layout: STRATEGY_LAYOUT },
    { id: "telemetry", name: "Telemetry", description: "The selected drivers' laps overlaid: speed, throttle, brake and gear along the lap", layout: TELEMETRY_LAYOUT },
  ],
  practice: [
    { id: "overview", name: "Overview", description: "The session at a glance, the long runs and the stint pace", layout: PRACTICE_LAYOUT },
    { id: "telemetry", name: "Telemetry", description: "The selected drivers' laps overlaid: speed, throttle, brake and gear along the lap", layout: TELEMETRY_LAYOUT },
  ],
};

/** The dashboard a kind starts on, and falls back to. */
export const FIRST = "overview";

/** One of the user's own. */
export interface OwnDashboard {
  id: string;
  name: string;
  layout: Layout;
}

export interface KindDashboards {
  /** The one on screen. */
  active: string;
  /** Presets the user has edited, by id. */
  edited: Record<string, Layout>;
  own: OwnDashboard[];
}

export type Dashboards = Record<GridKind, KindDashboards>;

/** A dashboard as the switcher lists it. */
export interface DashboardItem {
  id: string;
  name: string;
  preset: boolean;
  description?: string;
}

export const DASHBOARDS_KEY = "f1-replay:dashboards";
/** Ids in links (`dash=`) and storage. The user's own are `my-<n>`, so they never take a preset's. */
export const DASHBOARD_ID = /^[a-z0-9-]{1,40}$/;
export const NAME_MAX = 40;

const KINDS: GridKind[] = ["race", "practice"];
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const presetOf = (kind: GridKind, id: string) => PRESETS[kind].find((p) => p.id === id);

export const emptyDashboards = (): Dashboards => ({
  race: { active: FIRST, edited: {}, own: [] },
  practice: { active: FIRST, edited: {}, own: [] },
});

/** A name as it's kept: trimmed, at most NAME_MAX characters; null if nothing's left. */
export function cleanName(name: string): string | null {
  const trimmed = name.trim().slice(0, NAME_MAX).trim();
  return trimmed === "" ? null : trimmed;
}

export function dashboardList(d: Dashboards, kind: GridKind): DashboardItem[] {
  return [
    ...PRESETS[kind].map((p) => ({ id: p.id, name: p.name, preset: true, description: p.description })),
    ...d[kind].own.map((o) => ({ id: o.id, name: o.name, preset: false })),
  ];
}

export const hasDashboard = (d: Dashboards, kind: GridKind, id: string) => presetOf(kind, id) != null || d[kind].own.some((o) => o.id === id);

/** The dashboard on screen for `kind`: the active one if it's still there, else the first. */
export const activeOf = (d: Dashboards, kind: GridKind) => (hasDashboard(d, kind, d[kind].active) ? d[kind].active : FIRST);

/** A dashboard's layout: an edited preset's edit, the preset, or the user's own; the first preset if there's no such dashboard. */
export function layoutOf(d: Dashboards, kind: GridKind, id: string): Layout {
  const preset = presetOf(kind, id);
  if (preset) return d[kind].edited[id] ?? preset.layout;
  return d[kind].own.find((o) => o.id === id)?.layout ?? PRESETS[kind][0].layout;
}

const withKind = (d: Dashboards, kind: GridKind, next: Partial<KindDashboards>): Dashboards => ({ ...d, [kind]: { ...d[kind], ...next } });

export const setActive = (d: Dashboards, kind: GridKind, id: string): Dashboards => (hasDashboard(d, kind, id) ? withKind(d, kind, { active: id }) : d);

/** `id` with `layout` saved: over the preset, or as the user's own's. */
export function withLayout(d: Dashboards, kind: GridKind, id: string, layout: Layout): Dashboards {
  if (presetOf(kind, id)) return withKind(d, kind, { edited: { ...d[kind].edited, [id]: layout } });
  return withKind(d, kind, { own: d[kind].own.map((o) => (o.id === id ? { ...o, layout } : o)) });
}

/** `base`, or `base 2`, `base 3`… : a name no dashboard of the kind has. */
export function freeName(d: Dashboards, kind: GridKind, base: string): string {
  const taken = new Set(dashboardList(d, kind).map((i) => i.name.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base} ${n}`.toLowerCase())) return `${base} ${n}`;
}

/** A dashboard of the user's own, made active; with its id. */
export function addOwn(d: Dashboards, kind: GridKind, name: string, layout: Layout): [Dashboards, string] {
  const used = new Set(KINDS.flatMap((k) => d[k].own.map((o) => o.id)));
  let n = 1;
  while (used.has(`my-${n}`)) n++;
  const id = `my-${n}`;
  const own: OwnDashboard = { id, name: cleanName(name) ?? freeName(d, kind, "My dashboard"), layout };
  return [withKind(d, kind, { own: [...d[kind].own, own], active: id }), id];
}

/** The user's own renamed; presets keep their names. */
export function rename(d: Dashboards, kind: GridKind, id: string, name: string): Dashboards {
  const clean = cleanName(name);
  if (clean == null) return d;
  return withKind(d, kind, { own: d[kind].own.map((o) => (o.id === id ? { ...o, name: clean } : o)) });
}

/** The user's own deleted (the first preset shown if it was); presets can't be. */
export function remove(d: Dashboards, kind: GridKind, id: string): Dashboards {
  if (presetOf(kind, id)) return d;
  return withKind(d, kind, { own: d[kind].own.filter((o) => o.id !== id), active: d[kind].active === id ? FIRST : d[kind].active });
}

/** A preset back as it ships. */
export function resetPreset(d: Dashboards, kind: GridKind, id: string): Dashboards {
  const { [id]: _, ...edited } = d[kind].edited;
  return withKind(d, kind, { edited });
}

/** Validates and repairs stored dashboards; what's unusable is dropped (a kind that is, starts empty). */
export function parseDashboards(raw: unknown, widgets: ReadonlyMap<string, WidgetDefinition>, columns = COLUMNS): Dashboards | null {
  if (!isObject(raw) || raw.version !== 1) return null;
  const out = emptyDashboards();
  for (const kind of KINDS) {
    const k = raw[kind];
    if (!isObject(k)) continue;
    const edited: Record<string, Layout> = {};
    if (isObject(k.edited)) {
      for (const [id, l] of Object.entries(k.edited)) {
        const layout = presetOf(kind, id) ? parseLayout(l, widgets, columns, kind) : null;
        if (layout) edited[id] = layout;
      }
    }
    const own: OwnDashboard[] = [];
    if (Array.isArray(k.own)) {
      for (const o of k.own) {
        if (!isObject(o) || typeof o.id !== "string" || !DASHBOARD_ID.test(o.id) || presetOf(kind, o.id) || own.some((x) => x.id === o.id)) continue;
        const name = typeof o.name === "string" ? cleanName(o.name) : null;
        // One whose widgets are all gone (or that was left empty) shows the first preset, as a saved layout did.
        own.push({ id: o.id, name: name ?? "My dashboard", layout: parseLayout(o.layout, widgets, columns, kind) ?? PRESETS[kind][0].layout });
      }
    }
    out[kind] = { active: typeof k.active === "string" ? k.active : FIRST, edited, own };
    out[kind].active = activeOf(out, kind);
  }
  return out;
}

/** The layouts saved before dashboards, as each kind's Overview edited. */
function fromSavedLayouts(widgets: ReadonlyMap<string, WidgetDefinition>): Dashboards {
  const out = emptyDashboards();
  for (const kind of KINDS) {
    try {
      const saved = globalThis.localStorage?.getItem(storageKey(kind));
      const layout = saved != null ? parseLayout(JSON.parse(saved), widgets, COLUMNS, kind) : null;
      if (layout) out[kind].edited[FIRST] = layout;
    } catch {
      // Unreadable: the preset.
    }
  }
  return out;
}

/** The saved dashboards (or, the first time, the layouts saved before them). Never throws. */
export function loadDashboards(widgets: ReadonlyMap<string, WidgetDefinition>): Dashboards {
  try {
    const saved = globalThis.localStorage?.getItem(DASHBOARDS_KEY);
    if (saved == null) return fromSavedLayouts(widgets);
    return parseDashboards(JSON.parse(saved), widgets) ?? emptyDashboards();
  } catch {
    return emptyDashboards();
  }
}

export function saveDashboards(d: Dashboards): void {
  try {
    globalThis.localStorage?.setItem(DASHBOARDS_KEY, JSON.stringify({ version: 1, ...d }));
  } catch {
    // Full or blocked storage: they last until the page closes.
  }
}
