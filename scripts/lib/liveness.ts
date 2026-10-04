// Is a session still running? OpenF1's calendar only has the scheduled end: a delayed start or a red flag runs a
// session past it with nothing in the calendar to say so. This asks OpenF1 for signs of life (race control
// messages, laps) and says when the session really ends, for the app's calendar (src/library.ts) and live mode
// (src/live/openf1.ts, the relay and the browser alike).

import { endingFlag } from "./normalize";

/** Red flags and delayed starts can stretch a session; past this it's taken as over whatever the data says. */
export const MAX_OVERRUN_MS = 3 * 60 * 60_000;
/** No new data for this long (and no red flag): the session is over. */
export const QUIET_MS = 15 * 60_000;
/** The field crosses the line within this of the chequered flag. */
export const AFTER_FLAG_MS = 5 * 60_000;
/** Ask from this long before the scheduled end, so the answer is in when it passes. */
export const PROBE_BEFORE_END_MS = 5 * 60_000;
/** How far back to look for laps when asking. */
export const RECENT_MS = 20 * 60_000;

export interface Evidence {
  /** The newest message or lap seen (ms epoch), or null for none. */
  lastDataAt: number | null;
  /** The chequered flag that ends the session (qualifying's last segment's), or null. */
  chequeredAt: number | null;
  /** Suspended under a red flag (the latest flag message is RED). */
  redFlag: boolean;
}

export interface RaceControlLike {
  date: string;
  flag: string | null;
}

const parse = (d: string) => Date.parse(d);

/** What the race control messages and the recent laps' start times say. */
export function evidenceOf(raceControl: readonly RaceControlLike[], lapStarts: readonly string[], sessionType: string): Evidence {
  const dates = [...raceControl.map((m) => parse(m.date)), ...lapStarts.map(parse)].filter((t) => !Number.isNaN(t));
  const flags = raceControl.filter((m) => m.flag === "RED" || m.flag === "GREEN" || m.flag === "CHEQUERED").sort((a, b) => parse(a.date) - parse(b.date));
  const chequered = endingFlag(raceControl, { session_type: sessionType });
  return {
    lastDataAt: dates.length ? Math.max(...dates) : null,
    chequeredAt: chequered ? parse(chequered.date) : null,
    redFlag: flags.at(-1)?.flag === "RED",
  };
}

/**
 * When the session ends by the evidence: the scheduled end, or later while OpenF1 still shows it running. After the
 * chequered flag (with nothing newer than the field finishing) it's the flag plus a few minutes; under a red flag, or
 * with recent data, it's open-ended (QUIET_MS past the latest data); never past the cap.
 */
export function endBy(scheduledEnd: number, e: Evidence, now: number): number {
  const cap = scheduledEnd + MAX_OVERRUN_MS;
  const bounded = (t: number) => Math.max(scheduledEnd, Math.min(t, cap));
  if (e.chequeredAt != null) {
    const flagEnd = e.chequeredAt + AFTER_FLAG_MS;
    if (e.lastDataAt == null || e.lastDataAt <= flagEnd) return bounded(flagEnd);
  }
  if (e.redFlag) return bounded(now + QUIET_MS);
  if (e.lastDataAt != null) return bounded(e.lastDataAt + QUIET_MS);
  return scheduledEnd;
}

/** Whether it's worth asking: from shortly before the scheduled end until the cap. */
export const shouldProbe = (scheduledEnd: number, now: number) => now >= scheduledEnd - PROBE_BEFORE_END_MS && now <= scheduledEnd + MAX_OVERRUN_MS;

export type LivenessFetcher = <T>(endpoint: string, params: Record<string, string | number>) => Promise<T[]>;

/** Two requests: every race control message, and the laps started in the last RECENT_MS. */
export async function fetchEvidence(sessionKey: number, sessionType: string, now: number, fetch: LivenessFetcher): Promise<Evidence> {
  const since = new Date(now - RECENT_MS).toISOString();
  const [raceControl, laps] = await Promise.all([
    fetch<RaceControlLike>("race_control", { session_key: sessionKey }),
    fetch<{ date_start: string | null }>("laps", { session_key: sessionKey, "date_start>": since }),
  ]);
  return evidenceOf(
    raceControl,
    laps.flatMap((l) => (l.date_start ? [l.date_start] : [])),
    sessionType,
  );
}
