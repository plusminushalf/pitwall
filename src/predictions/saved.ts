// The calls made in this browser, one per race (localStorage): coming back shows yours, ready to share again, and
// doesn't let you make a second. Only this browser knows; that's as far as a page with no server goes.

export interface SavedCall {
  driver: number;
  /** When it was locked, ms since the epoch: the card's time to go. */
  at: number;
}

const KEY = "called-it:calls";

export function readCalls(): Record<number, SavedCall> {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return v && typeof v === "object" ? (v as Record<number, SavedCall>) : {};
  } catch {
    return {};
  }
}

/** Saves the race's call and returns them all. The page only offers this while the race has none that counts. */
export function saveCall(race: number, call: SavedCall): Record<number, SavedCall> {
  const next = { ...readCalls(), [race]: call };
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Private mode: the call holds for this visit.
  }
  return next;
}
