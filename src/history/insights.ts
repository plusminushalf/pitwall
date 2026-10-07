// What a circuit's history says: recent poles and podiums, lap records, who wins there. Pure, over the facts in a
// CircuitHistory (src/history/types.ts).

import type { CircuitHistory, FastestLap, HistoryLayout, HistoryRace, Timed } from "./types";

/** The layout raced now, or last. */
export const currentLayout = (h: CircuitHistory): HistoryLayout | undefined => h.layouts.find((l) => l.current) ?? h.layouts.at(-1);

const newestFirst = (h: CircuitHistory) => [...h.races].reverse();

/** The last `n` pole sitters, newest first. */
export const lastPoles = (h: CircuitHistory, n = 5): { race: HistoryRace; pole: Timed }[] =>
  newestFirst(h)
    .flatMap((race) => (race.pole ? [{ race, pole: race.pole }] : []))
    .slice(0, n);

/** The last `n` podiums, newest first. */
export const lastPodiums = (h: CircuitHistory, n = 5): HistoryRace[] =>
  newestFirst(h)
    .filter((r) => r.podium.length > 0)
    .slice(0, n);

/** The fastest of `pick` over the races on a layout; the earliest wins a tie, as the record stood first. */
function fastestOn<T extends { ms: number | null }>(h: CircuitHistory, layoutId: string | undefined, pick: (r: HistoryRace) => T | null) {
  let best: { race: HistoryRace; lap: T } | null = null;
  for (const race of h.races) {
    const lap = pick(race);
    if (race.layoutId !== layoutId || lap?.ms == null) continue;
    if (!best || lap.ms < best.lap.ms!) best = { race, lap };
  }
  return best;
}

/** The race lap record: the fastest lap of a Grand Prix on the layout (the current one by default). */
export const raceLapRecord = (h: CircuitHistory, layoutId = currentLayout(h)?.id) =>
  fastestOn<FastestLap>(h, layoutId, (r) => r.fastestLap);

/** The fastest pole lap on the layout (the current one by default). */
export const poleLapRecord = (h: CircuitHistory, layoutId = currentLayout(h)?.id) => fastestOn<Timed>(h, layoutId, (r) => r.pole);

export type Achievement = "wins" | "poles" | "podiums";

export interface Leader {
  /** A driver id, or a constructor id with `by: "constructor"`. */
  id: string;
  count: number;
  lastYear: number;
}

/** Most wins, poles or podiums at the circuit, by driver or team: most first, then the most recent, then by id. */
export function leaders(h: CircuitHistory, what: Achievement, by: "driver" | "constructor" = "driver"): Leader[] {
  const tally = new Map<string, Leader>();
  for (const race of h.races) {
    const entries = what === "poles" ? (race.pole ? [race.pole] : []) : what === "wins" ? race.podium.filter((p) => p.position === 1) : race.podium;
    for (const e of entries) {
      const id = by === "driver" ? e.driverId : e.constructorId;
      const t = tally.get(id) ?? { id, count: 0, lastYear: race.year };
      tally.set(id, { id, count: t.count + 1, lastYear: race.year });
    }
  }
  return [...tally.values()].sort((a, b) => b.count - a.count || b.lastYear - a.lastYear || a.id.localeCompare(b.id));
}

/** How often pole turned into the win, over races since `sinceYear` with both known. */
export function poleToWin(h: CircuitHistory, sinceYear = -Infinity): { races: number; wins: number } {
  let races = 0;
  let wins = 0;
  for (const r of h.races) {
    const winner = r.podium.find((p) => p.position === 1);
    if (r.year < sinceYear || !r.pole || !winner) continue;
    races++;
    if (winner.driverId === r.pole.driverId) wins++;
  }
  return { races, wins };
}
