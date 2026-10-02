// Lap times race control deleted (track limits, yellow flags), matched to the laps they belong to. Shared by
// qualifying (quali.ts: a deleted lap can't count) and free practice (practice.ts: the timing screen drops it). Pure.

import type { Lap, Ms, RaceControlMsg } from "../../src/types";

// "CAR 30 (LAW) TIME 2:00.207 DELETED - DOUBLE YELLOW AT TURN 7 LAP 3 16:07:45"
// "CAR 18 (STR) LAP DELETED - TRACK LIMITS AT TURN 7 LAP 3 16:07:34 (PIT)"
const DELETED = /^CAR (\d+)\b.*?\b(?:TIME (\d+:\d{2}\.\d{3}) DELETED|LAP DELETED) - (.+?) LAP (\d+) (\d{1,2}):(\d{2}):(\d{2})/;
const REINSTATED = /^CAR (\d+)\b.*?\b(?:TIME (\d+:\d{2}\.\d{3}) )?(?:LAP )?(?:TIME )?REINSTATED/;
const TIME_EPS = 0.0015; // s, matching official times

export interface DeletedLap {
  /** Race control's reason, e.g. "TRACK LIMITS AT TURN 15". */
  reason: string;
  /** When race control deleted it (ms since t0). */
  t: Ms;
}

const parseTime = (s: string) => {
  const [m, sec] = s.split(":");
  return Number(m) * 60 + Number(sec);
};

/**
 * Laps whose time race control deleted (and didn't reinstate), by `${driver}:${lap}`, and how many deletions matched
 * no lap. A message names the lap time when there is one (matched to the lap with that time), else the incident's
 * local time of day at the track (the lap it happened in), else OpenF1's lap number. `lapsOf`: each driver's laps
 * by lap number; `t0`: absolute ms of t = 0.
 */
export function deletedLaps(
  raceControl: readonly RaceControlMsg[],
  lapsOf: ReadonlyMap<number, readonly Lap[]>,
  gmtOffset: string,
  t0: number,
): { deleted: Map<string, DeletedLap>; unmatched: number } {
  const [oh, om] = gmtOffset.replace("-", "").split(":").map(Number);
  const offsetMs = (gmtOffset.startsWith("-") ? -1 : 1) * ((oh || 0) * 60 + (om || 0)) * 60_000;
  /** Local wall-clock time of an incident -> ms since t0, on the day that puts it just before `issued`. */
  function incidentTime(issued: Ms, h: number, m: number, s: number): Ms {
    const local = new Date(t0 + issued + offsetMs);
    const day = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
    let t = day + ((h * 60 + m) * 60 + s) * 1000 - offsetMs - t0;
    if (t > issued + 60_000) t -= 86_400_000;
    return t;
  }
  const deleted = new Map<string, DeletedLap>();
  let unmatched = 0;
  for (const m of raceControl) {
    const msg = m.message.toUpperCase();
    const del = msg.match(DELETED);
    if (del) {
      const n = Number(del[1]);
      const own = lapsOf.get(n) ?? [];
      const time = del[2] ? parseTime(del[2]) : null;
      const at = incidentTime(m.t, Number(del[5]), Number(del[6]), Number(del[7]));
      const byTime = time != null ? own.filter((l) => l.duration != null && Math.abs(l.duration - time) < TIME_EPS) : [];
      const during = (l: Lap) => l.start - 1_000 <= at && at <= (l.end ?? l.start + 200_000) + 1_000;
      const lap = (byTime.length === 1 ? byTime[0] : null) ?? byTime.find(during) ?? own.find(during) ?? own.find((l) => l.lap === Number(del[4]));
      if (lap) deleted.set(`${n}:${lap.lap}`, { reason: del[3].trim(), t: m.t });
      else unmatched++;
      continue;
    }
    const back = msg.match(REINSTATED);
    if (back) {
      const n = Number(back[1]);
      const time = back[2] ? parseTime(back[2]) : null;
      const lap = (lapsOf.get(n) ?? []).find((l) => deleted.has(`${n}:${l.lap}`) && (time == null || (l.duration != null && Math.abs(l.duration - time) < TIME_EPS)));
      if (lap) deleted.delete(`${n}:${lap.lap}`);
    }
  }
  return { deleted, unmatched };
}
