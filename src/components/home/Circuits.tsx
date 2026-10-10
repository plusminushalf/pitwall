// Home's circuits: the season's calendar as timing sheets, a row per circuit: the next weekend (or the one under way)
// raised at the top, then the ones raced, newest first, then the ones later in the season in calendar order, quieter,
// then the circuits earlier seasons raced at. A row opens the circuit's page (../circuit/CircuitPage.tsx): every
// session there over the years, and its history. Each says its round, flag and name, the Grand Prix and its dates,
// (from F1DB's index, when the deploy built it) how many Grands Prix it has held since when, and how many of its
// sessions are in this browser. No results: spoilers.

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { fetchCircuitHistoryIndex, F1DB_CIRCUIT } from "../../history/circuits";
import type { CircuitHistoryIndex } from "../../history/types";
import { circuitSlug } from "../../circuit";
import { isLive, nextWeekend } from "../../ingest/catalog";
import { useLibrary, YEARS } from "../../library";
import { Flag } from "../Flag";
import { useReplay } from "../../store";
import { circuitCards, type CircuitCard } from "./circuitCards";
import { dateRange, SECONDARY, shortGp, useNow } from "./common";
import { AT_40, AT_52, AT_66, Sheet, SheetRow, SheetTitle, Spoken } from "./sheet";

const BADGE = "shrink-0 rounded px-1.5 py-px text-[11px] font-semibold uppercase leading-4 tracking-wider";

/**
 * Round · Circuit · Grand Prix · Dates · History · Stored. Narrowest, the Grand Prix goes under the circuit's name and
 * only the dates stay beside it; History, then Stored, join as the sheet widens.
 */
const GRID =
  "grid grid-cols-[2rem_minmax(0,1fr)_auto] gap-x-3 @[40rem]:grid-cols-[2.5rem_minmax(0,1fr)_minmax(0,1fr)_8.5rem] @[52rem]:grid-cols-[2.5rem_minmax(0,1fr)_minmax(0,1fr)_8.5rem_9rem] @[66rem]:grid-cols-[2.5rem_minmax(0,1fr)_minmax(0,1fr)_8.5rem_9rem_4rem]";

/** F1DB's circuits by id; null until (or unless) its index loads. */
function useHistoryIndex(): Map<string, CircuitHistoryIndex["circuits"][number]> | null {
  const [index, setIndex] = useState<CircuitHistoryIndex | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    fetchCircuitHistoryIndex(abort.signal)
      .then(setIndex)
      .catch(() => {});
    return () => abort.abort();
  }, []);
  return useMemo(() => (index ? new Map(index.circuits.map((c) => [c.id, c])) : null), [index]);
}

/** Where a weekend is in the season: raced (replayable), the next one (or live now), still to come, or cancelled. */
type Phase = "raced" | "next" | "live" | "later" | "cancelled";

/**
 * A circuit's row. The season's progress is in the tone: raced weekends are bright (they can be watched), the next
 * one is raised and marked, the ones to come step back, a cancelled one is struck through.
 */
function Row({ card, phase, stored, history, earlier }: { card: CircuitCard; phase: Phase; stored: number; history: string | null; earlier: boolean }) {
  const openCircuit = useReplay((s) => s.openCircuit);
  const now = phase === "next" || phase === "live";
  const quiet = phase === "later" || phase === "cancelled";
  const gp = shortGp(card.meetingName);
  return (
    <SheetRow grid={GRID} onOpen={() => openCircuit(card.slug)} title={`${card.name}: every session there over the years, and its history`} raised={now}>
      <span className={`tabular-nums ${now ? "font-bold text-zinc-50" : "text-zinc-400"}`}>
        {earlier ? card.year : card.round != null ? <Spoken text={`Round ${card.round}`}>{card.round}</Spoken> : "–"}
      </span>
      <span className="min-w-0">
        <span className="flex items-center gap-2">
          <Flag country={card.country} className={`h-3 shrink-0 ${quiet ? "opacity-45 grayscale-[60%]" : ""}`} />
          <span
            className={`min-w-0 truncate font-semibold ${phase === "cancelled" ? "text-zinc-400 line-through decoration-zinc-500" : quiet ? "text-zinc-300" : "text-zinc-50"}`}
          >
            {card.name}
          </span>
          {phase === "live" && <span className={`${BADGE} bg-red-600 text-white`}>Live</span>}
          {phase === "next" && <span className={`${BADGE} bg-zinc-700 text-zinc-50`}>Next</span>}
        </span>
        {/* Narrowest: the Grand Prix under the name. */}
        <span className={`block truncate text-xs @[40rem]:hidden ${quiet ? "text-zinc-400" : "text-zinc-300"}`}>{gp}</span>
      </span>
      <span className={`${AT_40} truncate ${quiet ? "text-zinc-400" : "text-zinc-200"}`}>{gp}</span>
      <span className={`whitespace-nowrap text-right tabular-nums @[40rem]:text-left ${quiet ? "text-zinc-400" : "text-zinc-200"}`}>
        {phase === "cancelled" ? "Cancelled" : dateRange(card.dateStart, card.dateEnd)}
      </span>
      <span className={`${AT_52} truncate text-xs tabular-nums text-zinc-400`}>{history}</span>
      <span className={`${AT_66} text-right tabular-nums text-zinc-200`}>{stored > 0 ? stored : ""}</span>
    </SheetRow>
  );
}

function Columns({ first }: { first: string }) {
  return (
    <>
      <span>{first}</span>
      <span>Circuit</span>
      <span className={AT_40}>Grand Prix</span>
      <span className="text-right @[40rem]:text-left">Dates</span>
      <span className={AT_52} title="Grands Prix held there, and since when (F1DB)">
        History
      </span>
      <span className={`${AT_66} text-right`} title="Its sessions in this browser">
        Stored
      </span>
    </>
  );
}

export function Circuits({ heading }: { heading: ReactNode }) {
  const years = useLibrary((s) => s.years);
  const entries = useLibrary((s) => s.entries);
  const loadYear = useLibrary((s) => s.loadYear);
  const now = useNow(30_000);
  const year = YEARS.at(-1)!;
  const history = useHistoryIndex();

  // Earlier seasons for the circuits this one doesn't go to (cached calendars after the first visit).
  useEffect(() => {
    for (const y of YEARS) void useLibrary.getState().loadYear(y);
  }, []);

  const seasons = useMemo(() => YEARS.flatMap((y) => (years[y]?.catalog ? [{ year: y, rows: years[y].catalog.rows }] : [])), [years]);
  const { season, earlier } = useMemo(() => circuitCards(year, seasons), [year, seasons]);
  const rows = years[year]?.catalog?.rows;
  const weekend = useMemo(() => (rows ? nextWeekend(rows, now) : null), [rows, now]);
  const stored = useMemo(() => {
    const count = new Map<string, number>();
    for (const e of Object.values(entries)) if (e.circuit) count.set(circuitSlug(e.circuit), (count.get(circuitSlug(e.circuit)) ?? 0) + 1);
    return count;
  }, [entries]);
  const phaseOf = (c: CircuitCard): Phase => {
    if (c.cancelled) return "cancelled";
    const w = weekend?.[0];
    if (w && c.year === w.year && circuitSlug(w.circuit) === c.slug && c.meetingName === w.meetingName)
      return weekend!.some((r) => isLive(r, now)) ? "live" : "next";
    return Date.parse(c.dateEnd) < now ? "raced" : "later";
  };
  const historyOf = (c: CircuitCard) => {
    const h = c.circuitKey != null ? history?.get(F1DB_CIRCUIT[c.circuitKey] ?? "") : null;
    return h ? `${h.racesHeld} ${h.racesHeld === 1 ? "GP" : "GPs"} since ${h.firstYear}` : null;
  };
  const state = years[year];

  let body;
  if (!season.length) {
    body = state?.error ? (
      <div className="border-y border-zinc-800 px-3 py-4 text-sm">
        <p className="text-red-400">{state.error}</p>
        <button onClick={() => void loadYear(year, { force: true })} className={`${SECONDARY} mt-3`}>
          Try again
        </button>
      </div>
    ) : (
      <p className="border-y border-zinc-800 px-3 py-4 text-sm text-zinc-400">
        {state?.catalog ? `No circuits listed for ${year} yet.` : `Loading the ${year} season from OpenF1…`}
      </p>
    );
  } else {
    const row = (c: CircuitCard, phase: Phase, old = false) => (
      <Row key={c.slug} card={c} phase={phase} stored={stored.get(c.slug) ?? 0} history={historyOf(c)} earlier={old} />
    );
    // What the visitor came for first: the weekend coming up (or under way), then what can be watched, newest first,
    // then what's still to come in calendar order. Each row keeps its round, so the calendar still reads.
    const phased = season.map((c) => ({ c, phase: phaseOf(c) }));
    const of = (...phases: Phase[]) => phased.filter((p) => phases.includes(p.phase));
    const first = [...of("live", "next"), ...of("raced").reverse(), ...of("cancelled")];
    const later = of("later");
    body = (
      <>
        {first.length > 0 && (
          <Sheet label={`${year} circuits, the next and the raced`} grid={GRID} columns={<Columns first="Rd" />}>
            {first.map(({ c, phase }) => row(c, phase))}
          </Sheet>
        )}
        {later.length > 0 && (
          <>
            {first.length > 0 && <SheetTitle>Later this season</SheetTitle>}
            <Sheet label={`${year} circuits still to come`} grid={GRID} columns={<Columns first="Rd" />}>
              {later.map(({ c, phase }) => row(c, phase))}
            </Sheet>
          </>
        )}
        {earlier.length > 0 && (
          <>
            <SheetTitle>Earlier seasons</SheetTitle>
            <Sheet label="Circuits of earlier seasons" grid={GRID} columns={<Columns first="Year" />}>
              {earlier.map((c) => row(c, "raced", true))}
            </Sheet>
          </>
        )}
      </>
    );
  }

  return (
    <section data-shot="" aria-label="Circuits" className="mt-12">
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2">{heading}</div>
      {body}
    </section>
  );
}
