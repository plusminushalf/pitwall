// Fetching the driver history files (src/history/types.ts), built at deploy by scripts/circuit-history.ts.

import { fetchHistoryFile } from "./circuits";
import { DRIVER_HISTORY_FORMAT, type DriverHistory, type DriverIndex, type DriverTotals } from "./types";

/** Where the build puts them, relative to the site root. */
export const DRIVERS_DIR = "/history/drivers";

/** F1DB's driver ids: "max-verstappen", "carlos-sainz-jr". */
export const DRIVER_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** A driver's seasons, or null if there's no such driver (or the deploy built none). */
export const fetchDriverHistory = (id: string, signal?: AbortSignal) =>
  DRIVER_ID.test(id) ? fetchHistoryFile<DriverHistory>(`${DRIVERS_DIR}/${id}.json`, signal, DRIVER_HISTORY_FORMAT) : Promise.resolve(null);

/** The season's drivers. */
export const fetchDriverIndex = (signal?: AbortSignal) => fetchHistoryFile<DriverIndex>(`${DRIVERS_DIR}/index.json`, signal, DRIVER_HISTORY_FORMAT);

/** Two stretches of a career together. */
export const sumTotals = (a: DriverTotals, b: DriverTotals): DriverTotals => ({
  starts: a.starts + b.starts,
  wins: a.wins + b.wins,
  podiums: a.podiums + b.podiums,
  poles: a.poles + b.poles,
  fastestLaps: a.fastestLaps + b.fastestLaps,
  points: Math.round((a.points + b.points) * 100) / 100,
  titles: a.titles + b.titles,
});
