// A widget's definition: what it is, how it sits on the grid, and its component (H3.2).

import type { ComponentType } from "react";
import type { DriverInfo } from "../types";
import type { SessionInfo, SessionKind, Track } from "./select";

/** Settings are stored in the layout (H3.11), so they're plain JSON. */
export type SettingValue = string | number | boolean | null | SettingValue[] | { [key: string]: SettingValue };
export type WidgetSettings = Record<string, SettingValue>;

/** The `driver` setting read by useSelectedDriver(): follow the selection, or pinned to a car number. */
export type DriverSetting = "follow-selection" | number;

/**
 * What a widget's height can depend on: session info, the selection and the widget's own settings, never
 * live data, so the layout doesn't move while the race plays.
 */
export interface HeightInput<S extends WidgetSettings = WidgetSettings> {
  info: SessionInfo;
  drivers: readonly DriverInfo[];
  track: Track;
  selection: { selected: readonly number[]; focused: number | null };
  /** The widget's settings: its defaults with the layout's on top. */
  settings: S;
}

/** How the generic settings editor shows one setting. */
export type SettingField =
  | { kind: "choice"; label: string; options: readonly { value: string | number | boolean; label: string }[] }
  /** "Follow selection" or pinned to one of the session's drivers. */
  | { kind: "driver"; label?: string }
  | { kind: "toggle"; label: string }
  | { kind: "number"; label: string; min?: number; max?: number; step?: number };

/** The widget picker's tabs, in order. A widget is listed under one. */
export const WIDGET_GROUPS = [
  { id: "session", label: "Session" },
  { id: "driver", label: "Driver" },
  { id: "telemetry", label: "Telemetry" },
  { id: "analysis", label: "Analysis" },
  { id: "circuit", label: "Circuit" },
] as const;
export type WidgetGroup = (typeof WIDGET_GROUPS)[number]["id"];

/** CSS px, or CSS px worked out from the height input. */
export type Px<S extends WidgetSettings = WidgetSettings> = number | ((input: HeightInput<S>) => number);

export interface WidgetDefinition<S extends WidgetSettings = WidgetSettings> {
  /** Kebab-case, unique: also the widget's folder and its key in the layout. */
  id: string;
  name: string;
  /**
   * The picker heading it's listed under: session (the whole field and the circuit), driver (one driver's race),
   * telemetry (the car's inputs), analysis (the race lap by lap), circuit (earlier races at the circuit, from
   * useCircuitRaces(); these also show on the circuit's page, where there's no session).
   */
  group: WidgetGroup;
  /** Semver of the widget itself; the layout pins it (H3.11). */
  version: string;
  /**
   * The widget's height in CSS px: fixed (what its contents take at the fixed type size), or `{ min }` to
   * stretch: the last stretching widget in each grid column fills the column to the bottom of the screen.
   */
  height: Px<S> | { min: Px<S> };
  /** In percent of the grid's width (the grid snaps it to whole columns): the same at any column count. */
  width: { min: number; default: number; max: number };
  sessions: readonly SessionKind[];
  /** Defaults; the layout stores the user's changes on top. */
  settings: S;
  /** One line for the widget picker. */
  description?: string;
  /**
   * How the settings editor shows each setting. Without an entry: `driver` -> a driver field, booleans ->
   * toggle, numbers -> number; other settings aren't shown.
   */
  fields?: { [K in keyof NoInfer<S>]?: SettingField };
  Component: ComponentType;
}

const ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

/** Whether the widget stretches to fill its column. */
export const stretches = (widget: Pick<WidgetDefinition, "height">): widget is { height: { min: Px } } => typeof widget.height === "object";

/** "gapMode" -> "Gap mode". */
const labelOf = (key: string) => {
  const words = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[-_]+/g, " ").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** The field the settings editor uses for `key` (declared, else inferred as above), or null if it isn't shown. */
export function settingField(widget: WidgetDefinition<any>, key: string): SettingField | null {
  if (!Object.hasOwn(widget.settings, key)) return null;
  const declared = widget.fields?.[key];
  if (declared) return declared;
  if (key === "driver") return { kind: "driver" };
  const value = widget.settings[key];
  if (typeof value === "boolean") return { kind: "toggle", label: labelOf(key) };
  if (typeof value === "number") return { kind: "number", label: labelOf(key) };
  return null;
}

/** Checks and returns a widget definition (the checks H3.15's CI runs on submissions start here). */
export function defineWidget<S extends WidgetSettings>(def: WidgetDefinition<S>): WidgetDefinition<S> {
  const fail = (why: string) => {
    throw new Error(`Widget "${def.id}": ${why}`);
  };
  if (!ID.test(def.id)) fail("id must be kebab-case (a-z, 0-9, dashes)");
  if (!def.name.trim()) fail("name is empty");
  if (!SEMVER.test(def.version)) fail(`version "${def.version}" isn't semver (e.g. 1.0.0)`);
  const { min, default: initial, max } = def.width;
  if (![min, initial, max].every((w) => Number.isFinite(w) && w > 0 && w <= 100) || !(min <= initial && initial <= max)) {
    fail("width needs percentages with 0 < min <= default <= max <= 100");
  }
  const px = typeof def.height === "object" ? def.height.min : def.height;
  if (typeof px === "number" && !(px >= 0 && Number.isFinite(px))) fail("height must be a non-negative number of px");
  if (def.sessions.length === 0) fail("sessions is empty");
  for (const [key, field] of Object.entries(def.fields ?? {}) as [string, SettingField | undefined][]) {
    if (!Object.hasOwn(def.settings, key)) fail(`fields.${key} isn't a setting`);
    if (field?.kind === "choice" && !field.options.some((o) => o.value === def.settings[key])) {
      fail(`fields.${key}: the default ${JSON.stringify(def.settings[key])} isn't one of its options`);
    }
  }
  return def;
}
