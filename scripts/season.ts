// Race and sprint sessions of a season (optionally qualifying too), with whether each can be / has been ingested.

import { fetchEndpoint, type RawSession } from "./openf1";
import type { SessionIndexEntry } from "../src/types";

export const INDEX_FILE = "public/sessions/index.json";

export type SeasonStatus = "cancelled" | "not run yet" | "ingested" | "pending";

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
    .map((session) => ({
      session,
      status: session.is_cancelled
        ? "cancelled"
        : Date.parse(session.date_end) > now
          ? "not run yet"
          : ingested.has(session.session_key)
            ? "ingested"
            : "pending",
    }));
}
