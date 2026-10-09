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
// over the stint pace and the pit stops, races only), Telemetry (the tower and the map beside the selected drivers'
// laps overlaid) and, for practice, Debrief (what the session says). Live qualifying has an Overview of its own and
// Telemetry. Their widths stay inside each widget's range at
// COLUMNS. The circuit widgets have no dashboard: a circuit's page shows them.
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

/**
 * Live qualifying: the tower down the left, full height (the order by segment and its cut is what's watched), the map
 * and the feed beside it, and under them the push laps being driven, the ones followed drawn as they go.
 */
const QUALI_TOWER = 14;
const QUALI_MAP = 13;
export const QUALI_LAYOUT: Layout = {
  version: 1,
  columns: COLUMNS,
  widgets: {
    "timing-tower": at(0, 0, QUALI_TOWER),
    "track-map": at(QUALI_TOWER, 0, QUALI_MAP, { height: TOP }),
    "race-feed": at(QUALI_TOWER + QUALI_MAP, 0, COLUMNS - QUALI_TOWER - QUALI_MAP, { height: TOP }),
    "live-laps": at(QUALI_TOWER, 1, COLUMNS - QUALI_TOWER),
  },
};

export const DEFAULT_LAYOUTS: Record<GridKind, Layout> = { race: DEFAULT_LAYOUT, practice: PRACTICE_LAYOUT, qualifying: QUALI_LAYOUT };

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
 * FP1 debrief: what a first practice says, in three columns of two. One-lap pace on the left (the order with the tyre
 * each best was on, and the push laps per set: how a set holds up for a second push), where the time is in the
 * middle (sectors and top speed against lap time: the drag levels), and the session on the right (each team's
 * programme, and how much the track came to the cars). The top row is 23 rows tall (run plans fits 22 drivers); the bottom row takes the rest.
 */
const DEBRIEF_TOP = 23 * ROW;
const DEBRIEF_SIDE = 12;
export const DEBRIEF_LAYOUT: Layout = {
  version: 1,
  columns: COLUMNS,
  widgets: {
    "pace-order": at(0, 0, DEBRIEF_SIDE, { height: DEBRIEF_TOP }),
    "sector-strengths": at(DEBRIEF_SIDE, 0, DEBRIEF_SIDE, { height: DEBRIEF_TOP }),
    "run-plans": at(2 * DEBRIEF_SIDE, 0, COLUMNS - 2 * DEBRIEF_SIDE, { height: DEBRIEF_TOP }),
    "push-laps": at(0, 1, DEBRIEF_SIDE),
    "speed-vs-pace": at(DEBRIEF_SIDE, 1, DEBRIEF_SIDE),
    "track-evolution": at(2 * DEBRIEF_SIDE, 1, COLUMNS - 2 * DEBRIEF_SIDE),
  },
};
