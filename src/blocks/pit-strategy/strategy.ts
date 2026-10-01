// Pit stops and undercuts, worked out from lap-line crossings, stints and pit records. Pure: the block
// passes in what the hooks return at t (completed laps, stints started, stops finished, neutral periods),
// so nothing here can see past t either. An undercut shows only once both cars have stopped and crossed
// the line after.

import type { NeutralPeriod } from "block-kit";

/** A completed lap: when the car crossed the line at its end. */
export interface LapLine {
  lap: number;
  end: number;
}

export interface StintStart {
  stint: number;
  lapStart: number;
  compound: string;
}

export interface PitRecord {
  entry: number;
  exit: number;
  laneDuration: number | null;
  stopDuration: number | null;
}

/** One car as the hooks give it at t. */
export interface CarInput {
  driver: number;
  laps: readonly LapLine[];
  stints: readonly StintStart[];
  /** Empty in early 2023 races (OpenF1 has no pit records): stops then come from the stints alone. */
  pits: readonly PitRecord[];
}

export type Neutralised = "SC" | "VSC" | null;

export interface Stop {
  driver: number;
  /** The in-lap: the car came in at the end of this lap. */
  lap: number;
  /** Compound before the stop, if known. */
  from: string | null;
  /** Compound after; null when no new stint started at the stop (no tyre change recorded). */
  to: string | null;
  /** Seconds in the pit lane and stationary, when there's a pit record (and it has them). */
  lane: number | null;
  stationary: number | null;
  /** Position at the line before the in-lap, and at the end of the out-lap; null when not known (yet). */
  before: number | null;
  after: number | null;
  /** The stop was made under a safety car or VSC (cheaper: the others are slow too). */
  under: Neutralised;
  /** Pit entry: from the pit record, else estimated from the end of the in-lap. */
  t: number;
}

export interface Duel {
  /** Undercut: the car behind stopped first. Overcut: the car ahead stopped first and the one behind stayed out. */
  kind: "undercut" | "overcut";
  /** The car behind before the first stop, trying to get ahead; the defender was just ahead of it. */
  attacker: number;
  defender: number;
  attackerStop: Stop;
  defenderStop: Stop;
  /** The attacker was ahead once both had stopped (at the end of the second car's out-lap). */
  worked: boolean;
  /** Seconds between them at that line. */
  margin: number;
  /** When it was settled: the second of the two crossing that line. */
  t: number;
}

/** Running close: next to each other at the line before the first stop, at most this far apart. */
export const CLOSE_S = 3;
/** The other car's stop counts as the reply only within this many laps of the first. */
export const REPLY_LAPS = 5;
/** Without a pit record, pit entry is taken as this long before the in-lap ends (the line is in the pit lane). */
export const ENTRY_BEFORE_LINE_MS = 15_000;

/** Every car's line crossings, by car and by lap. */
interface Lines {
  end: (driver: number, lap: number) => number | null;
  /** 1 + the cars across that line before this one; null if it hasn't crossed it. */
  position: (driver: number, lap: number) => number | null;
  /** The cars just ahead and just behind at that line, with the gap to each (ms, positive). */
  neighbours: (driver: number, lap: number) => { driver: number; gap: number; ahead: boolean }[];
}

function linesOf(cars: readonly CarInput[]): Lines {
  const byCar = new Map<number, Map<number, number>>();
  const byLap = new Map<number, { driver: number; end: number }[]>();
  for (const c of cars) {
    const own = new Map<number, number>();
    for (const l of c.laps) {
      own.set(l.lap, l.end);
      const line = byLap.get(l.lap) ?? [];
      line.push({ driver: c.driver, end: l.end });
      byLap.set(l.lap, line);
    }
    byCar.set(c.driver, own);
  }
  for (const line of byLap.values()) line.sort((a, b) => a.end - b.end);
  const end = (driver: number, lap: number) => byCar.get(driver)?.get(lap) ?? null;
  const indexAt = (driver: number, lap: number) => byLap.get(lap)?.findIndex((x) => x.driver === driver) ?? -1;
  return {
    end,
    position: (driver, lap) => {
      const i = indexAt(driver, lap);
      return i < 0 ? null : i + 1;
    },
    neighbours: (driver, lap) => {
      const line = byLap.get(lap) ?? [];
      const i = indexAt(driver, lap);
      if (i < 0) return [];
      const own = line[i].end;
      const out = [];
      if (i > 0) out.push({ driver: line[i - 1].driver, gap: own - line[i - 1].end, ahead: true });
      if (i + 1 < line.length) out.push({ driver: line[i + 1].driver, gap: line[i + 1].end - own, ahead: false });
      return out;
    },
  };
}

/**
 * Safety car or VSC at x (a pit entry), from the periods so far. A period ends with the track going green:
 * the leader's next line after "IN THIS LAP", 15 s after "VSC ENDING". No grace after that: the core's
 * track status already holds the ending phase, and a car entering the pits later stops at racing speed.
 * Under a red flag it's neither (the cars wait in the pit lane, nobody gains).
 */
export function neutralisedAt(periods: readonly NeutralPeriod[], x: number): Neutralised {
  const p = periods.find((p) => p.start <= x && (p.end == null || x < p.end));
  return p?.status === "SC" || p?.status === "VSC" ? p.status : null;
}

/**
 * One car's stops: each stint after the first is a stop at the end of the lap before it, matched (within
 * a lap) to the pit record entered on that lap for its timing. A record with no new stint is a stop with
 * no tyre change (a drive-through, say); a new stint with no record is a stop without timing.
 */
function stopsOf(car: CarInput, lines: Lines, periods: readonly NeutralPeriod[]): Stop[] {
  const stints = [...car.stints].sort((a, b) => a.stint - b.stint);
  const compoundOn = (lap: number) => stints.filter((s) => s.lapStart <= lap).at(-1)?.compound ?? null;
  // The lap in progress at t: one past the last lap completed by then.
  const lapAt = (t: number) => car.laps.reduce((lap, l) => (l.end <= t ? Math.max(lap, l.lap) : lap), 0) + 1;

  const changes = stints.slice(1).flatMap((s, i) => (s.lapStart > 1 ? [{ lap: s.lapStart - 1, from: stints[i].compound, to: s.compound }] : []));
  const used = new Set<number>();
  const found: { lap: number; from: string | null; to: string | null; pit: PitRecord | null }[] = [];
  for (const pit of [...car.pits].sort((a, b) => a.entry - b.entry)) {
    const lap = lapAt(pit.entry);
    const i = changes.findIndex((c, k) => !used.has(k) && Math.abs(c.lap - lap) <= 1);
    if (i >= 0) {
      used.add(i);
      found.push({ ...changes[i], pit });
    } else {
      found.push({ lap, from: compoundOn(lap), to: null, pit });
    }
  }
  changes.forEach((c, k) => !used.has(k) && found.push({ ...c, pit: null }));

  return found
    .sort((a, b) => a.lap - b.lap)
    .map(({ lap, from, to, pit }) => {
      const inLapEnd = lines.end(car.driver, lap) ?? lines.end(car.driver, lap - 1) ?? 0;
      const t = pit?.entry ?? inLapEnd - ENTRY_BEFORE_LINE_MS;
      return {
        driver: car.driver,
        lap,
        from,
        to,
        lane: pit?.laneDuration ?? null,
        stationary: pit?.stopDuration ?? null,
        before: lap >= 2 ? lines.position(car.driver, lap - 1) : null,
        after: lines.position(car.driver, lap + 1),
        under: neutralisedAt(periods, t),
        t,
      };
    });
}

/**
 * Every stop so far, and every undercut and overcut settled so far. A pair counts when the two cars were
 * next to each other within CLOSE_S at the line before the first stop, the other stopped 1 to REPLY_LAPS
 * laps later, the first didn't stop again in between, and both have crossed the line after the second
 * car's out-lap: whoever is ahead there won it. A car that retires before then settles nothing.
 */
export function analyse(cars: readonly CarInput[], periods: readonly NeutralPeriod[]): { stops: Stop[]; duels: Duel[] } {
  const lines = linesOf(cars);
  const stopsBy = new Map(cars.map((c) => [c.driver, stopsOf(c, lines, periods)]));
  const duels: Duel[] = [];
  for (const [a, stops] of stopsBy) {
    for (const first of stops) {
      if (first.lap < 2) continue; // no line before lap 1 to compare at
      for (const nb of lines.neighbours(a, first.lap - 1)) {
        if (nb.gap > CLOSE_S * 1000) continue;
        const theirs = stopsBy.get(nb.driver) ?? [];
        // They stopped on the same lap, or had just stopped: neither got the jump on the other.
        if (theirs.some((s) => s.lap >= first.lap - 1 && s.lap <= first.lap)) continue;
        const second = theirs.find((s) => s.lap > first.lap);
        if (!second || second.lap - first.lap > REPLY_LAPS) continue;
        const settle = second.lap + 1;
        if (stops.some((s) => s.lap > first.lap && s.lap <= settle)) continue;
        const endA = lines.end(a, settle);
        const endB = lines.end(nb.driver, settle);
        if (endA == null || endB == null) continue;
        // The car behind attacks: by stopping first (the neighbour was ahead), or by staying out.
        const undercut = nb.ahead;
        const [attacker, defender] = undercut ? [a, nb.driver] : [nb.driver, a];
        const [attackerStop, defenderStop] = undercut ? [first, second] : [second, first];
        const [attackerEnd, defenderEnd] = undercut ? [endA, endB] : [endB, endA];
        duels.push({
          kind: undercut ? "undercut" : "overcut",
          attacker,
          defender,
          attackerStop,
          defenderStop,
          worked: attackerEnd < defenderEnd,
          margin: Math.abs(endA - endB) / 1000,
          t: Math.max(endA, endB),
        });
      }
    }
  }
  const stops = [...stopsBy.values()].flat().sort((x, y) => x.t - y.t);
  return { stops, duels: duels.sort((x, y) => x.t - y.t) };
}
