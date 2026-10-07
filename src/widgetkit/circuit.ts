// The circuit widgets' data: earlier races at the circuit (src/history/pastRaces.ts). On a replay, the circuit is the
// session's and the races are the ones before it (watching 2024 never shows 2025); on a circuit's page, which has no
// session, the page says which circuit (CircuitContext) and every past race there counts. Results are spoilers:
// `hidden` until spoilers are shown (Settings) or the user reveals the circuit's (src/history/pastRacesStore.ts).

import { createContext, useContext, useEffect, useMemo } from "react";
import { circuitSlug, rowsAt } from "../circuit";
import type { PastRace } from "../history/pastRaces";
import { usePastRaces } from "../history/pastRacesStore";
import { useLibrary, YEARS } from "../library";
import { useReplay } from "../store";

/** A circuit's page: which circuit its widgets are about. */
export interface CircuitScope {
  slug: string;
}

export const CircuitContext = createContext<CircuitScope | null>(null);

/** One earlier race at the circuit, as it loads. */
export interface CircuitRaceEntry {
  sessionKey: number;
  year: number;
  meetingName: string;
  race: PastRace | null;
  loading: boolean;
  /** Why it didn't load (then Try again: retry()). */
  error: string | null;
}

export interface CircuitRaces {
  /** OpenF1's name for the circuit ("Singapore"); null while the calendar loads. */
  circuit: string | null;
  /** Every season's calendar is here (or failed): `total` is final. */
  ready: boolean;
  /** A season's calendar didn't load (and none was kept): the races there may be missing. */
  calendarError: string | null;
  slug: string | null;
  /** Loaded, newest first. */
  races: readonly PastRace[];
  /** Every earlier race there, newest first, loaded or not: what the widgets lay out before the data is in. */
  entries: readonly CircuitRaceEntry[];
  /** Loads again the races that didn't load. */
  retry: () => void;
  /** Earlier races there that OpenF1 has (loaded or not). */
  total: number;
  /** Still loading. */
  pending: number;
  /** Why some didn't load (one line each, deduplicated). */
  errors: readonly string[];
  /** Results are hidden (spoilers) until reveal(). */
  hidden: boolean;
  reveal: () => void;
}

/** Races (`sessionName` "Race" or "Sprint") at the circuit before the session on screen, or all past ones on a circuit's page. */
export function useCircuitRaces(sessionName: "Race" | "Sprint" = "Race"): CircuitRaces {
  const scope = useContext(CircuitContext);
  const sessionCircuit = useReplay((s) => s.session?.meta.circuit ?? null);
  const sessionStart = useReplay((s) => s.session?.meta.t0 ?? null);
  const replayKey = useReplay((s) => s.session?.meta.sessionKey ?? null);
  // (A session left loaded behind a circuit's page isn't the page's.)
  const sessionKey = scope ? null : replayKey;
  const slug = scope?.slug ?? (sessionCircuit ? circuitSlug(sessionCircuit) : null);
  const before = scope ? null : sessionStart;
  const years = useLibrary((s) => s.years);
  const spoilers = useReplay((s) => s.spoilerPref === "show");
  const revealed = usePastRaces((s) => (slug ? s.revealed[slug] === true : false));
  const states = usePastRaces((s) => s.races);

  // Every season's calendar (cached after the first visit): the circuit's races are spread over them.
  useEffect(() => {
    for (const y of YEARS) void useLibrary.getState().loadYear(y);
  }, []);

  const atCircuit = useMemo(() => (slug ? rowsAt(slug, YEARS.map((y) => years[y]?.catalog)) : []), [slug, years]);
  const ready = YEARS.every((y) => years[y]?.catalog || years[y]?.error);
  const calendarError = YEARS.map((y) => (years[y]?.catalog ? null : (years[y]?.error ?? null))).find((e) => e != null) ?? null;
  const rows = useMemo(() => {
    const now = Date.now();
    return atCircuit
      .filter((r) => r.sessionName === sessionName && !r.cancelled && Date.parse(r.dateEnd) < now && r.sessionKey !== sessionKey)
      .filter((r) => before == null || Date.parse(r.dateStart) < Date.parse(before))
      .reverse();
  }, [atCircuit, sessionName, sessionKey, before]);
  const keys = rows.map((r) => r.sessionKey).join(",");

  useEffect(() => {
    if (rows.length) usePastRaces.getState().load(rows);
    // Keyed by which races, not the array.
  }, [keys]);

  return useMemo(() => {
    const races: PastRace[] = [];
    const errors = new Set<string>();
    let pending = 0;
    const entries = rows.map((r): CircuitRaceEntry => {
      const s = states[r.sessionKey];
      const race = s && "race" in s ? s.race : null;
      const error = s && "error" in s ? s.error : null;
      if (race) races.push(race);
      else if (error) errors.add(error);
      else pending++;
      return { sessionKey: r.sessionKey, year: r.year, meetingName: r.meetingName, race, loading: !race && !error, error };
    });
    return {
      circuit: atCircuit.at(-1)?.circuit ?? (scope ? null : sessionCircuit),
      ready,
      calendarError,
      slug,
      races,
      entries,
      retry: () => {
        for (const y of YEARS) if (!years[y]?.catalog) void useLibrary.getState().loadYear(y, { force: true });
        usePastRaces.getState().load(rows);
      },
      total: rows.length,
      pending,
      errors: [...errors],
      hidden: !spoilers && !revealed,
      reveal: () => {
        if (slug) usePastRaces.getState().reveal(slug);
      },
    };
  }, [rows, atCircuit, ready, calendarError, years, scope, states, slug, sessionCircuit, spoilers, revealed]);
}
