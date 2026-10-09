// When in a session a share card was made, for its heading: a card made mid-session reads as the result otherwise.
// Pure.

import { qualiPhaseAt } from "../engine/qualiPhase";
import type { RaceState } from "../engine/raceState";
import { raceClock } from "../lib/format";
import type { SessionMeta } from "../types";

type Meta = Pick<SessionMeta, "quali" | "qualiLive" | "practice" | "drivers" | "totalLaps" | "chequered">;

/**
 * A race's lap ("Lap 23 of 57"); qualifying's segment and its clock ("SQ3 · 0:16 left", "Q2 · red flag", "Q3 · after
 * the flag" while the laps started before it finish, "After Q1"); practice's clock ("12:40 left"). Null before the
 * start and once the session is over: the card is of the whole session then.
 */
export function sessionMoment(meta: Meta, race: Pick<RaceState, "t" | "raceTime" | "leaderLap">): string | null {
  if (meta.qualiLive) {
    const phase = qualiPhaseAt(meta, race.t);
    const { segment } = phase;
    if (!segment) return null;
    if (phase.red) return `${segment.name} · red flag`;
    if (phase.running) return `${segment.name} · ${raceClock(phase.left + 999)} left`;
    if (!phase.settled) return `${segment.name} · after the flag`;
    return segment.advance == null ? null : `After ${segment.name}`;
  }
  if (meta.practice) {
    if (race.raceTime < 0 || (meta.chequered != null && race.t >= meta.chequered)) return null;
    return `${raceClock(Math.max(0, meta.practice.scheduledEnd - race.t) + 999)} left`;
  }
  // (Qualifying stored before it was timed as live has no replay: its laps compared are of the whole session.)
  if (meta.quali) return null;
  return race.leaderLap > 0 ? `Lap ${race.leaderLap} of ${meta.totalLaps}` : null;
}
