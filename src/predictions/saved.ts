// The calls made in this browser, one per question per race (localStorage): coming back shows yours, ready to share
// again, and doesn't let you make a second. Only this browser knows; that's as far as a page with no server goes.

import type { Question } from "./model";

export interface SavedCall {
  driver: number;
  /** When it was locked, ms since the epoch: the card's time to go. */
  at: number;
}

const KEY = "called-it:calls";

/**
 * A call's key: the question and the race, "winner:11731", so a race that changes its question (Bahrain 2026 went from
 * Turn 1 to the win mid-weekend) doesn't show the old answer as the new one. Calls saved before keys had a question
 * (bare race ids) were Turn 1 calls, and are left be.
 */
export const callKey = (question: Question, race: number) => `${question}:${race}`;

export function readCalls(): Record<string, SavedCall> {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return v && typeof v === "object" ? (v as Record<string, SavedCall>) : {};
  } catch {
    return {};
  }
}

/** Saves a call under its key (callKey) and returns them all. The page only offers this while there's none that counts. */
export function saveCall(key: string, call: SavedCall): Record<string, SavedCall> {
  const next = { ...readCalls(), [key]: call };
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Private mode: the call holds for this visit.
  }
  return next;
}
