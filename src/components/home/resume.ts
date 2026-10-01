// Where each watched session was left, by session key: a race clock that always shows hours ("0:17:42"), so a
// resume point can't be read as a time of day next to session times like "Sun 08:00". Read once per visit to Home
// (the history is written while watching).

import { watchHistory } from "../../store";

const pad = (n: number) => String(n).padStart(2, "0");

/** 1062000 -> "0:17:42". */
export function resumeClock(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 3600)}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

export function resumeClocks(): Record<number, string> {
  const out: Record<number, string> = {};
  for (const [key, w] of Object.entries(watchHistory())) if (w.raceTime != null && w.raceTime > 0) out[Number(key)] = resumeClock(w.raceTime);
  return out;
}
