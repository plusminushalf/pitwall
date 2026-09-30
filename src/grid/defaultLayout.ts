// Today's screen as blocks (H3.12): tower on the left, map in the middle with the 60 s trace under it,
// the driver blocks stacked on the right above the feed, weather under the tower.

import { COLUMNS, type Layout } from "./layout";

const at = (x: number, y: number, width: number) => ({ blockVersion: "1.0.0", x, y, width, settings: {} });

export const DEFAULT_LAYOUT: Layout = {
  version: 1,
  columns: COLUMNS,
  blocks: {
    "timing-tower": at(0, 0, 3),
    weather: at(0, 19, 1),
    "track-map": at(3, 0, 4),
    "speed-trace": at(3, 13, 4),
    "driver-header": at(7, 0, 3),
    "speed-gear": at(7, 3, 1),
    "throttle-brake-rpm": at(8, 3, 2),
    "lap-times": at(7, 5, 3),
    sectors: at(7, 7, 3),
    "tyre-strip": at(7, 8, 3),
    "race-feed": at(7, 10, 3),
  },
};
