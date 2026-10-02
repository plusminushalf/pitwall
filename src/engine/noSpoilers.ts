// No-spoiler mode: the timeline shows only what has been watched. Its length mustn't give the race
// away either (a long red flag, a race cut short), so until the chequered flag has been watched it
// spans the scheduled distance at the race's typical lap time, growing if the race runs longer.
// Practice runs to the clock: until the flag, the timeline ends at the scheduled end.

import type { Ms, SessionMeta } from "../types";
import { scheduledDistance } from "./raceDistance";

/** Races run a little longer than laps × median lap (safety cars, pit stops, the leader's own laps). */
const PROJECTION_MARGIN = 1.05;
/** Racing time is capped at 2 hours (suspensions not counted). */
const TIME_LIMIT_MS = 2 * 3_600_000;
/** Replays keep this much after the flag (scripts/lib/normalize.ts). */
const POST_FINISH_MS = 3 * 60_000;
/** No timed laps at all: a typical lap. */
const FALLBACK_LAP_MS = 95_000;

type Meta = Pick<
  SessionMeta,
  "circuit" | "sessionName" | "totalLaps" | "totalLapsEstimated" | "quali" | "practice" | "laps" | "lightsOut" | "chequered" | "duration"
>;

const projections = new WeakMap<object, Ms>();

/** When the race would end over its scheduled distance at its median lap time (with the cool-down after the flag). */
export function projectedEnd(meta: Meta): Ms {
  let end = projections.get(meta);
  if (end == null && meta.practice) {
    end = meta.practice.scheduledEnd + POST_FINISH_MS;
    projections.set(meta, end);
  }
  if (end == null) {
    const laps = meta.laps.flatMap((l) => (l.duration != null ? [l.duration * 1000] : [])).sort((a, b) => a - b);
    const typical = laps.length > 0 ? laps[laps.length >> 1] : FALLBACK_LAP_MS;
    const racing = Math.min(scheduledDistance(meta).totalLaps * typical * PROJECTION_MARGIN, TIME_LIMIT_MS);
    end = Math.round(meta.lightsOut + racing + POST_FINISH_MS);
    projections.set(meta, end);
  }
  return end;
}

/** Where the timeline ends in no-spoiler mode, `watchedTo` being the furthest time watched. */
export function spoilerFreeEnd(meta: Meta, watchedTo: Ms): Ms {
  // Past the flag the real end is no secret.
  if (watchedTo >= (meta.chequered ?? meta.duration)) return meta.duration;
  return Math.max(projectedEnd(meta), watchedTo);
}
