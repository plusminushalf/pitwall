// The default race screen as widgets (H3.12): the race at a glance on top, the analysis of it underneath, as
// arranged on the user's own screen (2026-10-02). Across the top the timing tower (gaps as intervals) and
// the track map, both 21 rows tall; under them the gap chart over the stint pace, then battles and pit
// stops; the race feed down the right, full height. The driver panel's widgets and weather (it's in the top
// bar) are in the widget picker.
//
// Free practice (saved as a layout of its own) is laid out the same way: the session at a glance on top (the tower,
// its gaps to the fastest lap, and the map), and under them what practice is watched for: long runs (the race
// simulations) under the tower and the stint pace (a driver's laps on each set) under the map; the feed down the
// right.
//
// Each kind also ships dashboards for one use (dashboards.ts): Strategy (the tower with the tyres under it, the gaps
// over the stint pace and the pit stops), Telemetry (the tower and the map beside the selected drivers' laps
// overlaid) and Circuit history (the tower and the map beside the earlier races at the circuit). Their widths stay
// inside each widget's range at COLUMNS.
//
// Widths are whole columns of COLUMNS; the tower is wide enough for its sector columns from about 1500 px.
// The bottom row fits from a 738 px grid (21 rows, the gap chart's and the stint pace's minimums and the
// hairlines over them; 1440x900's grid is 767); on a shorter window it's cut off, as for any layout.

import { COLUMNS, ROW, type Layout, type LayoutEntry } from "./layout";
import type { GridKind } from "./storage";

/** The tower's and the map's height: 21 rows, set like a height chosen in edit mode. */
const TOP = 21 * ROW;
const TOWER = 15;
const MAP = 15;
const FEED = COLUMNS - TOWER - MAP;
/** The gap chart and the stint pace, under the tower and one column of the map; battles and pit stops share the rest. */
const CHARTS = 16;
const SIDE = (TOWER + MAP - CHARTS) / 2;

const at = (x: number, y: number, width: number, extra: Partial<LayoutEntry> = {}): LayoutEntry => ({ widgetVersion: "1.0.0", x, y, width, settings: {}, ...extra });

export const DEFAULT_LAYOUT: Layout = {
  version: 1,
  columns: COLUMNS,
  widgets: {
    "timing-tower": at(0, 0, TOWER, { height: TOP, settings: { gapMode: "interval" } }),
    "track-map": at(TOWER, 0, MAP, { height: TOP }),
    "race-feed": at(TOWER + MAP, 0, FEED),
    "gap-chart": at(0, 1, CHARTS),
    battles: at(CHARTS, 1, SIDE),
    "pit-strategy": at(CHARTS + SIDE, 1, SIDE),
    "stint-pace": at(0, 2, CHARTS),
  },
};

export const PRACTICE_LAYOUT: Layout = {
  version: 1,
  columns: COLUMNS,
  widgets: {
    "timing-tower": at(0, 0, TOWER, { height: TOP }),
    "track-map": at(TOWER, 0, MAP, { height: TOP }),
    "race-feed": at(TOWER + MAP, 0, FEED),
    "long-runs": at(0, 1, TOWER),
    "stint-pace": at(TOWER, 1, MAP),
  },
};

export const DEFAULT_LAYOUTS: Record<GridKind, Layout> = { race: DEFAULT_LAYOUT, practice: PRACTICE_LAYOUT };

/** Strategy: the tower down the left with the selected driver's tyres under it; the gaps over the stint pace and pit stops. */
const STRATEGY_TOWER = 13;
const STRATEGY_PACE = 17;
export const STRATEGY_LAYOUT: Layout = {
  version: 1,
  columns: COLUMNS,
  widgets: {
    "timing-tower": at(0, 0, STRATEGY_TOWER),
    "gap-chart": at(STRATEGY_TOWER, 0, COLUMNS - STRATEGY_TOWER, { height: 16 * ROW }),
    "tyre-strip": at(0, 1, STRATEGY_TOWER),
    "stint-pace": at(STRATEGY_TOWER, 1, STRATEGY_PACE),
    "pit-strategy": at(STRATEGY_TOWER + STRATEGY_PACE, 1, COLUMNS - STRATEGY_TOWER - STRATEGY_PACE),
  },
};

/** Telemetry: the tower (to pick whose laps) over the map down the left; the lap comparison filling the rest. */
const TELEMETRY_TOWER = 12;
export const TELEMETRY_LAYOUT: Layout = {
  version: 1,
  columns: COLUMNS,
  widgets: {
    "timing-tower": at(0, 0, TELEMETRY_TOWER, { height: TOP }),
    "track-map": at(0, 1, TELEMETRY_TOWER),
    "lap-compare": at(TELEMETRY_TOWER, 0, COLUMNS - TELEMETRY_TOWER),
  },
};

/**
 * Circuit history: the tower over the map down the left; earlier races at the circuit beside them, safety cars and
 * overtakes, race pace and the pit lane in pairs, strategies under them.
 */
const HISTORY_SIDE = 13;
const HISTORY_HALF = Math.floor((COLUMNS - HISTORY_SIDE) / 2);
export const CIRCUIT_LAYOUT: Layout = {
  version: 1,
  columns: COLUMNS,
  widgets: {
    "timing-tower": at(0, 0, HISTORY_SIDE, { height: TOP }),
    "track-map": at(0, 1, HISTORY_SIDE),
    "safety-cars": at(HISTORY_SIDE, 0, HISTORY_HALF),
    "overtakes-history": at(HISTORY_SIDE + HISTORY_HALF, 0, COLUMNS - HISTORY_SIDE - HISTORY_HALF),
    "race-pace": at(HISTORY_SIDE, 1, HISTORY_HALF),
    "pit-history": at(HISTORY_SIDE + HISTORY_HALF, 1, COLUMNS - HISTORY_SIDE - HISTORY_HALF),
    "strategy-history": at(HISTORY_SIDE, 2, COLUMNS - HISTORY_SIDE),
  },
};
