// Spoiler-free views of a session at time t: what the widget hooks return (H3.4).
// Pure functions over the loaded session and the shared 10 Hz race state; the hooks add caching and
// equality on top. Anything derived from the whole session belongs to useWholeSession() only.

import type { CarSeries, DriverData, FeedItem, Session } from "../data/session";
import { indexAtOrBefore } from "../engine/lookup";
import { scheduledDistance } from "../engine/raceDistance";
import { carPositionAt, mapOpacity, type RaceState } from "../engine/raceState";
import type { DriverInfo, Lap, PitStop, SessionMeta, Stint, TrackGeometry } from "../types";
import { deepEqual } from "./equal";

export type SessionKind = "race" | "qualifying" | "practice";

const kindOf = (meta: SessionMeta): SessionKind => (meta.quali || meta.qualiLive ? "qualifying" : meta.practice ? "practice" : "race");

export const sessionKind = (session: Session): SessionKind => kindOf(session.meta);

/** Cached per key object, so every widget reading the same thing shares one result. */
function cached<K extends object, V>(make: (key: K) => V): (key: K) => V {
  const cache = new WeakMap<K, V>();
  return (key) => {
    let v = cache.get(key);
    if (v === undefined) cache.set(key, (v = make(key)));
    return v;
  };
}

// ---------------------------------------------------------------- session info (fixed for the session)

/** Scheduled facts about the session: nothing here depends on how it went. */
export interface SessionInfo {
  kind: SessionKind;
  sessionKey: number;
  meetingName: string;
  sessionName: string;
  year: number;
  circuit: string;
  country: string;
  /** ISO UTC timestamp of t = 0, and the circuit's UTC offset (e.g. "04:00:00"), for local time. */
  t0: string;
  gmtOffset: string;
  /**
   * Lights out, in ms since t0 (race time = t - lightsOut). Live, before lap 1, only an estimate. Practice: the green
   * light (pit exit open); live, until it shows, the scheduled start.
   */
  lightsOut: number;
  lightsOutEstimated: boolean;
  /** Practice: when the session clock runs out (ms since t0; it keeps running under a red flag). Null otherwise. */
  scheduledEnd: number | null;
  /** Scheduled race distance (useTotalLaps() is the distance as known at t: shortened races change). Practice and qualifying: 0. */
  totalLaps: number;
  /** Live, no scheduled distance known: totalLaps is estimated from the lap length. */
  totalLapsEstimated: boolean;
}

export const sessionInfoOf = cached((meta: SessionMeta): SessionInfo => {
  const scheduled = scheduledDistance(meta);
  return {
    kind: kindOf(meta),
    sessionKey: meta.sessionKey,
    meetingName: meta.meetingName,
    sessionName: meta.sessionName,
    year: meta.year,
    circuit: meta.circuit,
    country: meta.country,
    t0: meta.t0,
    gmtOffset: meta.gmtOffset,
    lightsOut: meta.lightsOut,
    lightsOutEstimated: meta.lightsOutEstimated ?? false,
    scheduledEnd: meta.practice?.scheduledEnd ?? null,
    // (Practice and qualifying have no distance: meta.totalLaps, the most laps anyone did, would give away the session.)
    totalLaps: meta.practice || meta.quali || meta.qualiLive ? 0 : scheduled.totalLaps,
    totalLapsEstimated: scheduled.estimated,
  };
});

/** Drivers with data, in session order. */
export const driversOf = cached((session: Session): DriverInfo[] => session.driverNumbers.map((n) => session.drivers.get(n)!.info));

/** The circuit, without the reference lap (a lap time taken from the whole race). */
export type Track = Omit<TrackGeometry, "referenceLap">;

export const trackOf = cached((track: TrackGeometry): Track => {
  const { referenceLap: _, ...rest } = track;
  return rest;
});

// ---------------------------------------------------------------- the race at t

/** Driver numbers in timing-tower order (retired cars last), shared by every widget this tick. */
export const orderOf = cached((race: RaceState): number[] => race.drivers.map((d) => d.driver));

/** Each car's position, shared by every widget this tick. */
export const positionsOf = cached((race: RaceState): Map<number, number | null> => new Map(race.drivers.map((d) => [d.driver, d.position])));

/** Laps the driver has completed by t (the lap in progress isn't included). */
export function lapsAt(d: DriverData, t: number): Lap[] {
  return d.laps.filter((l) => l.end != null && l.end <= t);
}

/** A stint started by t. The one in progress is `open`, and its `lapEnd` is cut at the current lap. */
export interface StintView extends Stint {
  open: boolean;
}

/**
 * Stints started by the driver's current lap (the rule the tyre strip and tyre badge use), so a replay
 * never shows a stop that hasn't happened. `lap` is the driver's lap at t (DriverState.lap).
 */
export function stintsAt(d: DriverData, lap: number): StintView[] {
  const upTo = Math.max(lap, 1);
  const started = d.stints.filter((s) => s.lapStart <= upTo);
  return started.map((s, i) => ({ ...s, lapEnd: Math.min(s.lapEnd, upTo), open: i === started.length - 1 }));
}

/** API gap: the driver's pit stops finished by t (out of the pit lane), so lane and stationary times are known. */
export function pitsAt(d: DriverData, t: number): PitStop[] {
  return d.pits.filter((p) => p.exit <= t);
}

/** The last value of `make` per session and count: widgets reading every car share one, kept until the count moves. */
function byCount<V>(make: (session: Session, t: number) => V): (session: Session, count: number, t: number) => V {
  let last: { session: Session; count: number; value: V } | null = null;
  return (session, count, t) => {
    if (last?.session !== session || last.count !== count) last = { session, count, value: make(session, t) };
    return last.value;
  };
}

const pitExits = cached((meta: SessionMeta) => Float64Array.from(meta.pits.map((p) => p.exit).sort((a, b) => a - b)));
const allLaps = byCount((session, t) => new Map(session.driverNumbers.map((n) => [n, lapsAt(session.drivers.get(n)!, t)])));
const allPits = byCount((session, t) => new Map(session.driverNumbers.map((n) => [n, pitsAt(session.drivers.get(n)!, t)])));

/** API gap: every car's completed laps by t (lapsAt), in session order; a new map only when someone completes a lap. */
export const allLapsAt = (session: Session, t: number): ReadonlyMap<number, readonly Lap[]> =>
  allLaps(session, indexAtOrBefore(sectorIndex(session.meta).ends, t), t);

/** API gap: every car's pit stops finished by t (pitsAt), in session order; a new map only when a stop finishes. */
export const allPitsAt = (session: Session, t: number): ReadonlyMap<number, readonly PitStop[]> =>
  allPits(session, indexAtOrBefore(pitExits(session.meta), t), t);

let lastStints: { session: Session; laps: string; value: ReadonlyMap<number, readonly StintView[]> } | null = null;

/** API gap: every car's stints by its current lap (stintsAt), in session order; a new map only when a car starts a lap. */
export function allStintsAt(session: Session, race: RaceState): ReadonlyMap<number, readonly StintView[]> {
  const lapOf = new Map(race.drivers.map((d) => [d.driver, d.lap]));
  const laps = session.driverNumbers.map((n) => lapOf.get(n) ?? 0).join();
  if (lastStints?.session === session && lastStints.laps === laps) return lastStints.value;
  const value = new Map(session.driverNumbers.map((n) => [n, stintsAt(session.drivers.get(n)!, lapOf.get(n) ?? 0)]));
  lastStints = { session, laps, value };
  return value;
}

/** A safety car, virtual safety car or red flag; `end` is null while it's still out at t. */
export interface NeutralPeriod {
  status: "SC" | "VSC" | "RED";
  start: number;
  end: number | null;
}

const statusTimes = cached((meta: SessionMeta) => Float64Array.from(meta.trackStatus, (e) => e.t));

const neutral = byCount((session, t): NeutralPeriod[] => {
  const out: NeutralPeriod[] = [];
  let open: NeutralPeriod | null = null;
  for (const e of session.meta.trackStatus) {
    if (e.t > t) break;
    // "Ending" is the same period (the car comes in at the end of the lap, the VSC lifts in seconds).
    const status = e.status === "SC" || e.status === "SC_ENDING" ? "SC" : e.status === "VSC" || e.status === "VSC_ENDING" ? "VSC" : e.status === "RED" ? "RED" : null;
    if (open && open.status !== status) {
      open.end = e.t;
      open = null;
    }
    if (status && !open) out.push((open = { status, start: e.t, end: null }));
  }
  return out;
});

/**
 * API gap: safety car, VSC and red flag periods started by t, oldest first, from the same track status the
 * top bar and timeline show (SC_ENDING and VSC_ENDING count as part of their period).
 */
export const neutralPeriodsAt = (session: Session, t: number): readonly NeutralPeriod[] =>
  neutral(session, indexAtOrBefore(statusTimes(session.meta), t), t);

/** Every completed lap in the session by end time, with the running best per sector. */
interface SectorIndex {
  ends: Float64Array;
  best: Float64Array[]; // best[k][i] = fastest sector k among the first i + 1 laps to finish
}

const sectorIndex = cached((meta: SessionMeta): SectorIndex => {
  const laps = meta.laps.filter((l) => l.end != null).sort((a, b) => a.end! - b.end!);
  const best = [0, 1, 2].map((k) => {
    const out = new Float64Array(laps.length);
    let min = Infinity;
    for (let i = 0; i < laps.length; i++) {
      const v = laps[i].sectors[k];
      if (v != null && v < min) min = v;
      out[i] = min;
    }
    return out;
  });
  return { ends: Float64Array.from(laps, (l) => l.end!), best };
});

/** Fastest time in each sector (seconds) by anyone, among laps finished by t; null before any. */
export function bestSectorsAt(session: Session, t: number): [number | null, number | null, number | null] {
  const { ends, best } = sectorIndex(session.meta);
  const i = indexAtOrBefore(ends, t);
  const at = (k: number) => (i >= 0 && Number.isFinite(best[k][i]) ? best[k][i] : null);
  return [at(0), at(1), at(2)];
}

/** Index of the newest feed item shown at t. At the end of the replay, includes post-race items. */
export function feedEndAt(session: Session, t: number): number {
  return t >= session.meta.duration ? session.feed.length - 1 : indexAtOrBefore(session.feedTimes, t);
}

/** A feed item as widgets see it. */
export interface FeedEntry extends FeedItem {
  /** API gap: stable key, kept while the item stays the same (live sessions are rebuilt as data arrives). */
  id: number;
  /** API gap: after the replay window (stewards' decisions, only shown at the very end). */
  postRace: boolean;
}

const contentKey = (f: FeedItem, postRace: boolean) =>
  `${f.t}|${f.kind}|${f.driver}|${f.flag ?? ""}|${f.url ?? ""}|${postRace}|${f.inferred?.join(",") ?? ""}|${f.text}`;

/** The last session's entries by content, so a rebuilt (live) session reuses them: same identity, same id. */
let reuse: { sessionKey: number; byKey: Map<string, FeedEntry[]>; nextId: number } | null = null;

const feedEntriesOf = cached((session: Session): FeedEntry[] => {
  const { sessionKey, duration } = session.meta;
  const prev = reuse?.sessionKey === sessionKey ? reuse : null;
  const byKey = new Map<string, FeedEntry[]>();
  let nextId = prev?.nextId ?? 0;
  const entries = session.feed.map((f) => {
    const postRace = f.t > duration;
    const key = contentKey(f, postRace);
    const entry = prev?.byKey.get(key)?.shift() ?? { ...f, id: nextId++, postRace };
    const same = byKey.get(key);
    if (same) same.push(entry);
    else byKey.set(key, [entry]);
    return entry;
  });
  reuse = { sessionKey, byKey, nextId };
  return entries;
});

/** Feed items up to index `end` (from feedEndAt), newest first. */
export const feedUpTo = (session: Session, end: number): FeedEntry[] => feedEntriesOf(session).slice(0, end + 1).reverse();

/** The session part of the height input (HeightInput); the previous object while they're unchanged (a live session is rebuilt often). */
let lastHeightInput: { info: SessionInfo; drivers: DriverInfo[]; track: Track } | null = null;

export function heightInputOf(session: Session): { info: SessionInfo; drivers: DriverInfo[]; track: Track } {
  const next = { info: sessionInfoOf(session.meta), drivers: driversOf(session), track: trackOf(session.meta.track) };
  if (lastHeightInput && deepEqual(lastHeightInput, next)) return lastHeightInput;
  return (lastHeightInput = next);
}

/** Car telemetry samples, columnar: copies, so nothing past t is reachable (not even via `.buffer`). */
export interface CarHistory {
  t: Float64Array;
  speed: Float32Array;
  rpm: Float32Array;
  gear: Uint8Array;
  throttle: Float32Array;
  brake: Float32Array;
  /** Absent from 2026 (no DRS). */
  drs: Uint8Array | null;
}

/** Sample index range [from, to] of `car` inside [t - windowMs, t] (empty when to < from). */
export function historyRange(car: CarSeries, t: number, windowMs: number): { from: number; to: number } {
  const lo = t - Math.max(windowMs, 0);
  const before = indexAtOrBefore(car.t, lo);
  const from = before >= 0 && car.t[before] === lo ? before : before + 1;
  return { from, to: indexAtOrBefore(car.t, t) };
}

/** The last slices taken, so widgets showing the same car and window share one copy. */
const slices: { car: CarSeries; from: number; to: number; history: CarHistory }[] = [];

/** historySlice, cached: the same range of the same car is the same object. */
export function historyOf(car: CarSeries, from: number, to: number): CarHistory {
  const hit = slices.find((s) => s.car === car && s.from === from && s.to === to);
  if (hit) return hit.history;
  const history = historySlice(car, from, to);
  slices.unshift({ car, from, to, history });
  slices.length = Math.min(slices.length, 8);
  return history;
}

export function historySlice(car: CarSeries, from: number, to: number): CarHistory {
  const end = Math.max(to + 1, from);
  return {
    t: car.t.slice(from, end),
    speed: car.speed.slice(from, end),
    rpm: car.rpm.slice(from, end),
    gear: car.gear.slice(from, end),
    throttle: car.throttle.slice(from, end),
    brake: car.brake.slice(from, end),
    drs: car.drs ? car.drs.slice(from, end) : null,
  };
}

/** The car on the map at t: track coordinates (as useTrack's outline) and opacity (fading after retiring). */
export interface CarPosition {
  x: number;
  y: number;
  opacity: number;
  /** API gap: in the pit lane at t (between a pit stop's entry and exit). */
  pit: boolean;
  /**
   * API gap: on the stretch useTrack().pitLane covers, a stop's trace from PIT_LANE_MARGIN_MS before its
   * entry to as long after its exit: the pit window widened by that much (so, 2 s ahead of the entry).
   */
  pitLane: boolean;
}

/** useTrack().pitLane runs from this long before a stop's pit entry to this long after its exit (scripts/lib/normalize.ts). */
const PIT_LANE_MARGIN_MS = 2_000;

export function carAt(d: DriverData, t: number): CarPosition | null {
  const opacity = mapOpacity(d, t);
  if (opacity === 0) return null;
  const p = carPositionAt(d, t);
  if (!p) return null;
  let pit = false;
  let pitLane = false;
  for (const s of d.pits) {
    if (s.entry <= t && t <= s.exit) pit = true;
    if (s.entry - PIT_LANE_MARGIN_MS <= t && t <= s.exit + PIT_LANE_MARGIN_MS) pitLane = true;
  }
  return { x: p.x, y: p.y, opacity, pit, pitLane };
}

// ---------------------------------------------------------------- selection

/**
 * The driver a driver widget shows: pinned by its settings, else the focused driver, else the
 * best-placed selected one, else the leader (the driver panel's rule). `order` is the running order.
 */
export function selectedDriverOf(
  order: readonly number[],
  selected: readonly number[],
  focused: number | null,
  pinned: number | null,
): number | null {
  if (pinned != null && order.includes(pinned)) return pinned;
  if (focused != null && order.includes(focused)) return focused;
  return order.find((n) => selected.includes(n)) ?? order[0] ?? null;
}

// ---------------------------------------------------------------- the whole session (opt-out)

/** Everything, past and future. Only for widgets that need it (the timeline's bands and markers). */
export interface WholeSession {
  meta: SessionMeta;
  /** lapStartTimes[n] = when the leader started lap n (index 0 unused). */
  lapStartTimes: readonly number[];
  /** Every feed item, oldest first. */
  feed: readonly FeedItem[];
}

export const wholeSessionOf = cached(
  (session: Session): WholeSession => ({ meta: session.meta, lapStartTimes: session.lapStartTimes, feed: session.feed }),
);
