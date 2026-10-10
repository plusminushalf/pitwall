// Fetching the driver and team history files (src/history/types.ts), built at deploy by scripts/circuit-history.ts.

import { fetchHistoryFile } from "./circuits";
import { DRIVER_HISTORY_FORMAT, type DriverHistory, type DriverIndex, type TeamHistory, type TeamIndex } from "./types";

/** F1DB's driver and constructor ids: "max-verstappen", "carlos-sainz-jr", "red-bull". */
export const CAREER_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const file = <T extends { format: number }>(path: string, signal?: AbortSignal) => fetchHistoryFile<T>(path, signal, DRIVER_HISTORY_FORMAT);

/** A driver's seasons and races, or null if there's no such driver (or the deploy built none). */
export const fetchDriverHistory = (id: string, signal?: AbortSignal) =>
  CAREER_ID.test(id) ? file<DriverHistory>(`/history/drivers/${id}.json`, signal) : Promise.resolve(null);

/** A team's seasons and races, or null. */
export const fetchTeamHistory = (id: string, signal?: AbortSignal) =>
  CAREER_ID.test(id) ? file<TeamHistory>(`/history/teams/${id}.json`, signal) : Promise.resolve(null);

/** The season's drivers, and its teams. */
export const fetchDriverIndex = (signal?: AbortSignal) => file<DriverIndex>("/history/drivers/index.json", signal);
export const fetchTeamIndex = (signal?: AbortSignal) => file<TeamIndex>("/history/teams/index.json", signal);

/** In championship order: the leader first, the unclassified last (in the order given). */
export const byStanding = <T extends { season: { position: number | null } }>(list: readonly T[]): T[] =>
  [...list].sort((a, b) => (a.season.position ?? Infinity) - (b.season.position ?? Infinity));

/** Two stretches of a career together: every count added. */
export function sumTotals<T extends object>(a: T, b: T): T {
  const out = { ...a } as Record<string, number>;
  for (const [k, v] of Object.entries(b)) out[k] = Math.round(((out[k] ?? 0) + (v as number)) * 100) / 100;
  return out as T;
}
