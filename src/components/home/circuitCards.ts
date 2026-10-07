// Home's circuits: the season's circuits in calendar order, each with its weekend this season, then the circuits only
// earlier seasons raced at, latest first. A circuit is OpenF1's circuit name (../../circuit.ts), so the 2026 Bahrain
// Grand Prix, held at Sepang, is Kuala Lumpur's weekend.

import { circuitSlug } from "../../circuit";
import type { CatalogRow } from "../../ingest/catalog";

export interface CircuitCard {
  slug: string;
  /** OpenF1's name: "Singapore", "Kuala Lumpur". */
  name: string;
  circuitKey: number | null;
  country: string;
  /** The Grand Prix of its latest weekend (this season's, for the season's circuits). */
  meetingName: string;
  /** Its latest weekend's season, round and span. */
  year: number;
  round: number | null;
  dateStart: string;
  dateEnd: string;
  /** Every session of that weekend was cancelled. */
  cancelled: boolean;
}

export interface CircuitCards {
  /** The season's circuits, in calendar order. */
  season: CircuitCard[];
  /** Circuits raced at in earlier seasons but not this one: the latest raced first. */
  earlier: CircuitCard[];
}

/** One card per circuit, from its latest weekend among `rows`. */
function byCircuit(rows: readonly CatalogRow[]): Map<string, CircuitCard> {
  const cards = new Map<string, CircuitCard>();
  const sorted = [...rows].sort((a, b) => a.dateStart.localeCompare(b.dateStart));
  for (const r of sorted) {
    if (!r.circuit) continue;
    const slug = circuitSlug(r.circuit);
    const card = cards.get(slug);
    if (card && card.year === r.year && card.round === r.round && card.meetingName === r.meetingName) {
      card.dateEnd = r.dateEnd > card.dateEnd ? r.dateEnd : card.dateEnd;
      card.cancelled &&= r.cancelled;
      card.circuitKey ??= r.circuitKey;
      continue;
    }
    cards.set(slug, {
      slug,
      name: r.circuit,
      circuitKey: r.circuitKey ?? card?.circuitKey ?? null,
      country: r.country,
      meetingName: r.meetingName,
      year: r.year,
      round: r.round,
      dateStart: r.dateStart,
      dateEnd: r.dateEnd,
      cancelled: r.cancelled,
    });
  }
  return cards;
}

/** `year`'s circuits from its calendar, and the ones only the other seasons given went to. */
export function circuitCards(year: number, seasons: readonly { year: number; rows: readonly CatalogRow[] }[]): CircuitCards {
  const thisSeason = seasons.find((s) => s.year === year);
  const season = [...byCircuit(thisSeason?.rows ?? []).values()].sort((a, b) => a.dateStart.localeCompare(b.dateStart));
  const raced = new Set(season.map((c) => c.slug));
  const earlier = [...byCircuit(seasons.filter((s) => s.year < year).flatMap((s) => s.rows)).values()]
    .filter((c) => !raced.has(c.slug))
    .sort((a, b) => b.dateStart.localeCompare(a.dateStart));
  return { season, earlier };
}
