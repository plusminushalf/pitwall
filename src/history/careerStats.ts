// What a driver's or a team's races say: a season's form, head-to-heads with teammates, career firsts and lasts,
// streaks, where they win. Pure, over the races in a DriverHistory or TeamHistory (./types.ts). A driver's race is an
// outing with one car, a team's with all of its cars, so most of this works for both.

import type { CarResult, DriverRace, RaceRef, TeamRace } from "./types";

/** A Grand Prix and the cars that count in it: the driver's one, or all of a team's. */
export interface Outing {
  race: RaceRef;
  cars: CarResult[];
}

export const driverOutings = (races: readonly DriverRace[]): Outing[] => races.map(({ car, mates: _, ...race }) => ({ race, cars: [car] }));
export const teamOutings = (races: readonly TeamRace[]): Outing[] => races.map(({ cars, ...race }) => ({ race, cars }));

const won = (c: CarResult) => c.pos === 1;
const podium = (c: CarResult) => c.pos != null && c.pos <= 3;
const scored = (c: CarResult) => (c.points ?? 0) > 0;
/** Not classified: retired, disqualified, not classified, excluded. */
export const retired = (c: CarResult) => c.pos == null;

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export interface SeasonSummary {
  races: number;
  wins: number;
  podiums: number;
  poles: number;
  points: number;
  /** Over every car's start, and over the classified finishes. */
  avgGrid: number | null;
  avgFinish: number | null;
  best: CarResult | null;
  /** Cars not classified. */
  retirements: number;
  /** Cars in the points. */
  pointsFinishes: number;
  /** Races the team's cars finished first and second. */
  oneTwos: number;
  cars: number;
}

export function summarize(outings: readonly Outing[]): SeasonSummary {
  const cars = outings.flatMap((o) => o.cars);
  const best = cars.reduce<CarResult | null>((b, c) => (b == null || c.order < b.order ? c : b), null);
  return {
    races: outings.length,
    wins: cars.filter(won).length,
    podiums: cars.filter(podium).length,
    poles: cars.filter((c) => c.pole).length,
    points: Math.round(cars.reduce((s, c) => s + (c.points ?? 0), 0) * 100) / 100,
    avgGrid: mean(cars.flatMap((c) => (c.grid != null && c.grid > 0 ? [c.grid] : []))),
    avgFinish: mean(cars.flatMap((c) => (c.pos != null ? [c.pos] : []))),
    best,
    retirements: cars.filter(retired).length,
    pointsFinishes: cars.filter(scored).length,
    oneTwos: outings.filter((o) => o.cars.some((c) => c.pos === 1) && o.cars.some((c) => c.pos === 2)).length,
    cars: cars.length,
  };
}

export interface HeadToHead {
  mateId: string;
  /** Races together. */
  races: number;
  /** Qualified ahead / behind, where both have a position. */
  quali: [number, number];
  /** Finished ahead / behind (on the result sheet: a car still running beats one that retired). */
  race: [number, number];
  /** Points each, in these races. */
  points: [number, number];
  /** Seasons together. */
  years: [number, number];
}

/** The driver against each teammate, the most races together first. */
export function headToHeads(races: readonly DriverRace[]): HeadToHead[] {
  const by = new Map<string, HeadToHead>();
  for (const r of races) {
    for (const m of r.mates) {
      const h = by.get(m.driverId) ?? { mateId: m.driverId, races: 0, quali: [0, 0], race: [0, 0], points: [0, 0], years: [r.year, r.year] };
      h.races++;
      const q = [r.car.quali ?? r.car.grid, m.quali ?? m.grid];
      if (q[0] != null && q[1] != null && q[0] > 0 && q[1] > 0 && q[0] !== q[1]) h.quali[q[0] < q[1] ? 0 : 1]++;
      if (r.car.order !== m.order) h.race[r.car.order < m.order ? 0 : 1]++;
      h.points = [h.points[0] + (r.car.points ?? 0), h.points[1] + (m.points ?? 0)];
      h.years = [Math.min(h.years[0], r.year), Math.max(h.years[1], r.year)];
      by.set(m.driverId, h);
    }
  }
  return [...by.values()]
    .map((h) => ({ ...h, points: [Math.round(h.points[0] * 100) / 100, Math.round(h.points[1] * 100) / 100] as [number, number] }))
    .sort((a, b) => b.races - a.races || b.years[1] - a.years[1]);
}

/** Each driver's share of a team's season: races, points, wins, best finish. Most points first. */
export function driverSplit(outings: readonly Outing[]): { driverId: string; races: number; points: number; wins: number; podiums: number; best: number | null }[] {
  const by = new Map<string, { driverId: string; races: number; points: number; wins: number; podiums: number; best: number | null }>();
  for (const o of outings) {
    for (const c of o.cars) {
      const d = by.get(c.driverId) ?? { driverId: c.driverId, races: 0, points: 0, wins: 0, podiums: 0, best: null };
      d.races++;
      d.points = Math.round((d.points + (c.points ?? 0)) * 100) / 100;
      if (won(c)) d.wins++;
      if (podium(c)) d.podiums++;
      if (c.pos != null && (d.best == null || c.pos < d.best)) d.best = c.pos;
      by.set(c.driverId, d);
    }
  }
  return [...by.values()].sort((a, b) => b.points - a.points || b.races - a.races);
}

/** The first outing a car of which did `what`, and the car. */
function first(outings: readonly Outing[], what: (c: CarResult) => boolean | undefined) {
  for (const o of outings) {
    const car = o.cars.filter((c) => what(c)).sort((a, b) => a.order - b.order)[0];
    if (car) return { race: o.race, car };
  }
  return null;
}

const last = (outings: readonly Outing[], what: (c: CarResult) => boolean | undefined) => first([...outings].reverse(), what);

export interface Milestone {
  label: string;
  race: RaceRef;
  car: CarResult;
}

/** Debut, the firsts (points, podium, pole, win, and for a team a 1-2), and the latest win and pole. */
export function milestones(outings: readonly Outing[], team = false): Milestone[] {
  const out: Milestone[] = [];
  const push = (label: string, m: { race: RaceRef; car: CarResult } | null) => m && out.push({ label, ...m });
  push(team ? "First race" : "Debut", outings[0] ? { race: outings[0].race, car: [...outings[0].cars].sort((a, b) => a.order - b.order)[0] } : null);
  push("First points", first(outings, scored));
  push("First podium", first(outings, podium));
  push("First pole", first(outings, (c) => c.pole));
  push("First win", first(outings, won));
  if (team) {
    const o = outings.find((x) => x.cars.some((c) => c.pos === 1) && x.cars.some((c) => c.pos === 2));
    push("First 1-2", o ? { race: o.race, car: o.cars.find(won)! } : null);
  }
  const lastWin = last(outings, won);
  if (lastWin && lastWin.race.raceId !== first(outings, won)?.race.raceId) push("Latest win", lastWin);
  const lastPole = last(outings, (c) => c.pole);
  if (lastPole && lastPole.race.raceId !== first(outings, (c) => c.pole)?.race.raceId) push("Latest pole", lastPole);
  return out;
}

/** The longest run of consecutive outings where `what` held (for a team: by any car), and where it started. */
export function longestRun(outings: readonly Outing[], what: (c: CarResult) => boolean | undefined): { length: number; from: RaceRef; to: RaceRef } | null {
  let best: { length: number; from: RaceRef; to: RaceRef } | null = null;
  let run = 0;
  let from: RaceRef | null = null;
  for (const o of outings) {
    if (o.cars.some((c) => what(c))) {
      if (run === 0) from = o.race;
      run++;
      if (!best || run > best.length) best = { length: run, from: from!, to: o.race };
    } else run = 0;
  }
  return best;
}

export const winStreak = (outings: readonly Outing[]) => longestRun(outings, won);
export const podiumStreak = (outings: readonly Outing[]) => longestRun(outings, podium);
export const pointsStreak = (outings: readonly Outing[]) => longestRun(outings, scored);

/** The circuits with the most wins (then poles, then podiums): id, races there, wins, poles, podiums. */
export function bestCircuits(outings: readonly Outing[], n = 5) {
  const by = new Map<string, { circuit: string; races: number; wins: number; poles: number; podiums: number }>();
  for (const o of outings) {
    const t = by.get(o.race.circuit) ?? { circuit: o.race.circuit, races: 0, wins: 0, poles: 0, podiums: 0 };
    t.races++;
    t.wins += o.cars.filter(won).length;
    t.poles += o.cars.filter((c) => c.pole).length;
    t.podiums += o.cars.filter(podium).length;
    by.set(o.race.circuit, t);
  }
  return [...by.values()]
    .filter((t) => t.wins + t.poles + t.podiums > 0)
    .sort((a, b) => b.wins - a.wins || b.poles - a.poles || b.podiums - a.podiums || b.races - a.races)
    .slice(0, n);
}

/** Wins and starts by the cars' team (a driver's teams) or driver (a team's drivers): most wins, then most starts. */
export function tally(outings: readonly Outing[], by: "team" | "driver") {
  const out = new Map<string, { id: string; starts: number; wins: number; poles: number; podiums: number; points: number }>();
  for (const o of outings) {
    for (const c of o.cars) {
      const id = by === "team" ? c.constructorId : c.driverId;
      const t = out.get(id) ?? { id, starts: 0, wins: 0, poles: 0, podiums: 0, points: 0 };
      t.starts++;
      if (won(c)) t.wins++;
      if (c.pole) t.poles++;
      if (podium(c)) t.podiums++;
      t.points = Math.round((t.points + (c.points ?? 0)) * 100) / 100;
      out.set(id, t);
    }
  }
  return [...out.values()].sort((a, b) => b.wins - a.wins || b.podiums - a.podiums || b.starts - a.starts);
}

/** The latest `n` outings, newest last. */
export const form = (outings: readonly Outing[], n = 5) => outings.slice(-n);
