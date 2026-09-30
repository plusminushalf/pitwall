// Race distance at t, spoiler-free. meta.totalLaps comes from the results (laps the winner did), so a
// race cut short by a red flag or the time limit would show its reduced distance from lap 1. Like the
// TV graphics, show the scheduled distance until the shortening is known in the race: an extra
// formation lap before the start (one lap off, announced by race control), or the chequered flag.

import type { SessionMeta } from "../types";

/**
 * Scheduled laps by OpenF1 circuit short name (current layouts). OpenF1 has no scheduled distance;
 * a circuit missing here falls back to meta.totalLaps.
 */
const RACE_LAPS: Readonly<Record<string, number>> = {
  Sakhir: 57,
  Jeddah: 50,
  Melbourne: 58,
  Suzuka: 53,
  Shanghai: 56,
  Miami: 57,
  Imola: 63,
  "Monte Carlo": 78,
  Catalunya: 66,
  Montreal: 70,
  Spielberg: 71,
  Silverstone: 52,
  "Spa-Francorchamps": 44,
  Hungaroring: 70,
  Zandvoort: 72,
  Monza: 53,
  Madring: 57,
  Baku: 51,
  Singapore: 62,
  Austin: 56,
  "Mexico City": 71,
  Interlagos: 71,
  "Las Vegas": 50,
  Lusail: 57,
  "Yas Marina Circuit": 58,
};

const SPRINT_LAPS: Readonly<Record<string, number>> = {
  Shanghai: 19,
  Miami: 19,
  Montreal: 23,
  Spielberg: 24,
  Silverstone: 17,
  "Spa-Francorchamps": 15,
  Zandvoort: 24,
  Baku: 17,
  Austin: 19,
  Interlagos: 24,
  Lusail: 19,
};

export interface RaceDistance {
  totalLaps: number;
  /** Live, no scheduled distance known: totalLaps is estimated from the lap length. */
  estimated: boolean;
}

type DistanceMeta = Pick<SessionMeta, "circuit" | "sessionName" | "totalLaps" | "totalLapsEstimated" | "quali">;

/** The distance the race was scheduled over, known before it starts. */
export function scheduledDistance(meta: DistanceMeta): RaceDistance {
  const estimated = meta.totalLapsEstimated ?? false;
  const table = meta.quali ? undefined : (/sprint/i.test(meta.sessionName) ? SPRINT_LAPS : RACE_LAPS)[meta.circuit];
  if (table == null) return { totalLaps: meta.totalLaps, estimated };
  // Live, meta.totalLaps is only an estimate; in a replay no race runs over its schedule, so a
  // results count above the table means the table is stale for this layout.
  return { totalLaps: estimated ? table : Math.max(table, meta.totalLaps), estimated: false };
}

type TimedMeta = DistanceMeta & Pick<SessionMeta, "chequered" | "lightsOut" | "raceControl">;

const extraFormationLaps = new WeakMap<object, number[]>();

/** Race control's extra formation laps before the start; each takes a lap off the distance. */
function extraFormationLapTimes(meta: TimedMeta): number[] {
  let times = extraFormationLaps.get(meta);
  if (!times) {
    times = meta.raceControl.filter((m) => m.t < meta.lightsOut && /EXTRA FORMATION LAP/i.test(m.message)).map((m) => m.t);
    extraFormationLaps.set(meta, times);
  }
  return times;
}

/** Race distance as known at t: the scheduled laps, less announced extra formation laps, until the chequered flag. */
export function raceDistanceAt(meta: TimedMeta, t: number): RaceDistance {
  if (meta.quali || (meta.chequered != null && t >= meta.chequered)) {
    return { totalLaps: meta.totalLaps, estimated: meta.totalLapsEstimated ?? false };
  }
  const scheduled = scheduledDistance(meta);
  const off = extraFormationLapTimes(meta).filter((at) => at <= t).length;
  return { totalLaps: Math.max(1, scheduled.totalLaps - off), estimated: scheduled.estimated };
}
