// A block's definition: what it is, how it's shaped on the grid, and its component (H3.2).

import type { ComponentType } from "react";
import type { DriverInfo } from "../types";
import type { SessionInfo, SessionKind, Track } from "./select";

/**
 * API gap: layout px per grid column. A block is laid out at its default width in columns times this,
 * at every screen size and width (the grid zooms it to fit), so a shape can come from content in px.
 */
export const COLUMN_WIDTH = 144;

/** Settings are stored in the layout (H3.11), so they're plain JSON. */
export type SettingValue = string | number | boolean | null | SettingValue[] | { [key: string]: SettingValue };
export type BlockSettings = Record<string, SettingValue>;

/** The `driver` setting read by useSelectedDriver(): follow the selection, or pinned to a car number. */
export type DriverSetting = "follow-selection" | number;

/** What a shape can depend on: session info, never live data (H3.8). */
export interface ShapeInput {
  info: SessionInfo;
  drivers: readonly DriverInfo[];
  track: Track;
}

export interface BlockDefinition<S extends BlockSettings = BlockSettings> {
  /** Kebab-case, unique: also the block's folder and its key in the layout. */
  id: string;
  name: string;
  /** Semver of the block itself; the layout pins it (H3.11). */
  version: string;
  /** Width : height, or a function of session info. */
  shape: number | ((input: ShapeInput) => number);
  /** In grid columns. */
  width: { min: number; default: number; max: number };
  sessions: readonly SessionKind[];
  /** Defaults; the layout stores the user's changes on top. */
  settings: S;
  Component: ComponentType;
}

const ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

/** Checks and returns a block definition (the checks H3.15's CI runs on submissions start here). */
export function defineBlock<S extends BlockSettings>(def: BlockDefinition<S>): BlockDefinition<S> {
  const fail = (why: string) => {
    throw new Error(`Block "${def.id}": ${why}`);
  };
  if (!ID.test(def.id)) fail("id must be kebab-case (a-z, 0-9, dashes)");
  if (!def.name.trim()) fail("name is empty");
  if (!SEMVER.test(def.version)) fail(`version "${def.version}" isn't semver (e.g. 1.0.0)`);
  const { min, default: initial, max } = def.width;
  if (![min, initial, max].every((w) => Number.isInteger(w) && w >= 1) || !(min <= initial && initial <= max)) {
    fail("width needs whole columns with 1 <= min <= default <= max");
  }
  if (typeof def.shape === "number" && !(def.shape > 0 && Number.isFinite(def.shape))) fail("shape must be a positive ratio");
  if (def.sessions.length === 0) fail("sessions is empty");
  return def;
}
