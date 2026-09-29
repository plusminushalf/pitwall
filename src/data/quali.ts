// Qualifying lap choices: which lap to compare for a driver. Lap traces are loaded by src/storage/load.ts.

import type { QualiData, QualiLap, SessionMeta } from "../types";

export type LapPreset = "best" | number; // fastest counting lap overall, or in segment n

/** The lap to compare for a driver when none was picked: fastest counting lap (overall or in a segment). */
export function defaultLap(meta: SessionMeta, driver: number, preset: LapPreset): number | null {
  const q = meta.quali!;
  const r = q.results.find((x) => x.driver === driver);
  const own = (k: number) => (r?.laps[k] != null && r.times[k] != null ? { lap: r.laps[k]!, time: r.times[k]! } : null);
  if (preset !== "best") {
    const s = own(preset - 1);
    if (s) return s.lap;
  }
  const best = q.segments.map((_, k) => own(k)).filter((x) => x != null).sort((a, b) => a.time - b.time)[0];
  if (best) return best.lap;
  // No counting time at all: the fastest lap with a trace (possibly deleted).
  return traced(q, driver, meta)[0]?.lap ?? null;
}

/** Laps with a trace, fastest first. */
export function traced(q: QualiData, driver: number, meta: SessionMeta): QualiLap[] {
  const dur = (l: QualiLap) => meta.laps.find((m) => m.driver === l.driver && m.lap === l.lap)?.duration ?? Infinity;
  return q.laps.filter((l) => l.driver === driver && l.trace).sort((a, b) => dur(a) - dur(b));
}
