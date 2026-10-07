// Home's circuits: a card for each circuit of the season, in calendar order with the next weekend marked, then the
// circuits earlier seasons raced at. A card opens the circuit's page (../circuit/CircuitPage.tsx): every session
// there over the years, and its history. Each says its weekend this season, how many of its sessions are in this
// browser, and (from F1DB's index, when the deploy built it) how long Grands Prix have been held there.

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { fetchCircuitHistoryIndex, F1DB_CIRCUIT } from "../../history/circuits";
import type { CircuitHistoryIndex } from "../../history/types";
import { circuitSlug } from "../../circuit";
import { isLive, nextWeekend } from "../../ingest/catalog";
import { useLibrary, YEARS } from "../../library";
import { useReplay } from "../../store";
import { circuitCards, type CircuitCard } from "./circuitCards";
import { dateRange, FOCUS, LABEL, SECONDARY, shortGp, useNow } from "./common";

const BADGE = "shrink-0 rounded px-1.5 py-px text-[11px] font-semibold uppercase tracking-wider";

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

function Card({ card, mark, stored, history, withYear }: { card: CircuitCard; mark: "next" | "live" | null; stored: number; history: string | null; withYear: boolean }) {
  const openCircuit = useReplay((s) => s.openCircuit);
  return (
    <li>
      <button
        onClick={(e) => {
          e.currentTarget.blur();
          openCircuit(card.slug);
        }}
        className={`flex h-full w-full flex-col rounded-lg border px-3 py-2.5 text-left transition-colors ${FOCUS} ${
          mark ? "border-zinc-600 bg-zinc-900" : "border-zinc-800 hover:border-zinc-600 hover:bg-zinc-900"
        }`}
        title={`${card.name}: every session there over the years, and its history`}
      >
        <span className="flex items-center gap-2 text-xs tabular-nums text-zinc-400">
          <span className={card.cancelled ? "line-through" : ""}>
            {card.round != null ? `R${card.round} · ` : ""}
            {dateRange(card.dateStart, card.dateEnd)}
            {withYear ? ` ${card.year}` : ""}
          </span>
          <span className="flex-1" />
          {mark === "live" && <span className={`${BADGE} bg-red-600 text-white`}>Live</span>}
          {mark === "next" && <span className={`${BADGE} bg-zinc-100 text-zinc-900`}>Next</span>}
          {/* (On a phone the struck-through dates say it.) */}
          {card.cancelled && <span className={`${BADGE} hidden bg-zinc-800 text-zinc-300 sm:inline`}>Cancelled</span>}
        </span>
        <span className="mt-1 truncate text-sm font-semibold text-zinc-50 sm:text-base">{card.name}</span>
        <span className="truncate text-xs text-zinc-300">
          {shortGp(card.meetingName)}
          {card.country ? ` · ${card.country}` : ""}
        </span>
        {(history || stored > 0) && (
          <span className="mt-2 hidden truncate text-xs text-zinc-400 sm:block">
            {[history, stored > 0 ? `${stored} stored` : null].filter(Boolean).join(" · ")}
          </span>
        )}
      </button>
    </li>
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
  const markOf = (c: CircuitCard): "next" | "live" | null => {
    const w = weekend?.[0];
    if (!w || c.year !== w.year || circuitSlug(w.circuit) !== c.slug || c.meetingName !== w.meetingName) return null;
    return weekend!.some((r) => isLive(r, now)) ? "live" : "next";
  };
  const historyOf = (c: CircuitCard) => {
    const h = c.circuitKey != null ? history?.get(F1DB_CIRCUIT[c.circuitKey] ?? "") : null;
    return h ? `${h.racesHeld} ${h.racesHeld === 1 ? "Grand Prix" : "Grands Prix"} since ${h.firstYear}` : null;
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
      <p className="border-y border-zinc-800 px-3 py-4 text-sm text-zinc-400">{state?.catalog ? `No circuits listed for ${year} yet.` : `Loading the ${year} season from OpenF1…`}</p>
    );
  } else {
    body = (
      <>
        <ul aria-label={`${year} circuits`} className="grid grid-cols-2 gap-2 lg:grid-cols-3 xl:grid-cols-4">
          {season.map((c) => (
            <Card key={c.slug} card={c} mark={markOf(c)} stored={stored.get(c.slug) ?? 0} history={historyOf(c)} withYear={false} />
          ))}
        </ul>
        {earlier.length > 0 && (
          <>
            <h3 className={`${LABEL} mb-2 mt-8`}>Earlier seasons</h3>
            <ul aria-label="Circuits of earlier seasons" className="grid grid-cols-2 gap-2 lg:grid-cols-3 xl:grid-cols-4">
              {earlier.map((c) => (
                <Card key={c.slug} card={c} mark={null} stored={stored.get(c.slug) ?? 0} history={historyOf(c)} withYear />
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
