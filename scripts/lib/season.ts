// Which sessions of a season can be replayed, and when OpenF1's free tier is locked. Pure (no I/O): shared
// by the CLI (scripts/season.ts: `bun run races`, `ingest:season`) and the in-browser catalogue
// (src/ingest/catalog.ts).

import type { RawSession } from "./openf1Types";

/** First season with OpenF1 data. */
export const FIRST_YEAR = 2023;

/**
 * OpenF1 session types that can be ingested: "Race" covers sprints, "Qualifying" covers sprint qualifying
 * and sprint shootouts (session_name tells them apart), "Practice" free practice (and pre-season testing, which
 * isn't: see isFreePractice).
 */
export const INGESTIBLE_TYPES: readonly string[] = ["Race", "Qualifying", "Practice"];

/** Free practice ("Practice 1".."Practice 3"); pre-season testing is session_type "Practice" too ("Day 1"..). */
export const isFreePractice = (s: { session_type: string; session_name: string }) => s.session_type === "Practice" && /^Practice \d$/.test(s.session_name);

export const isIngestible = (s: { session_type: string; session_name: string }) =>
  INGESTIBLE_TYPES.includes(s.session_type) && (s.session_type !== "Practice" || isFreePractice(s));

/**
 * Session types the live relay follows (server/openf1Source.ts): races, sprints and free practice. Qualifying isn't
 * streamed live; it can be downloaded once it's over.
 */
export const LIVE_TYPES: readonly string[] = ["Race", "Practice"];

export const isFollowedLive = (s: { session_type: string; session_name: string }) =>
  LIVE_TYPES.includes(s.session_type) && (s.session_type !== "Practice" || isFreePractice(s));

export type SeasonStatus = "cancelled" | "not run yet" | "ingested" | "pending";

/** Cancelled, not run yet (still to finish at `now`), already ingested, or ready to ingest. */
export function seasonStatus(s: RawSession, now: number, ingested: ReadonlySet<number>): SeasonStatus {
  if (s.is_cancelled) return "cancelled";
  if (Date.parse(s.date_end) > now) return "not run yet";
  return ingested.has(s.session_key) ? "ingested" : "pending";
}

/**
 * The country each circuit is in, by OpenF1 circuit_key. OpenF1's country_name is the Grand Prix's nation, not
 * the venue's: the 2026 Bahrain Grand Prix, moved to Sepang, is circuit "Kuala Lumpur" with country "Bahrain".
 */
const CIRCUIT_COUNTRY: Record<number, string> = {
  2: "United Kingdom", // Silverstone
  4: "Hungary", // Hungaroring
  6: "Italy", // Imola
  7: "Belgium", // Spa-Francorchamps
  9: "United States", // Austin
  10: "Australia", // Melbourne
  12: "Malaysia", // Sepang ("Kuala Lumpur")
  14: "Brazil", // Interlagos
  15: "Spain", // Catalunya
  19: "Austria", // Spielberg
  22: "Monaco", // Monte Carlo
  23: "Canada", // Montreal
  39: "Italy", // Monza
  46: "Japan", // Suzuka
  49: "China", // Shanghai
  55: "Netherlands", // Zandvoort
  61: "Singapore", // Marina Bay
  63: "Bahrain", // Sakhir
  65: "Mexico", // Mexico City
  70: "United Arab Emirates", // Yas Marina
  144: "Azerbaijan", // Baku
  149: "Saudi Arabia", // Jeddah
  150: "Qatar", // Lusail
  151: "United States", // Miami
  152: "United States", // Las Vegas
  153: "Spain", // Madring
};

/** Where a session is held, for "circuit · country" labels (OpenF1's country_name for circuits not listed). */
export const venueCountry = (s: Pick<RawSession, "circuit_key" | "country_name">): string =>
  (s.circuit_key != null ? CIRCUIT_COUNTRY[s.circuit_key] : undefined) ?? s.country_name;

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
