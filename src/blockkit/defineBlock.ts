// A block's definition: what it is, how it sits on the grid, and its component (H3.2).

import type { ComponentType } from "react";
import type { DriverInfo } from "../types";
import type { SessionInfo, SessionKind, Track } from "./select";

/** Settings are stored in the layout (H3.11), so they're plain JSON. */
export type SettingValue = string | number | boolean | null | SettingValue[] | { [key: string]: SettingValue };
export type BlockSettings = Record<string, SettingValue>;

/** The `driver` setting read by useSelectedDriver(): follow the selection, or pinned to a car number. */
export type DriverSetting = "follow-selection" | number;

/**
 * What a block's height can depend on: session info, the selection and the block's own settings, never
 * live data, so the layout doesn't move while the race plays.
 */
export interface HeightInput<S extends BlockSettings = BlockSettings> {
  info: SessionInfo;
  drivers: readonly DriverInfo[];
  track: Track;
  selection: { selected: readonly number[]; focused: number | null };
  /** The block's settings: its defaults with the layout's on top. */
  settings: S;
}

/** CSS px, or CSS px worked out from the height input. */
export type Px<S extends BlockSettings = BlockSettings> = number | ((input: HeightInput<S>) => number);

export interface BlockDefinition<S extends BlockSettings = BlockSettings> {
  /** Kebab-case, unique: also the block's folder and its key in the layout. */
  id: string;
  name: string;
  /** Semver of the block itself; the layout pins it (H3.11). */
  version: string;
  /**
   * The block's height in CSS px: fixed (what its contents take at the fixed type size), or `{ min }` to
   * stretch: the last stretching block in each grid column fills the column to the bottom of the screen.
   */
  height: Px<S> | { min: Px<S> };
  /** In percent of the grid's width (the grid snaps it to whole columns): the same at any column count. */
  width: { min: number; default: number; max: number };
  sessions: readonly SessionKind[];
  /** Defaults; the layout stores the user's changes on top. */
  settings: S;
  Component: ComponentType;
}

const ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

/** Whether the block stretches to fill its column. */
export const stretches = (block: Pick<BlockDefinition, "height">): block is { height: { min: Px } } => typeof block.height === "object";

/** Checks and returns a block definition (the checks H3.15's CI runs on submissions start here). */
export function defineBlock<S extends BlockSettings>(def: BlockDefinition<S>): BlockDefinition<S> {
  const fail = (why: string) => {
    throw new Error(`Block "${def.id}": ${why}`);
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
  return def;
}
