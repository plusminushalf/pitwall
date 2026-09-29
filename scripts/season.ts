// Race and sprint sessions of a season (optionally qualifying too), with whether each can be / has been ingested.
// The selection rules live in lib/season.ts, shared with the in-browser catalogue.

import { fetchEndpoint, type RawSession } from "./openf1";
import { seasonStatus, type SeasonStatus } from "./lib/season";
import type { SessionIndexEntry } from "../src/types";

export const INDEX_FILE = "data/sessions/index.json";

export type { SeasonStatus };

export interface SeasonSession {
  session: RawSession;
  status: SeasonStatus;
}

export async function ingestedKeys(): Promise<Set<number>> {
  const file = Bun.file(INDEX_FILE);
  const index: SessionIndexEntry[] = (await file.exists()) ? await file.json() : [];
  return new Set(index.map((e) => e.sessionKey));
}

/**
 * All Race/Sprint sessions (OpenF1 session_type "Race") of `year`, plus with `quali` its qualifying,
 * sprint qualifying and sprint shootout sessions (session_type "Qualifying"), sorted by start date.
 */
export async function seasonSessions(year: number, opts: { quali?: boolean } = {}): Promise<SeasonSession[]> {
  const sessions = await fetchEndpoint<RawSession>("sessions", { year, session_type: "Race" });
  if (opts.quali) sessions.push(...(await fetchEndpoint<RawSession>("sessions", { year, session_type: "Qualifying" })));
  const ingested = await ingestedKeys();
  const now = Date.now();
  return sessions
    .sort((a, b) => a.date_start.localeCompare(b.date_start))
    .map((session) => ({ session, status: seasonStatus(session, now, ingested) }));
}
