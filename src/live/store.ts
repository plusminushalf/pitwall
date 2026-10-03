// Live session state: raw OpenF1 records merged as they arrive (REST backfill, MQTT, the vault's stream,
// simulation), normalized into the replay format on demand, and diffed into append-only telemetry chunks.
// Shared by the relay (server/) and the browser's live worker (./worker.ts): no I/O here.

import type { RawCarData, RawCircuit, RawLocation, RawMeeting, RawSession } from "../../scripts/lib/openf1Types";
import {
  DriverSamples,
  encodeTelemetry,
  firstAfter,
  LOC_GAP_MS,
  normalize,
  type CleanTelemetry,
  type NormalizeResult,
  type RawSessionData,
} from "../../scripts/lib/normalize";
import type { DriverTelemetry } from "../types";
import type { LiveSnapshot } from "./protocol";
import { TOPICS, type Topic } from "./topics";

export { TOPICS, type Topic };
export type DocTopic = Exclude<Topic, "sessions" | "car_data" | "location">;

export type Rec = Record<string, any>;

const ms = (iso: unknown) => (typeof iso === "string" ? Date.parse(iso) : NaN);

/**
 * Natural document keys. A newer version of a document (MQTT `_key`; e.g. a lap updated as its
 * sectors complete) replaces the older one; time-series samples are deduplicated. REST records
 * carry no `_key`, so both sources are keyed by content.
 */
const KEYS: Record<DocTopic, (r: Rec) => string> = {
  drivers: (r) => `${r.driver_number}`,
  laps: (r) => `${r.driver_number}:${r.lap_number}`,
  stints: (r) => `${r.driver_number}:${r.stint_number}`,
  pit: (r) => `${r.driver_number}:${ms(r.date)}`,
  position: (r) => `${r.driver_number}:${ms(r.date)}`,
  intervals: (r) => `${r.driver_number}:${ms(r.date)}`,
  race_control: (r) => `${ms(r.date)}:${r.category}:${r.message}`,
  weather: (r) => `${ms(r.date)}`,
  team_radio: (r) => `${r.driver_number}:${ms(r.date)}`,
  overtakes: (r) => `${ms(r.date)}:${r.overtaking_driver_number}:${r.overtaken_driver_number}`,
  session_result: (r) => `${r.driver_number}`,
};

// If the data stops, the live edge keeps moving with the clock, this far behind it.
const LIVE_LAG_MS = 15_000;

export interface StoreOptions {
  session: RawSession;
  meeting: RawMeeting | null;
  circuit: RawCircuit | null;
  /** Absolute ms of t = 0 for the whole session. */
  t0: number;
  /** Wall clock of the session (simulations run a shifted, possibly faster clock). */
  clock?: () => number;
  /** Keep raw car/location records so the relay can write the session to the raw cache at the end. */
  keepRaw?: boolean;
}

export class LiveStore {
  session: RawSession;
  meeting: RawMeeting | null;
  circuit: RawCircuit | null;
  readonly t0: number;
  readonly clock: () => number;
  private readonly keepRaw: boolean;
  private docs = new Map<DocTopic, Map<string, Rec>>();
  readonly samples = new Map<number, DriverSamples>();
  private rawCar = new Map<number, RawCarData[]>();
  private rawLoc = new Map<number, RawLocation[]>();
  /** Latest car/location sample time (absolute ms). */
  latestDataTime = -Infinity;
  /** When the last record was received (any topic), on the session's clock. */
  lastMessageAt: number | null = null;
  records = 0;

  constructor(opts: StoreOptions) {
    this.session = opts.session;
    this.meeting = opts.meeting;
    this.circuit = opts.circuit;
    this.t0 = opts.t0;
    this.clock = opts.clock ?? Date.now;
    this.keepRaw = opts.keepRaw ?? false;
  }

  get sessionKey(): number {
    return this.session.session_key;
  }

  /** Merge one record (REST or MQTT shape). Returns false when it belongs to another session. */
  ingest(topic: Topic, rec: Rec): boolean {
    if (rec.session_key != null && rec.session_key !== this.session.session_key) return false;
    this.lastMessageAt = this.clock();
    this.records++;
    if (topic === "sessions") {
      this.session = { ...this.session, ...rec };
      return true;
    }
    if (topic === "car_data" || topic === "location") {
      const n = rec.driver_number;
      if (typeof n !== "number") return false;
      let s = this.samples.get(n);
      if (!s) this.samples.set(n, (s = new DriverSamples(n, this.t0)));
      if (topic === "car_data") s.addCar(rec as RawCarData);
      else s.addLocation(rec as RawLocation);
      if (this.keepRaw) {
        const raw = topic === "car_data" ? this.rawCar : this.rawLoc;
        let list = raw.get(n);
        if (!list) raw.set(n, (list = []));
        list.push(rec as never);
      }
      // (A timestamp far ahead of the clock is bogus; a few seconds is just clock skew.)
      const t = ms(rec.date);
      if (t > this.latestDataTime && t <= this.clock() + 60_000) this.latestDataTime = t;
      return true;
    }
    let docs = this.docs.get(topic);
    if (!docs) this.docs.set(topic, (docs = new Map()));
    docs.set(KEYS[topic](rec), rec);
    return true;
  }

  list<T>(topic: DocTopic): T[] {
    return [...(this.docs.get(topic)?.values() ?? [])] as T[];
  }

  count(topic: Topic): number {
    if (topic === "car_data") return [...this.samples.values()].reduce((s, d) => s + d.car.t.length, 0);
    if (topic === "location") return [...this.samples.values()].reduce((s, d) => s + d.fixes.t.length, 0);
    if (topic === "sessions") return 1;
    return this.docs.get(topic)?.size ?? 0;
  }

  /** The live edge: latest data time, but never frozen more than LIVE_LAG_MS behind the clock. */
  now(): number {
    return Math.max(this.t0, this.latestDataTime, this.clock() - LIVE_LAG_MS);
  }

  rawData(): RawSessionData {
    return {
      session: this.session,
      meeting: this.meeting,
      circuit: this.circuit,
      drivers: this.list("drivers"),
      laps: this.list("laps"),
      stints: this.list("stints"),
      pits: this.list("pit"),
      positions: this.list("position"),
      intervals: this.list("intervals"),
      raceControl: this.list("race_control"),
      weather: this.list("weather"),
      radio: this.list("team_radio"),
      overtakes: this.list("overtakes"),
      results: this.list("session_result"),
      samples: this.samples,
    };
  }

  /** One car's raw car/location records as received (only with `keepRaw`), for the relay's raw cache. */
  rawTelemetry(topic: "car_data" | "location", driver: number): Rec[] {
    return (topic === "car_data" ? this.rawCar : this.rawLoc).get(driver) ?? [];
  }
}

export interface RecomputeStats {
  normalizeMs: number;
  at: number;
}

/**
 * The normalized view of a LiveStore, recomputed on demand, and the telemetry already streamed:
 * per driver, the time of the last location / car sample sent in a `tel` (or snapshot).
 */
export class LiveSession {
  latest: NormalizeResult | null = null;
  stats: RecomputeStats = { normalizeMs: 0, at: 0 };
  private pinnedLap: { driver: number; lap: number } | null = null;
  private sent = new Map<number, { loc: number; car: number }>();
  private frozen = false;

  constructor(readonly store: LiveStore) {}

  /** The session is over: keep the last result as it is (the clock would keep extending it). */
  freeze(): void {
    this.frozen = true;
  }

  /** Normalize everything received so far. Keeps the previous result if normalization fails. */
  recompute(): NormalizeResult | null {
    if (this.frozen && this.latest) return this.latest;
    const started = performance.now();
    try {
      const result = normalize(this.store.rawData(), {
        live: { t0: this.store.t0, now: this.store.now(), referenceLap: this.pinnedLap },
      });
      const ref = result.report.refLap;
      if (ref && !this.pinnedLap) this.pinnedLap = { driver: ref.driver, lap: ref.lap };
      this.latest = result;
    } catch (e) {
      console.error(`[live] normalize failed: ${(e as Error).stack ?? e}`);
    }
    this.stats = { normalizeMs: performance.now() - started, at: Date.now() };
    return this.latest;
  }

  /** New samples since the last call (or snapshot), one chunk per driver that has any. */
  telemetryChunks(): DriverTelemetry[] {
    const chunks: DriverTelemetry[] = [];
    if (!this.latest) return chunks;
    for (const tel of this.latest.telemetry.values()) {
      const mark = this.sent.get(tel.driver) ?? { loc: -1, car: -1 };
      const li = firstAfter(tel.loc.t, mark.loc);
      const ci = firstAfter(tel.car.t, mark.car);
      if (li >= tel.loc.t.length && ci >= tel.car.t.length) continue;
      chunks.push(encodeTelemetry(sliceTelemetry(tel, li, tel.loc.t.length, ci, tel.car.t.length)));
      this.sent.set(tel.driver, { loc: tel.loc.t.at(-1) ?? mark.loc, car: tel.car.t.at(-1) ?? mark.car });
    }
    return chunks;
  }

  /**
   * Between full recomputes: new real samples straight from the store's cleaned samples (cheap).
   * A car's location waits for the next recompute across a gap it will dead-reckon, and so do
   * cars that were dead-reckoned or haven't been streamed yet.
   */
  quickChunks(): DriverTelemetry[] {
    const chunks: DriverTelemetry[] = [];
    const latest = this.latest;
    if (!latest || this.frozen) return chunks;
    const duration = this.store.now() - this.store.t0;
    const reckoned = new Set(latest.report.deadReckonedNumbers);
    for (const [n, samples] of this.store.samples) {
      const mark = this.sent.get(n);
      if (!mark || !latest.telemetry.has(n)) continue;
      const { telemetry: tel } = samples.view(duration);
      const ci = firstAfter(tel.car.t, mark.car);
      const li = firstAfter(tel.loc.t, mark.loc);
      let lEnd = li;
      if (!reckoned.has(n)) {
        for (let prev = mark.loc; lEnd < tel.loc.t.length && (prev < 0 || tel.loc.t[lEnd] - prev <= LOC_GAP_MS); lEnd++) prev = tel.loc.t[lEnd];
      }
      if (ci >= tel.car.t.length && lEnd <= li) continue;
      chunks.push(encodeTelemetry(sliceTelemetry(tel, li, lEnd, ci, tel.car.t.length)));
      this.sent.set(n, { loc: lEnd > li ? tel.loc.t[lEnd - 1] : mark.loc, car: tel.car.t.at(-1) ?? mark.car });
    }
    return chunks;
  }

  /** Mark everything in the latest result as sent (a fresh snapshot for every client). */
  markAllSent(): void {
    this.sent.clear();
    for (const tel of this.latest?.telemetry.values() ?? []) {
      this.sent.set(tel.driver, { loc: tel.loc.t.at(-1) ?? -1, car: tel.car.t.at(-1) ?? -1 });
    }
  }

  /** Everything streamed so far, for a client that just connected. */
  snapshot(): LiveSnapshot | null {
    if (!this.latest) return null;
    const telemetry: DriverTelemetry[] = [];
    for (const tel of this.latest.telemetry.values()) {
      // Up to what the other clients have: the rest comes in the next `tel` for everyone. (Arrays
      // shared with the store may have grown since; a car nobody has been sent yet comes whole.)
      const mark = this.sent.get(tel.driver);
      const li = mark ? firstAfter(tel.loc.t, mark.loc) : 0;
      const ci = mark ? firstAfter(tel.car.t, mark.car) : 0;
      telemetry.push(encodeTelemetry(sliceTelemetry(tel, 0, li, 0, ci)));
    }
    return { type: "snapshot", meta: this.latest.meta, telemetry, now: this.latest.meta.duration };
  }
}

function sliceTelemetry(tel: CleanTelemetry, l0: number, l1: number, c0: number, c1: number): CleanTelemetry {
  const { loc, car } = tel;
  return {
    driver: tel.driver,
    loc: { t: loc.t.slice(l0, l1), x: loc.x.slice(l0, l1), y: loc.y.slice(l0, l1), z: loc.z.slice(l0, l1) },
    car: {
      t: car.t.slice(c0, c1),
      speed: car.speed.slice(c0, c1),
      rpm: car.rpm.slice(c0, c1),
      gear: car.gear.slice(c0, c1),
      throttle: car.throttle.slice(c0, c1),
      brake: car.brake.slice(c0, c1),
      ...(car.drs ? { drs: car.drs.slice(c0, c1) } : {}),
    },
  };
}

