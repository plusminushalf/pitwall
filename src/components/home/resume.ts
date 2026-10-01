// Where each watched session was left, as a race clock ("48:52"), by session key. Read once per visit to Home (the
// history is written while watching).

import { raceClock } from "../../lib/format";
import { watchHistory } from "../../store";

export function resumeClocks(): Record<number, string> {
  const out: Record<number, string> = {};
  for (const [key, w] of Object.entries(watchHistory())) if (w.raceTime != null && w.raceTime > 0) out[Number(key)] = raceClock(w.raceTime);
  return out;
}
