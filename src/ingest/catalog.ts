// The race calendar: every season since 2023 from OpenF1 (/v1/sessions + /v1/meetings, two requests per
// season), with the CLI's selection rules (scripts/lib/season.ts). Cached in the session store.

import { fetchEndpoint } from "../../scripts/lib/openf1Http";
import type { RawMeeting, RawSession } from "../../scripts/lib/openf1Types";
import { championshipRounds, isIngestible, liveWindowAt, type LiveWindow } from "../../scripts/lib/season";

export interface CatalogRow {
  sessionKey: number;
  sessionName: string; // "Race" | "Sprint" | "Qualifying" | ...
  sessionType: string; // OpenF1 session_type: "Race" | "Qualifying"
  meetingKey: number;
  meetingName: string; // "Australian Grand Prix"
  /** Championship round (meetings with a race that went ahead, in date order), null if cancelled. */
  round: number | null;
  year: number;
  dateStart: string;
  dateEnd: string;
  circuit: string;
  country: string;
  cancelled: boolean;
}

export interface Catalog {
  year: number;
  fetchedAt: number;
  /** Races, sprints and qualifying sessions, by start date. */
  rows: CatalogRow[];
  /** Every session of the season (practice too), for the free tier's live windows. */
  sessions: RawSession[];
}

/** How long a cached season is used before it's fetched again: the current one changes (reschedules, cancellations). */
export const CATALOG_TTL_MS = { current: 60 * 60_000, past: 7 * 24 * 60 * 60_000 };

export const catalogFresh = (c: Catalog, now = Date.now()) =>
  now - c.fetchedAt < (c.year >= new Date(now).getUTCFullYear() ? CATALOG_TTL_MS.current : CATALOG_TTL_MS.past);

const slim = (s: RawSession): RawSession => ({
  session_key: s.session_key,
  meeting_key: s.meeting_key,
  session_name: s.session_name,
  session_type: s.session_type,
  date_start: s.date_start,
  date_end: s.date_end,
  year: s.year,
  circuit_short_name: s.circuit_short_name,
  country_name: s.country_name,
  location: s.location,
  gmt_offset: s.gmt_offset,
  is_cancelled: s.is_cancelled ?? false,
});

export function buildCatalog(year: number, sessions: RawSession[], meetings: RawMeeting[], fetchedAt = Date.now()): Catalog {
  const names = new Map(meetings.map((m) => [m.meeting_key, m.meeting_name]));
  const rounds = championshipRounds(sessions);
  const sorted = [...sessions].sort((a, b) => a.date_start.localeCompare(b.date_start));
  const rows = sorted.filter(isIngestible).map(
    (s): CatalogRow => ({
      sessionKey: s.session_key,
      sessionName: s.session_name,
      sessionType: s.session_type,
      meetingKey: s.meeting_key,
      meetingName: names.get(s.meeting_key) ?? `${s.country_name} ${s.year}`,
      round: s.is_cancelled ? null : (rounds.get(s.meeting_key) ?? null),
      year: s.year ?? year,
      dateStart: s.date_start,
      dateEnd: s.date_end,
      circuit: s.circuit_short_name,
      country: s.country_name,
      cancelled: s.is_cancelled ?? false,
    }),
  );
  return { year, fetchedAt, rows, sessions: sorted.map(slim) };
}

/** A season from OpenF1 (two requests, one after the other: the client spaces them out). */
export async function fetchCatalog(year: number): Promise<Catalog> {
  const sessions = await fetchEndpoint<RawSession>("sessions", { year });
  const meetings = await fetchEndpoint<RawMeeting>("meetings", { year });
  return buildCatalog(year, sessions, meetings);
}

/** One session looked up by key (for a shared link to a session whose season isn't loaded). */
export async function fetchSessionInfo(key: number): Promise<RawSession | null> {
  const [s] = await fetchEndpoint<RawSession>("sessions", { session_key: key });
  return s ?? null;
}

/** The free tier's live window at `now`, from whichever seasons are loaded. */
export function liveWindowNow(catalogs: Iterable<Catalog>, now = Date.now()): LiveWindow | null {
  let hit: LiveWindow | null = null;
  for (const c of catalogs) {
    const w = liveWindowAt(c.sessions, now);
    if (w && (!hit || w.to > hit.to)) hit = w;
  }
  return hit;
}

/** "Singapore Grand Prix · Practice 1" for a live window. */
export function windowLabel(w: LiveWindow, catalogs: Iterable<Catalog>): string {
  for (const c of catalogs) {
    const row = c.rows.find((r) => r.meetingKey === w.session.meeting_key);
    if (row) return `${row.meetingName} · ${w.session.session_name}`;
  }
  return `${w.session.country_name} · ${w.session.session_name}`;
}
