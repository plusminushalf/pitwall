// In-memory session: processed JSON decoded into typed arrays and per-driver indexes,
// so the replay engine can answer "state at time t" with binary searches.

import type {
  DriverInfo,
  DriverTelemetry,
  IntervalEvent,
  Lap,
  Ms,
  PitStop,
  PositionEvent,
  Result,
  SessionMeta,
  Stint,
} from "../types";
import { yellowCulprits } from "../engine/yellowCause";
import { carPathOf } from "../engine/carPath";
import type { StreamChunk } from "../ingest/protocol";

export interface LocSeries {
  t: Float64Array;
  x: Float32Array;
  y: Float32Array;
}

export interface CarSeries {
  t: Float64Array;
  speed: Float32Array;
  rpm: Float32Array;
  gear: Uint8Array;
  throttle: Float32Array;
  brake: Float32Array;
  drs: Uint8Array | null;
}

export interface DriverData {
  info: DriverInfo;
  loc: LocSeries;
  car: CarSeries;
  laps: Lap[]; // sorted by lap number
  lapStarts: Float64Array;
  stints: Stint[];
  pits: PitStop[];
  positions: PositionEvent[];
  positionTimes: Float64Array;
  intervals: IntervalEvent[];
  intervalTimes: Float64Array;
  result: Result | null;
  gridPosition: number | null;
}

export type FeedKind = "flag" | "safety-car" | "stewards" | "control" | "overtake" | "radio" | "pit" | "retired";

export interface FeedItem {
  t: Ms;
  kind: FeedKind;
  text: string;
  driver: number | null;
  flag?: string | null;
  url?: string;
  /** Sector yellows (race control names nobody): the cars inferred from telemetry to have caused it, when clear. */
  inferred?: number[];
  /** Overtakes: the car passed (`driver` is the one passing). */
  passed?: number;
}

/** One driver's decoded location + car streams. */
export interface DriverSeries {
  loc: LocSeries;
  car: CarSeries;
}

export interface Session {
  meta: SessionMeta;
  drivers: Map<number, DriverData>;
  /**
   * Decoded telemetry of every driver it was given for, including any not (yet) in `meta.drivers`:
   * live sessions keep it across meta updates (`withMeta`) and grow it (`appendTelemetry`).
   */
  series: Map<number, DriverSeries>;
  driverNumbers: number[];
  /** lapStartTimes[n] = when the race leader started lap n (index 0 unused). */
  lapStartTimes: number[];
  trackStatusTimes: Float64Array;
  raceControlTimes: Float64Array;
  weatherTimes: Float64Array;
  feed: FeedItem[];
  feedTimes: Float64Array;
}

const timesOf = (items: { t: Ms }[]) => Float64Array.from(items, (e) => e.t);

function decodeTimes(deltas: number[]): Float64Array {
  const out = new Float64Array(deltas.length);
  let t = 0;
  for (let i = 0; i < deltas.length; i++) out[i] = t += deltas[i];
  return out;
}

function decodeSeries(tel: DriverTelemetry): DriverSeries {
  return {
    loc: { t: decodeTimes(tel.loc.t), x: Float32Array.from(tel.loc.x), y: Float32Array.from(tel.loc.y) },
    car: {
      t: decodeTimes(tel.car.t),
      speed: Float32Array.from(tel.car.speed),
      rpm: Float32Array.from(tel.car.rpm),
      gear: Uint8Array.from(tel.car.gear),
      throttle: Float32Array.from(tel.car.throttle),
      brake: Float32Array.from(tel.car.brake),
      drs: tel.car.drs ? Uint8Array.from(tel.car.drs) : null,
    },
  };
}

/** Items grouped by driver, keeping their order. */
function byDriver<T extends { driver: number }>(items: T[]): Map<number, T[]> {
  const out = new Map<number, T[]>();
  for (const item of items) {
    const list = out.get(item.driver);
    if (list) list.push(item);
    else out.set(item.driver, [item]);
  }
  return out;
}

function buildFeed(meta: SessionMeta, acronym: (n: number | null) => string, culprits: Map<number, number[]>): FeedItem[] {
  const feed: FeedItem[] = [];
  meta.raceControl.forEach((m, i) => {
    // Per-sector "CLEAR" messages are noise in a feed; the map shows sector flags instead.
    if (m.category === "Flag" && m.flag === "CLEAR" && m.scope === "Sector") return;
    // After the replay window only stewards' decisions matter (not cool-down lap flags).
    if (m.t > meta.duration && !m.message.startsWith("FIA STEWARDS")) return;
    const kind: FeedKind =
      m.category === "SafetyCar"
        ? "safety-car"
        : m.message.startsWith("FIA STEWARDS")
          ? "stewards"
          : m.category === "Flag"
            ? "flag"
            : "control";
    const inferred = culprits.get(i);
    feed.push({ t: m.t, kind, text: m.message, driver: m.driver, flag: m.flag, ...(inferred && { inferred }) });
  });
  for (const o of meta.overtakes) {
    feed.push({
      t: o.t,
      kind: "overtake",
      driver: o.overtaker,
      passed: o.overtaken,
      text: `${acronym(o.overtaker)} passes ${acronym(o.overtaken)} for P${o.position}`,
    });
  }
  for (const r of meta.radio) {
    feed.push({ t: r.t, kind: "radio", driver: r.driver, text: `${acronym(r.driver)} team radio`, url: r.url });
  }
  for (const p of meta.pits) {
    const lane = p.laneDuration != null ? ` (${p.laneDuration.toFixed(1)}s in pit lane)` : "";
    feed.push({ t: p.entry, kind: "pit", driver: p.driver, text: `${acronym(p.driver)} pits at the end of lap ${p.lap}${lane}` });
  }
  for (const r of meta.results) {
    if (r.retired == null) continue;
    feed.push({ t: r.retired, kind: "retired", driver: r.driver, text: `${acronym(r.driver)} retires${r.dns ? " (did not start)" : ""}` });
  }
  return feed.sort((a, b) => a.t - b.t);
}

/** `live`: a live session's snapshot, to be grown by appendTelemetry (cars' paths then never look ahead). */
export function buildSession(meta: SessionMeta, telemetry: DriverTelemetry[], opts: { live?: boolean } = {}): Session {
  return assemble(meta, new Map(telemetry.map((t) => [t.driver, decodeSeries(t)])), opts.live ?? false);
}

function assemble(meta: SessionMeta, series: Map<number, DriverSeries>, live: boolean): Session {
  const drivers = new Map<number, DriverData>();
  const lapsOf = byDriver(meta.laps);
  const stintsOf = byDriver(meta.stints);
  const pitsOf = byDriver(meta.pits);
  const positionsOf = byDriver(meta.positions);
  const intervalsOf = byDriver(meta.intervals);
  const resultOf = new Map<number, Result>();
  for (const r of meta.results) if (!resultOf.has(r.driver)) resultOf.set(r.driver, r);
  const gridOf = new Map<number, number>();
  for (const g of meta.grid) if (!gridOf.has(g.driver)) gridOf.set(g.driver, g.position);

  for (const info of meta.drivers) {
    const s = series.get(info.number);
    if (!s) continue;
    const n = info.number;
    const laps = (lapsOf.get(n) ?? []).sort((a, b) => a.lap - b.lap);
    const positions = positionsOf.get(n) ?? [];
    const intervals = intervalsOf.get(n) ?? [];
    const d: DriverData = {
      info,
      loc: s.loc,
      car: s.car,
      laps,
      lapStarts: Float64Array.from(laps, (l) => l.start),
      stints: (stintsOf.get(n) ?? []).sort((a, b) => a.stint - b.stint),
      pits: pitsOf.get(n) ?? [],
      positions,
      positionTimes: timesOf(positions),
      intervals,
      intervalTimes: timesOf(intervals),
      result: resultOf.get(n) ?? null,
      gridPosition: gridOf.get(n) ?? null,
    };
    drivers.set(n, d);
    // The car's path on the map, computed here (behind the loading screen) rather than on the first frame.
    carPathOf(d, live);
  }

  const lapStartTimes: number[] = [];
  for (const l of meta.laps) {
    if (lapStartTimes[l.lap] === undefined || l.start < lapStartTimes[l.lap]) lapStartTimes[l.lap] = l.start;
  }

  const acronym = (n: number | null) => (n != null ? (drivers.get(n)?.info.acronym ?? `#${n}`) : "");
  const feed = buildFeed(meta, acronym, yellowCulprits(meta, drivers));

  return {
    meta,
    drivers,
    series,
    driverNumbers: [...drivers.keys()],
    lapStartTimes,
    trackStatusTimes: timesOf(meta.trackStatus),
    raceControlTimes: timesOf(meta.raceControl),
    weatherTimes: timesOf(meta.weather),
    feed,
    feedTimes: timesOf(feed),
  };
}

// ---------------------------------------------------------------- live sessions

/**
 * The session rebuilt around a new meta (a live `meta` update, or a streamed race's), reusing the telemetry already
 * decoded. An unchanged track keeps its object identity, so views keyed on it (the track map) don't redraw. `live`:
 * the filter for cars' paths built now (a streamed race is a replay).
 */
export function withMeta(session: Session, meta: SessionMeta, live = true): Session {
  const same = meta.track === session.meta.track || JSON.stringify(meta.track) === JSON.stringify(session.meta.track);
  return assemble(same ? { ...meta, track: session.meta.track } : meta, new Map(session.series), live);
}

type Column = Float64Array | Float32Array | Uint8Array;

/**
 * `arr` followed by `values`. The result is a view over a buffer with spare room (doubling when full),
 * so the next append usually just writes into it: appends are amortised O(new samples), not O(total).
 * Views handed out earlier keep their length, so readers of an older view never see a partial append.
 */
function appendColumn<T extends Column>(arr: T, values: ArrayLike<number>, from = 0): T {
  const k = values.length - from;
  if (k <= 0) return arr;
  const Ctor = arr.constructor as { new (buffer: ArrayBufferLike, byteOffset: number, length: number): T; BYTES_PER_ELEMENT: number };
  const n = arr.length;
  const capacity = arr.byteOffset === 0 ? arr.buffer.byteLength / Ctor.BYTES_PER_ELEMENT : n;
  let out: T;
  if (n + k <= capacity) {
    out = new Ctor(arr.buffer, 0, n + k);
  } else {
    out = new Ctor(new ArrayBuffer(Math.max(256, 2 * (n + k)) * Ctor.BYTES_PER_ELEMENT), 0, n + k);
    out.set(arr);
  }
  for (let i = 0; i < k; i++) out[n + i] = values[from + i];
  return out;
}

/** Index of the first sample after `last` (chunks never rewrite history: anything older is a duplicate). */
function firstNew(times: Float64Array, last: number): number {
  let i = 0;
  while (i < times.length && times[i] <= last) i++;
  return i;
}

function appendSeries(s: DriverSeries | undefined, chunk: DriverTelemetry): DriverSeries {
  if (!s) return decodeSeries(chunk);
  const lt = decodeTimes(chunk.loc.t);
  const ct = decodeTimes(chunk.car.t);
  const li = firstNew(lt, s.loc.t.length ? s.loc.t[s.loc.t.length - 1] : -Infinity);
  const ci = firstNew(ct, s.car.t.length ? s.car.t[s.car.t.length - 1] : -Infinity);
  const { car } = chunk;
  return {
    loc: {
      t: appendColumn(s.loc.t, lt, li),
      x: appendColumn(s.loc.x, chunk.loc.x, li),
      y: appendColumn(s.loc.y, chunk.loc.y, li),
    },
    car: {
      t: appendColumn(s.car.t, ct, ci),
      speed: appendColumn(s.car.speed, car.speed, ci),
      rpm: appendColumn(s.car.rpm, car.rpm, ci),
      gear: appendColumn(s.car.gear, car.gear, ci),
      throttle: appendColumn(s.car.throttle, car.throttle, ci),
      brake: appendColumn(s.car.brake, car.brake, ci),
      drs: s.car.drs ? appendColumn(s.car.drs, car.drs ?? new Array<number>(ct.length).fill(0), ci) : null,
    },
  };
}

/**
 * Appends a live `tel` update (new samples per driver, `t[0]` absolute) to the session's telemetry.
 * Drivers already in the session are updated in place and the same session is returned; if a chunk
 * brings the first samples of a driver listed in the meta, a new session including them is returned.
 */
export function appendTelemetry(session: Session, chunks: DriverTelemetry[]): Session {
  let added = false;
  for (const chunk of chunks) {
    const s = appendSeries(session.series.get(chunk.driver), chunk);
    session.series.set(chunk.driver, s);
    const d = session.drivers.get(chunk.driver);
    if (d) {
      d.loc = s.loc;
      d.car = s.car;
      carPathOf(d, true); // extends the path with the new samples
    } else if (session.meta.drivers.some((info) => info.number === chunk.driver)) {
      added = true;
    }
  }
  return added ? assemble(session.meta, new Map(session.series), true) : session;
}

// ---------------------------------------------------------------- races streamed while they download

/** A race being watched while it downloads (src/ingest/stream.ts): its first update. */
export function streamSession(meta: SessionMeta, chunks: StreamChunk[]): Session {
  const series = new Map<number, DriverSeries>();
  for (const c of chunks) series.set(c.driver, mergeSeries(series.get(c.driver), c));
  return assemble(meta, series, false);
}

/** Index of the first time >= t. */
function lowerBound(times: Float64Array, t: number): number {
  let lo = 0;
  let hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** a[0, i) + b + a[j, end), in a new column. */
function spliceColumn<T extends Column>(a: T, i: number, j: number, b: ArrayLike<number>): T {
  const Ctor = a.constructor as { new (n: number): T };
  const out = new Ctor(i + b.length + (a.length - j));
  out.set(a.subarray(0, i));
  out.set(b as never, i);
  out.set(a.subarray(j), i + b.length);
  return out;
}

/**
 * A driver's series with a chunk's span replaced by the chunk: appended when it comes after everything there
 * (amortised, and the car's path is extended), else spliced into new columns (the path is rebuilt).
 */
function mergeSeries(s: DriverSeries | undefined, c: StreamChunk): DriverSeries {
  const { loc, car } = c;
  if (!s) return { loc: { t: loc.t, x: loc.x, y: loc.y }, car: { ...car } };
  const lt = s.loc.t;
  const ct = s.car.t;
  const zeros = (n: number) => new Uint8Array(n);
  const drs = s.car.drs || car.drs ? { old: s.car.drs ?? zeros(ct.length), add: car.drs ?? zeros(car.t.length) } : null;
  if ((!lt.length || lt[lt.length - 1] < c.from) && (!ct.length || ct[ct.length - 1] < c.from)) {
    return {
      loc: { t: appendColumn(lt, loc.t), x: appendColumn(s.loc.x, loc.x), y: appendColumn(s.loc.y, loc.y) },
      car: {
        t: appendColumn(ct, car.t),
        speed: appendColumn(s.car.speed, car.speed),
        rpm: appendColumn(s.car.rpm, car.rpm),
        gear: appendColumn(s.car.gear, car.gear),
        throttle: appendColumn(s.car.throttle, car.throttle),
        brake: appendColumn(s.car.brake, car.brake),
        drs: drs ? appendColumn(drs.old, drs.add) : null,
      },
    };
  }
  const li = lowerBound(lt, c.from);
  const lj = lowerBound(lt, c.to);
  const ci = lowerBound(ct, c.from);
  const cj = lowerBound(ct, c.to);
  return {
    loc: { t: spliceColumn(lt, li, lj, loc.t), x: spliceColumn(s.loc.x, li, lj, loc.x), y: spliceColumn(s.loc.y, li, lj, loc.y) },
    car: {
      t: spliceColumn(ct, ci, cj, car.t),
      speed: spliceColumn(s.car.speed, ci, cj, car.speed),
      rpm: spliceColumn(s.car.rpm, ci, cj, car.rpm),
      gear: spliceColumn(s.car.gear, ci, cj, car.gear),
      throttle: spliceColumn(s.car.throttle, ci, cj, car.throttle),
      brake: spliceColumn(s.car.brake, ci, cj, car.brake),
      drs: drs ? spliceColumn(drs.old, ci, cj, drs.add) : null,
    },
  };
}

/**
 * A streamed race's telemetry update merged in: each chunk replaces its driver's samples in its span. Drivers
 * already in the session are updated in place (their paths extended or rebuilt) and the same session is returned;
 * if a chunk brings the first samples of a driver in the meta, a new session including them.
 */
export function mergeTelemetry(session: Session, chunks: StreamChunk[]): Session {
  let added = false;
  for (const c of chunks) {
    const s = mergeSeries(session.series.get(c.driver), c);
    session.series.set(c.driver, s);
    const d = session.drivers.get(c.driver);
    if (d) {
      d.loc = s.loc;
      d.car = s.car;
      carPathOf(d);
    } else if (session.meta.drivers.some((info) => info.number === c.driver)) {
      added = true;
    }
  }
  return added ? assemble(session.meta, new Map(session.series), false) : session;
}
