// Session bests: the session's records so far, the stats posted after a race ("fastest sectors: S1 31.845 Hamilton…").
// The fastest lap, each sector's fastest time, the ideal lap they add up to, the top speed and, in a race, the
// quickest pit stop, each with who set it, on which lap and tyres, and the next driver's best behind it. Pure: the
// widget feeds it what it has at t (nothing past it).
//
// The same rules as the rest of the app, so the purple here is the purple in the tower: a sector counts from any
// completed lap (useBestSectors), the fastest lap leaves out laps race control has deleted by t (useFastestLap). A tie
// goes to whoever set it first, as in the timing.

import type { Lap, PitStop, Stint } from "widget-kit";

/** The part of a completed lap this needs. */
export type BestLap = Pick<Lap, "lap" | "start" | "end" | "duration" | "sectors" | "speedTrap" | "deleted">;
/** The part of a stint this needs. */
export type BestStint = Pick<Stint, "lapStart" | "compound" | "ageAtStart">;
/** The part of a pit stop this needs. */
export type BestPit = Pick<PitStop, "lap" | "entry" | "exit" | "laneDuration" | "stopDuration">;

export type RecordId = "lap" | "s1" | "s2" | "s3" | "speed" | "stop" | "lane";

export const LABELS: Record<RecordId, string> = {
  lap: "Fastest lap",
  s1: "S1",
  s2: "S2",
  s3: "S3",
  speed: "Top speed",
  stop: "Pit stop",
  lane: "Pit lane",
};

/** One driver's best at something: its value (s, or km/h), the lap and when to watch it, and the tyres it was on. */
export interface Mark {
  driver: number;
  value: number;
  lap: number;
  /** When to seek to (ms): the lap's start, or a pit stop's entry. */
  at: number;
  /** When it was set (ms), for ties. */
  set: number;
  compound: string | null;
  /** Laps on the set before this lap; null when not known. */
  age: number | null;
}

/** A record: the best, and the best of anyone else behind it (null: nobody else has one). */
export interface SessionRecord {
  id: RecordId;
  best: Mark;
  next: Mark | null;
}

/** The fastest sectors added up, against the fastest lap. */
export interface IdealLap {
  value: number;
  /** Who set each sector. */
  drivers: [number, number, number];
  /** Under the fastest lap by this much (s); null with no fastest lap. */
  under: number | null;
}

export interface Bests {
  records: SessionRecord[];
  ideal: IdealLap | null;
}

export interface CarInput {
  driver: number;
  laps: readonly BestLap[];
  stints: readonly BestStint[];
  pits: readonly BestPit[];
}

/** Higher is better (top speed); lower otherwise. */
const HIGHER: ReadonlySet<RecordId> = new Set(["speed"]);

/** The tyres on `lap`: its stint is the last to start by it. */
function tyreOn(stints: readonly BestStint[], lap: number): { compound: string | null; age: number | null } {
  let s: BestStint | null = null;
  for (const x of stints) if (x.lapStart <= lap && (!s || x.lapStart > s.lapStart)) s = x;
  if (!s) return { compound: null, age: null };
  return { compound: s.compound, age: s.ageAtStart == null ? null : s.ageAtStart + lap - s.lapStart };
}

const better = (id: RecordId, a: Mark, b: Mark) => (a.value !== b.value ? (HIGHER.has(id) ? a.value > b.value : a.value < b.value) : a.set < b.set);

/** Each value a car's lap or stop gives, by record. */
function marksOf(car: CarInput, t: number, race: boolean, deletedBy: number): Partial<Record<RecordId, Mark[]>> {
  const out: Partial<Record<RecordId, Mark[]>> = {};
  const add = (id: RecordId, m: Mark) => (out[id] ??= []).push(m);
  for (const l of car.laps) {
    if (l.end == null || l.end > t) continue;
    const base = { driver: car.driver, lap: l.lap, at: l.start, set: l.end, ...tyreOn(car.stints, l.lap) };
    if (l.duration != null && l.duration > 0 && !(l.deleted && l.deleted.t <= deletedBy)) add("lap", { ...base, value: l.duration });
    l.sectors.forEach((v, k) => {
      if (v != null && v > 0) add((["s1", "s2", "s3"] as const)[k], { ...base, value: v });
    });
    const speed = l.speedTrap.st ?? l.speedTrap.i2;
    if (speed != null && speed > 0) add("speed", { ...base, value: speed });
  }
  if (race) {
    for (const p of car.pits) {
      if (p.exit > t) continue;
      const base = { driver: car.driver, lap: p.lap, at: p.entry, set: p.exit, ...tyreOn(car.stints, p.lap + 1) };
      if (p.stopDuration != null && p.stopDuration > 0) add("stop", { ...base, value: p.stopDuration });
      if (p.laneDuration != null && p.laneDuration > 0) add("lane", { ...base, value: p.laneDuration });
    }
  }
  return out;
}

const ORDER: RecordId[] = ["s1", "s2", "s3", "lap", "speed", "stop", "lane"];

/**
 * The session's records by t, in ORDER, and the ideal lap. Pit stops only count in a race (`race`). A lap deleted by
 * `deletedBy` (t unless given: the widget's laps are already cut at t, and it passes the last deletion in effect) isn't
 * the fastest lap.
 */
export function sessionBests(cars: readonly CarInput[], t: number, race: boolean, deletedBy = t): Bests {
  // Each driver's best per record.
  const perDriver = new Map<RecordId, Mark[]>();
  for (const car of cars) {
    const marks = marksOf(car, t, race, deletedBy);
    for (const id of ORDER) {
      const own = marks[id];
      if (!own?.length) continue;
      const best = own.reduce((a, b) => (better(id, b, a) ? b : a));
      perDriver.set(id, [...(perDriver.get(id) ?? []), best]);
    }
  }
  const records: SessionRecord[] = [];
  for (const id of ORDER) {
    const all = perDriver.get(id);
    if (!all?.length) continue;
    const ranked = [...all].sort((a, b) => (better(id, a, b) ? -1 : better(id, b, a) ? 1 : 0));
    records.push({ id, best: ranked[0], next: ranked[1] ?? null });
  }
  const of = (id: RecordId) => records.find((r) => r.id === id)?.best;
  const [s1, s2, s3, lap] = [of("s1"), of("s2"), of("s3"), of("lap")];
  const ideal: IdealLap | null =
    s1 && s2 && s3
      ? { value: s1.value + s2.value + s3.value, drivers: [s1.driver, s2.driver, s3.driver], under: lap ? lap.value - (s1.value + s2.value + s3.value) : null }
      : null;
  return { records, ideal };
}

/** "+0.123" for times, "−4 km/h" for top speed: the next best's gap to the best. */
export function gapText(id: RecordId, best: Mark, next: Mark): string {
  if (HIGHER.has(id)) return `−${Math.round(best.value - next.value)}`;
  const d = next.value - best.value;
  return `+${d.toFixed(id === "stop" || id === "lane" ? 1 : 3)}`;
}

/** "Lewis HAMILTON" (OpenF1's full name) → "Lewis Hamilton". */
export function displayName(fullName: string): string {
  return fullName
    .split(" ")
    .map((w) => (w.length > 1 && w === w.toUpperCase() ? w.charAt(0) + w.slice(1).toLowerCase() : w))
    .join(" ");
}
