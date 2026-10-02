// Finished free practice's lap comparison (the Fastest laps view): the classification by best lap, which laps have
// traces, the tyre each lap was on, and the lap compared by default. Lap traces are loaded by src/storage/load.ts.
// Pure.

import type { Lap, SessionMeta, Stint } from "../types";

/** A tyre set as a lap found it: compound, and laps on the set before this one (a new set's first lap is 0). */
export interface Tyre {
  compound: string;
  age: number;
}

/** The timing screen at the flag: each car by its best lap that counts. */
export interface PracticeResult {
  driver: number;
  /** By best lap (the one set first ranks first); cars without a time follow in car number order. */
  position: number;
  /** Seconds: the fastest lap race control didn't delete. */
  best: number | null;
  /** The lap that set it. */
  lap: number | null;
  /** Seconds behind P1's best. */
  gap: number | null;
  /** Laps run, out- and in-laps included. */
  laps: number;
  /** Lap times race control deleted (track limits...). */
  deleted: { lap: number; reason: string }[];
}

/** Whether a finished practice session's laps can be compared: ingest stored its lap traces. */
export const practiceComparable = (meta: SessionMeta) => meta.practice?.lapLength != null && (meta.practice.traced?.length ?? 0) > 0;

const counts = (l: Lap) => l.duration != null && !l.pitOut && !l.deleted;

/** The stint a lap belongs to: the last one started by then. */
function stintOf(stints: readonly Stint[], driver: number, lap: number): Stint | null {
  let found: Stint | null = null;
  for (const s of stints) if (s.driver === driver && s.lapStart <= lap && (!found || s.lapStart >= found.lapStart)) found = s;
  return found;
}

/** The tyre a lap was driven on (its stint's compound, the set's age at the start of the lap), if known. */
export function tyreOn(meta: Pick<SessionMeta, "stints">, driver: number, lap: number): Tyre | null {
  const s = stintOf(meta.stints, driver, lap);
  return s ? { compound: s.compound, age: s.ageAtStart + lap - s.lapStart } : null;
}

/** The classification at the flag, from the laps (as the timing tower has it at the end). */
export function practiceClassification(meta: Pick<SessionMeta, "drivers" | "laps">): PracticeResult[] {
  const rows = meta.drivers.map((d) => {
    const own = meta.laps.filter((l) => l.driver === d.number);
    let best: Lap | null = null;
    for (const l of own) if (counts(l) && (!best || l.duration! < best.duration! || (l.duration === best.duration && l.start < best.start))) best = l;
    return {
      driver: d.number,
      position: 0,
      best: best?.duration ?? null,
      lap: best?.lap ?? null,
      set: best?.end ?? Infinity,
      gap: null as number | null,
      laps: own.length,
      deleted: own.filter((l) => l.deleted && l.duration != null).map((l) => ({ lap: l.lap, reason: l.deleted!.reason })),
    };
  });
  rows.sort((a, b) => {
    if (a.best == null || b.best == null) return a.best == null && b.best == null ? a.driver - b.driver : a.best == null ? 1 : -1;
    return a.best - b.best || a.set - b.set || a.driver - b.driver;
  });
  const top = rows[0]?.best ?? null;
  return rows.map(({ set: _, ...r }, i) => ({ ...r, position: i + 1, gap: i > 0 && r.best != null && top != null ? Math.round((r.best - top) * 1000) / 1000 : null }));
}

/** A driver's laps with a trace (lap numbers, in lap order). */
export const tracedLaps = (meta: SessionMeta, driver: number): number[] => meta.practice?.traced?.find((t) => t.driver === driver)?.laps ?? [];

/** The lap compared when none was picked: the driver's best (if it has a trace), else their fastest traced lap that counts, else any. */
export function defaultPracticeLap(meta: SessionMeta, driver: number, classification = practiceClassification(meta)): number | null {
  const traced = new Set(tracedLaps(meta, driver));
  const best = classification.find((r) => r.driver === driver)?.lap;
  if (best != null && traced.has(best)) return best;
  const own = meta.laps.filter((l) => l.driver === driver && traced.has(l.lap) && l.duration != null).sort((a, b) => a.duration! - b.duration!);
  return (own.find((l) => !l.deleted) ?? own[0])?.lap ?? null;
}
