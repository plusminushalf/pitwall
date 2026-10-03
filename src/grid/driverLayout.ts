// The driver-panel layout: the default race screen until 2026-10-02 (H3.12), laid out like the screen before
// widgets: the tower on the left, the map filling the middle, and the driver panel on the right (header, speed
// and gear beside the bars, the 60 s trace, lap times and sectors, tyres) with the race feed filling the rest.
// The app no longer places it; the grid's tests use it as a full, realistic layout.
//
// That screen had fixed-width sides (tower 410 px, panel 360 px, the bars 112 px into it); here the sides
// are the nearest whole number of columns at REFERENCE_WIDTH, so on wider or narrower screens they grow
// and shrink with it. The speed column is the fewest columns its contents (109 px) fit in at MIN_WIDTH.

import { COLUMNS, type Layout, type LayoutEntry } from "./layout";

/** The screen width (CSS px) the default layout matches the old widths at: the user's window. */
export const REFERENCE_WIDTH = 1720;
/** The narrowest screen the default layout keeps every widget's contents whole at. */
export const MIN_WIDTH = 1440;

const cols = (px: number) => Math.max(1, Math.round((px * COLUMNS) / REFERENCE_WIDTH));
const TOWER = cols(410);
const PANEL = cols(360);
const SPEED = Math.ceil((109 * COLUMNS) / MIN_WIDTH);
const MAP = COLUMNS - TOWER - PANEL;
const RIGHT = COLUMNS - PANEL;

const at = (x: number, y: number, width: number, group?: string): LayoutEntry => ({ widgetVersion: "1.0.0", x, y, width, ...(group && { group }), settings: {} });

export const DRIVER_LAYOUT: Layout = {
  version: 1,
  columns: COLUMNS,
  widgets: {
    "timing-tower": at(0, 0, TOWER),
    "track-map": at(TOWER, 0, MAP),
    "driver-header": at(RIGHT, 0, PANEL),
    "speed-gear": at(RIGHT, 1, SPEED, "telemetry"),
    "throttle-brake-rpm": at(RIGHT + SPEED, 1, PANEL - SPEED, "telemetry"),
    "speed-trace": at(RIGHT, 2, PANEL, "telemetry"),
    "lap-times": at(RIGHT, 3, PANEL, "laps"),
    sectors: at(RIGHT, 4, PANEL, "laps"),
    "tyre-strip": at(RIGHT, 5, PANEL),
    "race-feed": at(RIGHT, 6, PANEL),
  },
};
