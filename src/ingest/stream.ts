// A race watched while it downloads, in the ingest worker: the raw files the ingest core reads or downloads
// (its events), normalized into a provisional replay as they come in (normalize's `partial` option: everything
// but telemetry is in, telemetry only for some spans) and handed to the page bit by bit: the meta whenever it
// changes, and each span's telemetry once, when it's complete (both car data and locations). The page grows its
// replay from these (src/data/session.ts mergeTelemetry); when the download is done it swaps in the stored
// session, which is what this converges to.
//
// Nothing is computed until someone watches (watch()): a download nobody is watching only collects references.

import {
  DriverSamples,
  firstAtOrAfter,
  normalize,
  type CleanTelemetry,
  type NormalizeResult,
  type RawSessionData,
} from "../../scripts/lib/normalize";
import type { IngestEvent, ReplayWindow } from "../../scripts/lib/ingestCore";
import type { RawCarData, RawLocation } from "../../scripts/lib/openf1Types";
import { parseSliceFile, SLICE_UNIT_MS, SlicePlan, type SlicePart, type Span } from "../../scripts/lib/slices";
import type { SessionMeta } from "../types";
import type { StreamChunk, StreamUpdate } from "./protocol";

/** Session files the replay can't start without (the rest only add to it as they come). */
const NEEDED = ["sessions", "meeting", "drivers", "laps", "race_control", "position", "intervals", "stints"] as const;
const OPTIONAL = ["circuit", "pit", "session_result", "weather", "team_radio", "overtakes"] as const;
type DocName = (typeof NEEDED)[number] | (typeof OPTIONAL)[number];
const DOCS = new Set<string>([...NEEDED, ...OPTIONAL]);

type Rec = { date: string; driver_number: number };

export class StreamBuilder {
  private docs = new Map<DocName, unknown>();
  private window: ReplayWindow | null = null;
  private plan: SlicePlan | null = null;
  /** Telemetry parts in memory, in the order they came. */
  private parts: { part: SlicePart; records: Rec[] }[] = [];
  /** Cleaned samples per driver (normalize's input), built once someone watches; parts fed in so far. */
  private samples: Map<number, DriverSamples> | null = null;
  private fed = 0;
  /** Grid units of the plan whose telemetry has been sent. */
  private sent: Uint8Array = new Uint8Array(0);
  private lastMetaJson: string | null = null;
  private pinned: { driver: number; lap: number } | null = null;
  private dirty = false;
  latest: NormalizeResult | null = null;
  watching = false;

  constructor(readonly sessionKey: number) {}

  /** An ingest core event; true when it may change the replay (worth an update()). */
  onEvent(e: IngestEvent): boolean {
    if (e.kind === "plan") {
      this.window = e.window;
      this.plan = new SlicePlan(e.span, []);
      this.sent = new Uint8Array(this.plan.units);
      return false;
    }
    if (e.kind !== "raw") return false;
    if (DOCS.has(e.name)) {
      this.docs.set(e.name as DocName, e.data);
      return this.mark();
    }
    const part = parseSliceFile(e.name);
    if (!part || !this.plan) return false;
    this.parts.push({ part, records: e.data as Rec[] });
    this.plan.stored(part);
    return this.mark();
  }

  private mark(): boolean {
    this.dirty = true;
    return this.watching;
  }

  /** Someone watches (again): the next update() sends everything so far. */
  watch(): void {
    if (!this.watching) {
      this.watching = true;
      this.sent.fill(0);
      this.lastMetaJson = null;
      this.dirty = true;
    }
  }

  unwatch(): void {
    this.watching = false;
  }

  /**
   * The replay can start: the session files it needs, and telemetry somewhere. Races only: qualifying's lap
   * comparison needs every lap, so it opens once it's downloaded.
   */
  ready(): boolean {
    if (this.doc<{ session_type: string }>("sessions")[0]?.session_type !== "Race") return false;
    return this.window != null && NEEDED.every((n) => this.docs.has(n)) && (this.plan?.complete().length ?? 0) > 0;
  }

  private doc<T>(name: DocName): T[] {
    return (this.docs.get(name) as T[] | undefined) ?? [];
  }

  /** Feed the parts not in the samples yet; rebuild them if one comes before what's there (a backfill, a jump). */
  private feed(t0: number): Map<number, DriverSamples> {
    const drivers = [...new Set(this.doc<{ driver_number: number }>("drivers").map((d) => d.driver_number))];
    const fresh = this.parts.slice(this.fed);
    const latest = this.parts.slice(0, this.fed).reduce((m, p) => Math.max(m, p.part.span.from), -Infinity);
    if (!this.samples || fresh.some((p) => p.part.span.from < latest)) {
      // Appending in time order is cheap; inserting before is not (DriverSamples splices sample by sample).
      this.samples = new Map(drivers.map((n) => [n, new DriverSamples(n, t0)]));
      this.fed = 0;
    }
    const samples = this.samples;
    for (const n of drivers) if (!samples.has(n)) samples.set(n, new DriverSamples(n, t0));
    const todo = this.parts.slice(this.fed).sort((a, b) => a.part.span.from - b.part.span.from);
    for (const { part, records } of todo) {
      for (const r of records) {
        const s = samples.get(r.driver_number);
        if (!s) continue;
        if (part.endpoint === "car_data") s.addCar(r as unknown as RawCarData);
        else s.addLocation(r as unknown as RawLocation);
      }
    }
    // Later parts must come after these to be appended; anything earlier rebuilds.
    this.parts = [...this.parts.slice(0, this.fed), ...todo];
    this.fed = this.parts.length;
    return samples;
  }

  /**
   * Recompute the replay with what's in, and what the page hasn't had: the meta if it changed (always in the first
   * update) and the telemetry of spans completed since. Null when there's nothing new, or it can't start yet.
   */
  update(): StreamUpdate | null {
    if (!this.watching || !this.dirty || !this.ready()) return null;
    this.dirty = false;
    const window = this.window!;
    const plan = this.plan!;
    const complete = plan.complete();
    const raw: RawSessionData = {
      session: this.doc<RawSessionData["session"]>("sessions")[0]!,
      meeting: this.doc<RawSessionData["meeting"]>("meeting")[0] ?? null,
      circuit: (this.docs.get("circuit") as RawSessionData["circuit"] | undefined) ?? null,
      drivers: this.doc("drivers"),
      laps: this.doc("laps"),
      stints: this.doc("stints"),
      pits: this.doc("pit"),
      positions: this.doc("position"),
      intervals: this.doc("intervals"),
      raceControl: this.doc("race_control"),
      weather: this.doc("weather"),
      radio: this.doc("team_radio"),
      overtakes: this.doc("overtakes"),
      results: this.doc("session_result"),
      samples: this.feed(window.t0),
    };
    let result: NormalizeResult;
    try {
      result = normalize(raw, { partial: { telemetry: complete, referenceLap: this.pinned } });
    } catch (e) {
      console.warn(`[stream ${this.sessionKey}] normalize failed: ${(e as Error).stack ?? e}`);
      return null;
    }
    this.latest = result;
    const ref = result.report.refLap;
    if (ref && !this.pinned) this.pinned = { driver: ref.driver, lap: ref.lap };

    const json = JSON.stringify(result.meta);
    const meta: SessionMeta | null = json === this.lastMetaJson ? null : result.meta;
    this.lastMetaJson = json;

    // Telemetry of the units completed since the last update, in runs.
    const fresh: Span[] = [];
    for (const span of complete) {
      for (let t = span.from; t < span.to; t += SLICE_UNIT_MS) {
        const u = Math.round((t - plan.span.from) / SLICE_UNIT_MS);
        if (this.sent[u]) continue;
        this.sent[u] = 1;
        const last = fresh.at(-1);
        if (last && last.to === t) last.to = t + SLICE_UNIT_MS;
        else fresh.push({ from: t, to: t + SLICE_UNIT_MS });
      }
    }
    const t0 = window.t0;
    const chunks: StreamChunk[] = [];
    for (const { from, to } of fresh) {
      for (const tel of result.telemetry.values()) chunks.push(chunkOf(tel, from - t0, to - t0));
    }
    if (!meta && !chunks.length) return null;
    return { type: "stream", key: this.sessionKey, meta, chunks, spans: complete.map((s) => [s.from - t0, s.to - t0]) };
  }
}

/** One driver's samples in [from, to) (ms since t0), as the replay's typed arrays. */
export function chunkOf(tel: CleanTelemetry, from: number, to: number): StreamChunk {
  const { loc, car } = tel;
  const l0 = firstAtOrAfter(loc.t, from);
  const l1 = firstAtOrAfter(loc.t, to);
  const c0 = firstAtOrAfter(car.t, from);
  const c1 = firstAtOrAfter(car.t, to);
  return {
    driver: tel.driver,
    from,
    to,
    loc: { t: Float64Array.from(loc.t.slice(l0, l1)), x: Float32Array.from(loc.x.slice(l0, l1)), y: Float32Array.from(loc.y.slice(l0, l1)) },
    car: {
      t: Float64Array.from(car.t.slice(c0, c1)),
      speed: Float32Array.from(car.speed.slice(c0, c1)),
      rpm: Float32Array.from(car.rpm.slice(c0, c1)),
      gear: Uint8Array.from(car.gear.slice(c0, c1)),
      throttle: Float32Array.from(car.throttle.slice(c0, c1)),
      brake: Float32Array.from(car.brake.slice(c0, c1)),
      drs: car.drs ? Uint8Array.from(car.drs.slice(c0, c1)) : null,
    },
  };
}

/** The buffers of an update's chunks, to transfer rather than copy. */
export function transferables(u: StreamUpdate): ArrayBuffer[] {
  return u.chunks.flatMap((c) =>
    [c.loc.t, c.loc.x, c.loc.y, c.car.t, c.car.speed, c.car.rpm, c.car.gear, c.car.throttle, c.car.brake, c.car.drs]
      .filter((a): a is NonNullable<typeof a> => a != null)
      .map((a) => a.buffer as ArrayBuffer),
  );
}
