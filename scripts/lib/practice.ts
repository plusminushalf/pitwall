// Free practice on top of normalize() (which targets races). Pure: no file or network I/O.
//
// A practice session is an hour of runs from the garage: no start, no race order. The session runs from the green
// light (pit exit open) to the chequered flag; the timing screen orders cars by their best lap so far. OpenF1 times
// the laps either side of a garage visit from pit-lane crossings, garage time included (an in-lap of 15 minutes), so
// those get no lap time, and the in-lap ends at the pit entry. A finished session also gets distance-aligned
// traces of its laps at pace (buildPracticeTraces, run by ingest), for comparing laps as in qualifying.

import { buildLapTraces, chainLapStarts, lineCrossings, median, quantile, timingLine } from "./lapTraces";
import type { NormalizeResult } from "./normalize";
import type { RawLap, RawPit, RawRaceControl } from "./openf1Types";
import { prepareQualiLaps } from "./quali";
import type { DriverLapTraces, IntervalEvent, Lap, Ms, PitStop, PositionEvent } from "../../src/types";

/** A replay starts this long before the green light (cars leave the garage from then on). */
export const PRACTICE_PRE_MS = 60_000;

/** The green light: race control's first SESSION STARTED (or pit exit open), absolute ms; null before it. */
export function practiceStart(raceControl: readonly Pick<RawRaceControl, "date" | "category" | "flag" | "scope" | "message">[]): number | null {
  let start: number | null = null;
  for (const m of raceControl) {
    const green = (m.category === "SessionStatus" && /STARTED/i.test(m.message)) || (m.category === "Flag" && m.flag === "GREEN" && m.scope === "Track");
    if (!green) continue;
    const t = Date.parse(m.date);
    if (start == null || t < start) start = t;
  }
  return start;
}

/**
 * Raw practice laps made safe for normalize(), before it runs: the laps either side of a garage visit get no lap time.
 * An out-lap is timed from the previous pit-lane crossing, as in qualifying (prepareQualiLaps), and the in-lap before
 * it until the car leaves the garage again.
 */
export function preparePracticeLaps(laps: RawLap[], pits: RawPit[]): RawLap[] {
  const prepared = prepareQualiLaps(laps, pits);
  const outLaps = new Set(prepared.filter((l) => l.is_pit_out_lap).map((l) => `${l.driver_number}:${l.lap_number}`));
  return prepared.map((l) => (l.lap_duration != null && outLaps.has(`${l.driver_number}:${l.lap_number + 1}`) ? { ...l, lap_duration: null } : l));
}

/**
 * In-laps (the lap before an out-lap) end where the car enters the pit lane, not when it leaves the garage again.
 * `lapsOf`: each driver's laps by lap number. Mutates the laps.
 */
export function endInLapsAtPitEntry(lapsOf: ReadonlyMap<number, Lap[]>, pits: readonly PitStop[]): void {
  for (const [n, own] of lapsOf) {
    const entries = pits.filter((p) => p.driver === n).map((p) => p.entry);
    own.forEach((l, i) => {
      const next = own[i + 1];
      if (l.duration != null || l.end == null || !next?.pitOut || next.lap !== l.lap + 1) return;
      const entry = entries.find((e) => e > l.start && e < l.end!);
      if (entry != null) l.end = entry;
    });
  }
}

/**
 * The timing screen at every change: each car's position and its gaps (seconds) to the fastest and to the car ahead,
 * by best lap so far. A lap counts from its end until race control deletes it (Lap.deleted). Cars without a time
 * follow in car number order, with no gaps. Both lists start with every car at t = 0.
 */
export function practiceStandings(laps: readonly Lap[], drivers: readonly number[]): { positions: PositionEvent[]; intervals: IntervalEvent[] } {
  type Time = { time: number; set: Ms };
  type Change = { t: Ms; driver: number; lap: Time; add: boolean };
  const changes: Change[] = [];
  for (const l of laps) {
    if (l.duration == null || l.end == null) continue;
    const lap = { time: l.duration, set: l.end };
    changes.push({ t: l.end, driver: l.driver, lap, add: true });
    if (l.deleted) changes.push({ t: Math.max(l.deleted.t, l.end), driver: l.driver, lap, add: false });
  }
  // Removals after additions at the same time: a lap deleted as it ends never counts.
  changes.sort((a, b) => a.t - b.t || Number(b.add) - Number(a.add));

  // Each car's laps that count, and the best of them (ties: the one set first ranks first).
  const counting = new Map(drivers.map((n) => [n, new Set<Time>()]));
  const bests = new Map<number, Time>();
  const positions: PositionEvent[] = [];
  const intervals: IntervalEvent[] = [];
  const last = new Map<number, { position: number; gap: number | null; interval: number | null }>();
  const round = (s: number) => Math.round(s * 1000) / 1000;

  const publish = (t: Ms) => {
    const order = [...drivers].sort((a, b) => {
      const ba = bests.get(a);
      const bb = bests.get(b);
      if (!ba || !bb) return !ba && !bb ? a - b : !ba ? 1 : -1;
      return ba.time - bb.time || ba.set - bb.set || a - b;
    });
    const fastest = bests.get(order[0])?.time ?? null;
    order.forEach((n, i) => {
      const own = bests.get(n)?.time ?? null;
      const ahead = i > 0 ? (bests.get(order[i - 1])?.time ?? null) : null;
      const next = {
        position: i + 1,
        gap: own != null && fastest != null && i > 0 ? round(own - fastest) : null,
        interval: own != null && ahead != null ? round(own - ahead) : null,
      };
      const prev = last.get(n);
      if (!prev || prev.position !== next.position) positions.push({ t, driver: n, position: next.position });
      if (!prev || prev.gap !== next.gap || prev.interval !== next.interval) intervals.push({ t, driver: n, gapToLeader: next.gap, interval: next.interval });
      last.set(n, next);
    });
  };

  publish(0);
  for (let i = 0; i < changes.length; ) {
    const t = changes[i].t;
    for (; i < changes.length && changes[i].t === t; i++) {
      const { driver, lap, add } = changes[i];
      const own = counting.get(driver);
      if (!own) continue;
      if (add) own.add(lap);
      else own.delete(lap);
      let best: Time | undefined;
      for (const x of own) if (!best || x.time < best.time || (x.time === best.time && x.set < best.set)) best = x;
      if (best) bests.set(driver, best);
      else bests.delete(driver);
    }
    publish(t);
  }
  return { positions, intervals };
}

/**
 * Laps within this share of the driver's best get a trace: push laps and runs at race pace, not cool-down laps (the
 * 107% rule, per driver).
 */
export const TRACE_RATIO = 1.07;

export interface PracticeTraces {
  traces: Map<number, DriverLapTraces>;
  /** Summary for ingest's output. */
  lines: string[];
  problems: string[];
}

/**
 * A finished session's distance-aligned lap traces (lapTraces.ts): every timed lap within TRACE_RATIO of the driver's
 * best (out- and in-laps have no lap time), measured on the laps within it of the session's fastest. Lap starts are
 * chained through the lap times for the traces only: meta.laps stays as normalize() left it, as the live relay and a
 * download being watched have it (neither has traces). Adds lapLength, sectorDistances and traced to meta.practice.
 */
export function buildPracticeTraces({ meta, telemetry }: Pick<NormalizeResult, "meta" | "telemetry">): PracticeTraces {
  const laps = meta.laps.map((l) => ({ ...l }));
  const lapsOf = new Map<number, Lap[]>();
  for (const l of laps) {
    if (!lapsOf.has(l.driver)) lapsOf.set(l.driver, []);
    lapsOf.get(l.driver)!.push(l);
  }
  for (const own of lapsOf.values()) own.sort((a, b) => a.lap - b.lap);
  const line = timingLine(laps, telemetry);
  const { moves, brokenRuns } = chainLapStarts(lapsOf, (n) => lineCrossings(line, telemetry.get(n)?.loc));

  const timed = [...lapsOf.values()].flat().filter((l) => l.duration != null && l.end != null && !l.pitOut);
  const best = new Map<number, number>();
  for (const l of timed) best.set(l.driver, Math.min(best.get(l.driver) ?? Infinity, l.duration!));
  const fastest = Math.min(...best.values());
  const atPace = timed.filter((l) => l.duration! <= TRACE_RATIO * best.get(l.driver)!);
  const built = buildLapTraces(atPace, (l) => l.duration! <= TRACE_RATIO * fastest, telemetry, meta.track);

  const traces = new Map([...built.traces].sort(([a], [b]) => a - b));
  if (traces.size && Number.isFinite(built.lapLength) && meta.practice) {
    const round = (m: number) => Math.round(m * 10) / 10;
    meta.practice = {
      ...meta.practice,
      lapLength: round(built.lapLength),
      sectorDistances: [round(built.sectorDistances[0]), round(built.sectorDistances[1])],
      traced: [...traces.values()].map((tr) => ({ driver: tr.driver, laps: tr.laps.map((l) => l.lap) })),
    };
  }
  const lines = [
    `lap starts chained through the lap times (for the traces): ${moves.length} laps, moved median ${median(moves).toFixed(0)} ms, p95 ${quantile(moves, 0.95).toFixed(0)} ms` +
      (brokenRuns ? ` (${brokenRuns} runs left alone: durations don't chain)` : ""),
    `laps at pace (within ${Math.round((TRACE_RATIO - 1) * 100)}% of the driver's best): ${atPace.length} of ${timed.length} timed laps`,
    ...built.lines,
  ];
  return { traces, lines, problems: built.problems };
}
