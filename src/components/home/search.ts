// The jump field's search: "monza 24 q", "spa 2023 race", "japan sprint quali", "r15". Every word has to match the
// session: a year ("2024" or "24"), a round ("r15"), a session ("q", "quali", "race", "sprint", "sq"), or the start
// of a word in its Grand Prix, circuit or country. Newest first.

import type { CatalogRow } from "../../ingest/catalog";

const SESSION_WORDS: Record<string, readonly string[]> = {
  q: ["Qualifying"],
  quali: ["Qualifying"],
  qualy: ["Qualifying"],
  qualifying: ["Qualifying"],
  r: ["Race"],
  race: ["Race"],
  s: ["Sprint"],
  sprint: ["Sprint"],
  sq: ["Sprint Qualifying", "Sprint Shootout"],
  shootout: ["Sprint Qualifying", "Sprint Shootout"],
};

/** Words that say nothing about which session ("Grand Prix", "GP"). */
const FILLER = new Set(["gp", "grand", "prix"]);

const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const words = (s: string) => fold(s).split(/[^a-z0-9]+/).filter(Boolean);

/** The query's words, with "sprint quali(fying)" / "sprint shootout" read as one ("sq"). */
export function queryWords(query: string): string[] {
  const out: string[] = [];
  const ws = words(query);
  for (let i = 0; i < ws.length; i++) {
    const w = ws[i];
    if (w === "sprint" && ["q", "quali", "qualy", "qualifying", "shootout"].includes(ws[i + 1])) {
      out.push("sq");
      i++;
    } else if (!FILLER.has(w)) out.push(w);
  }
  return out;
}

function matches(row: CatalogRow, word: string, place: string[]): boolean {
  if (/^\d{4}$/.test(word)) return row.year === Number(word);
  if (/^\d{2}$/.test(word)) return row.year === 2000 + Number(word);
  if (/^r\d{1,2}$/.test(word)) return row.round === Number(word.slice(1));
  const session = SESSION_WORDS[word];
  if (session) return session.includes(row.sessionName);
  return place.some((p) => p.startsWith(word));
}

/**
 * Sessions matching `query`, newest first, at most `limit`. Cancelled sessions and ones more than a week away are
 * left out (there's nothing to open).
 */
export function searchSessions(query: string, rows: Iterable<CatalogRow>, now: number, limit = 25): CatalogRow[] {
  const q = queryWords(query);
  if (!q.length) return [];
  const horizon = now + 7 * 86_400_000;
  const found: CatalogRow[] = [];
  for (const row of rows) {
    if (row.cancelled || Date.parse(row.dateStart) > horizon) continue;
    const place = [...words(row.meetingName), ...words(row.circuit), ...words(row.country)];
    if (q.every((w) => matches(row, w, place))) found.push(row);
  }
  return found.sort((a, b) => b.dateStart.localeCompare(a.dateStart)).slice(0, limit);
}
