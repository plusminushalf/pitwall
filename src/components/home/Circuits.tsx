// Home's circuits: a board of the season's circuits, the next weekend (raised) first, then the ones raced, newest
// first, then the ones later in the season in calendar order, and the circuits earlier seasons raced at. A cell opens
// the circuit's page (../circuit/CircuitPage.tsx): every session there over the years, and its history. Each says its
// round, flag, weekend, how many of its sessions are in this browser, and (from F1DB's index, when the deploy built
// it) how long Grands Prix have been held there. No results: spoilers.

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { fetchCircuitHistoryIndex, F1DB_CIRCUIT } from "../../history/circuits";
import type { CircuitHistoryIndex } from "../../history/types";
import { circuitSlug } from "../../circuit";
import { isLive, nextWeekend } from "../../ingest/catalog";
import { useLibrary, YEARS } from "../../library";
import { Flag } from "../Flag";
import { useReplay } from "../../store";
import { circuitCards, type CircuitCard } from "./circuitCards";
import { dateRange, FOCUS, LABEL, SECONDARY, shortGp, useNow } from "./common";

const BADGE = "shrink-0 rounded px-1.5 py-px text-[11px] font-semibold uppercase leading-4 tracking-wider";

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
 * A circuit's cell on the board: the round as its figure (the year, for an earlier season's), the flag and name, the
 * Grand Prix and dates, and what's known about it. The season's progress is in the tone: raced weekends are bright
 * (they can be watched), the next one is raised, the ones to come step back.
 */
function Cell({ card, phase, stored, history, earlier }: { card: CircuitCard; phase: Phase; stored: number; history: string | null; earlier: boolean }) {
  const openCircuit = useReplay((s) => s.openCircuit);
  const now = phase === "next" || phase === "live";
  const quiet = phase === "later" || phase === "cancelled";
  const facts = [history, stored > 0 ? `${stored} stored` : null].filter(Boolean).join(" · ");
  return (
    <li className="border-b border-r border-zinc-800">
      <button
        onClick={(e) => {
          e.currentTarget.blur();
          openCircuit(card.slug);
        }}
        className={`flex h-full w-full items-start gap-3 px-3 py-3 text-left transition-colors focus-visible:-outline-offset-2 sm:gap-4 sm:px-4 ${FOCUS} ${now ? "bg-zinc-900" : "hover:bg-zinc-900"}`}
        title={`${card.name}: every session there over the years, and its history`}
      >
        <span
          className={`w-7 shrink-0 font-black tabular-nums leading-6 tracking-tight sm:w-9 ${earlier ? "text-sm" : "text-lg sm:text-xl"} ${now ? "text-zinc-50" : quiet ? "text-zinc-400" : "text-zinc-300"}`}
          aria-label={earlier ? `${card.year}` : card.round != null ? `Round ${card.round}` : undefined}
        >
          {earlier ? card.year : (card.round ?? "–")}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex h-6 items-center gap-2">
            <Flag country={card.country} className={`h-3.5 ${quiet ? "opacity-45 grayscale-[60%]" : ""}`} />
            <span
              className={`min-w-0 truncate text-[15px] font-semibold ${quiet ? "text-zinc-400" : "text-zinc-50"} ${phase === "cancelled" ? "line-through decoration-zinc-500" : ""}`}
            >
              {card.name}
            </span>
            <span className="flex-1" />
            {phase === "live" && <span className={`${BADGE} bg-red-600 text-white`}>Live</span>}
            {phase === "next" && <span className={`${BADGE} bg-zinc-700 text-zinc-50`}>Next</span>}
          </span>
          <span className={`block truncate text-xs tabular-nums ${quiet ? "text-zinc-400" : "text-zinc-300"}`}>
            {shortGp(card.meetingName)}
            <span className="text-zinc-500"> · </span>
            {phase === "cancelled" ? "Cancelled" : dateRange(card.dateStart, card.dateEnd)}
          </span>
          {facts && <span className="mt-1.5 hidden truncate text-xs tabular-nums text-zinc-400 sm:block">{facts}</span>}
        </span>
      </button>
    </li>
  );
}

/** The board: cells framed and divided by hairlines, as the replay screen's widgets are. */
const BOARD = "grid grid-cols-1 border-l border-t border-zinc-800 min-[420px]:grid-cols-2 lg:grid-cols-3";

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
    // What the visitor came for first: the weekend coming up (or under way), then what can be watched, newest first,
    // then what's still to come. Each cell keeps its round, so the calendar still reads.
    const phased = season.map((c) => ({ c, phase: phaseOf(c) }));
    const of = (...phases: Phase[]) => phased.filter((p) => phases.includes(p.phase));
    const first = [...of("live", "next"), ...of("raced").reverse(), ...of("cancelled")];
    const later = of("later");
    const cell = ({ c, phase }: { c: CircuitCard; phase: Phase }) => (
      <Cell key={c.slug} card={c} phase={phase} stored={stored.get(c.slug) ?? 0} history={historyOf(c)} earlier={false} />
    );
    body = (
      <>
        {first.length > 0 && (
          <ul aria-label={`${year} circuits, the next and the raced`} className={BOARD}>
            {first.map(cell)}
          </ul>
        )}
        {later.length > 0 && (
          <>
            <h3 className={`${LABEL} mb-2 ${first.length > 0 ? "mt-8" : ""}`}>Later this season</h3>
            <ul aria-label={`${year} circuits still to come`} className={BOARD}>
              {later.map(cell)}
            </ul>
          </>
        )}
        {earlier.length > 0 && (
          <>
            <h3 className={`${LABEL} mb-2 mt-8`}>Earlier seasons</h3>
            <ul aria-label="Circuits of earlier seasons" className={BOARD}>
              {earlier.map((c) => (
                <Cell key={c.slug} card={c} phase="raced" stored={stored.get(c.slug) ?? 0} history={historyOf(c)} earlier />
              ))}
            </ul>
          </>
        )}
      </>
    );
  }

  return (
    <section aria-label="Circuits" className="mt-12">
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2">{heading}</div>
      {body}
    </section>
  );
}
