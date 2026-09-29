// Which sessions of a season can be replayed, and when OpenF1's free tier is locked. Pure (no I/O): shared
// by the CLI (scripts/season.ts: `bun run races`, `ingest:season`) and the in-browser catalogue
// (src/ingest/catalog.ts).

import type { RawSession } from "./openf1Types";

/** First season with OpenF1 data. */
export const FIRST_YEAR = 2023;

/**
 * OpenF1 session types that can be ingested: "Race" covers sprints, "Qualifying" covers sprint qualifying
 * and sprint shootouts (session_name tells them apart).
 */
export const INGESTIBLE_TYPES: readonly string[] = ["Race", "Qualifying"];

export const isIngestible = (s: { session_type: string }) => INGESTIBLE_TYPES.includes(s.session_type);

export type SeasonStatus = "cancelled" | "not run yet" | "ingested" | "pending";

/** Cancelled, not run yet (still to finish at `now`), already ingested, or ready to ingest. */
export function seasonStatus(s: RawSession, now: number, ingested: ReadonlySet<number>): SeasonStatus {
  if (s.is_cancelled) return "cancelled";
  if (Date.parse(s.date_end) > now) return "not run yet";
  return ingested.has(s.session_key) ? "ingested" : "pending";
}

/** Championship round of each meeting: meetings with a race that went ahead, in date order. */
export function championshipRounds(sessions: readonly RawSession[]): Map<number, number> {
  const firstRace = new Map<number, string>();
  for (const s of sessions) {
    if (s.session_type !== "Race" || s.is_cancelled) continue;
    const prev = firstRace.get(s.meeting_key);
    if (!prev || s.date_start < prev) firstRace.set(s.meeting_key, s.date_start);
  }
  return new Map([...firstRace].sort((a, b) => a[1].localeCompare(b[1])).map(([m], i) => [m, i + 1]));
}

/**
 * OpenF1 locks anonymous (free-tier) users out of every endpoint while a session is live: from 30 min
 * before it starts until 30 min after it ends (any session, practice included).
 */
export const LIVE_WINDOW_MARGIN_MS = 30 * 60_000;

export interface LiveWindow {
  session: RawSession;
  /** ms epoch */
  from: number;
  to: number;
}

/** The live window `now` falls in (the one ending last if windows overlap), or null. */
export function liveWindowAt(sessions: readonly RawSession[], now: number): LiveWindow | null {
  let hit: LiveWindow | null = null;
  for (const s of sessions) {
    if (s.is_cancelled) continue;
    const from = Date.parse(s.date_start) - LIVE_WINDOW_MARGIN_MS;
    const to = Date.parse(s.date_end) + LIVE_WINDOW_MARGIN_MS;
    if (now >= from && now < to && (!hit || to > hit.to)) hit = { session: s, from, to };
  }
  return hit;
}
