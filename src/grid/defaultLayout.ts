// The default race screen as blocks (H3.12): the race at a glance on top, the analysis of it underneath, as
// arranged on the user's own screen (2026-10-02). Across the top the timing tower (gaps as intervals) and
// the track map, both 21 rows tall; under them the gap chart over the stint pace, then battles and pit
// stops; the race feed down the right, full height. The driver panel's blocks and weather (it's in the top
// bar) are in the block picker.
//
// Widths are whole columns of COLUMNS; the tower is wide enough for its sector columns from about 1500 px.
// The bottom row fits from a 738 px grid (21 rows, the gap chart's and the stint pace's minimums and the
// hairlines over them; 1440x900's grid is 767); on a shorter window it's cut off, as for any layout.

import { COLUMNS, ROW, type Layout, type LayoutEntry } from "./layout";

/** The tower's and the map's height: 21 rows, set like a height chosen in edit mode. */
const TOP = 21 * ROW;
const TOWER = 15;
const MAP = 15;
const FEED = COLUMNS - TOWER - MAP;
/** The gap chart and the stint pace, under the tower and one column of the map; battles and pit stops share the rest. */
const CHARTS = 16;
const SIDE = (TOWER + MAP - CHARTS) / 2;

const at = (x: number, y: number, width: number, extra: Partial<LayoutEntry> = {}): LayoutEntry => ({ blockVersion: "1.0.0", x, y, width, settings: {}, ...extra });

export const DEFAULT_LAYOUT: Layout = {
  version: 1,
  columns: COLUMNS,
  blocks: {
    "timing-tower": at(0, 0, TOWER, { height: TOP, settings: { gapMode: "interval" } }),
    "track-map": at(TOWER, 0, MAP, { height: TOP }),
    "race-feed": at(TOWER + MAP, 0, FEED),
    "gap-chart": at(0, 1, CHARTS),
    battles: at(CHARTS, 1, SIDE),
    "pit-strategy": at(CHARTS + SIDE, 1, SIDE),
    "stint-pace": at(0, 2, CHARTS),
  },
};
