// The past races the circuit widgets show (pastRaces.ts), as they load: kept in this browser once fetched (a past
// race doesn't change), fetched one race at a time otherwise, through the vault when signed in (so during a live
// session too) and straight to OpenF1 if not. And which circuits' results the user has asked to see: results are
// spoilers (PRODUCT.md), so the circuit page and the widgets hide them until spoilers are shown (Settings) or the
// user reveals a circuit's, for as long as the page is open.

import { create } from "zustand";
import { LiveWindowError } from "../../scripts/lib/openf1Http";
import type { CatalogRow } from "../ingest/catalog";
import { openf1Get } from "../library";
import { sessionStore, storageSupported } from "../storage";
import { fetchPastRace, PAST_RACE_FORMAT, type PastRace } from "./pastRaces";

export type PastRaceState = { race: PastRace } | { loading: true } | { error: string };

interface PastRacesState {
  races: Record<number, PastRaceState>;
  /** Circuits (slugs) whose results the user asked to see. */
  revealed: Record<string, true>;
  /** Loads the races given (the ones not already here or loading). */
  load: (rows: readonly CatalogRow[]) => void;
  reveal: (slug: string) => void;
}

const docName = (key: number) => `past-race-${key}-v${PAST_RACE_FORMAT}`;
/** Why a race didn't load, in a line: the network, OpenF1's live-session block, or OpenF1's answer. */
function message(e: unknown): string {
  if (e instanceof LiveWindowError) return "OpenF1 blocks free access during live sessions. Connect an OpenF1 account (Settings), or try again after it.";
  // fetch() itself failing: offline, or no answer it could read.
  if (e instanceof TypeError) return "Couldn't reach OpenF1. Check the connection.";
  const status = e instanceof Error ? /OpenF1 (\d{3})/.exec(e.message)?.[1] : undefined;
  if (status) return `OpenF1 didn't answer (${status}).`;
  return e instanceof Error ? e.message : String(e);
}

/** One race at a time, in the order asked, so a circuit's races don't burst OpenF1's rate limit. */
let queue: Promise<void> = Promise.resolve();

export const usePastRaces = create<PastRacesState>((set, get) => {
  const put = (key: number, state: PastRaceState) => set({ races: { ...get().races, [key]: state } });
  const loadOne = async (row: CatalogRow) => {
    const store = storageSupported() ? sessionStore() : null;
    const kept = await store?.readDoc<PastRace>(docName(row.sessionKey)).catch(() => undefined);
    if (kept?.format === PAST_RACE_FORMAT) return put(row.sessionKey, { race: kept });
    try {
      const race = await fetchPastRace(row, await openf1Get());
      put(row.sessionKey, { race });
      await store?.writeDoc(docName(row.sessionKey), race).catch(() => {});
    } catch (e) {
      put(row.sessionKey, { error: message(e) });
    }
  };
  return {
    races: {},
    revealed: {},
    load: (rows) => {
      const todo = rows.filter((r) => {
        const s = get().races[r.sessionKey];
        return !s || "error" in s;
      });
      for (const row of todo) {
        put(row.sessionKey, { loading: true });
        queue = queue.then(() => loadOne(row));
      }
    },
    reveal: (slug) => set({ revealed: { ...get().revealed, [slug]: true } }),
  };
});
