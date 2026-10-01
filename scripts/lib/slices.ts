// Race telemetry in time slices: car_data and location for every car over [from, to), one OpenF1 request (and one
// raw file) each, instead of one request per car for the whole session. Slices come in the order they're watched
// (from the playhead on), so a replay can start as soon as the first one is in and fill in while it plays. They
// only cover the replay window (with a margin): a car's whole-session file also holds everything OpenF1 recorded
// for it before the session (a third of the data for 2026 Baku).
//
// Slices start and end on a fixed grid (UTC), so a resumed download finds what it stored by name. Pure: no I/O.

export type SliceEndpoint = "location" | "car_data";
/** Fetched in this order for each slice: the map needs location first. */
export const SLICE_ENDPOINTS: readonly SliceEndpoint[] = ["location", "car_data"];

/** The grid slices start and end on. */
export const SLICE_UNIT_MS = 5 * 60_000;
/**
 * At most this long per request: ~1.8 MB gzipped for 22 cars, 6-9 s for OpenF1 to answer. Long enough that a race
 * (13 session files, then telemetry) fits in the free tier's minute of requests; short enough to come in well
 * ahead of the replay.
 */
export const SLICE_MAX_UNITS = 6;
/** The first slice at the playhead is short (~1 s to answer): it's what the replay waits for. */
export const FIRST_SLICE_UNITS = 1;
/** ...and the one after it too, while the replay starts. */
export const SECOND_SLICE_UNITS = 2;
/** A short first slice covers at least this much after the playhead (else it takes the next unit too). */
const FIRST_SLICE_AHEAD_MS = 2 * 60_000;
/** Downloaded either side of the replay window: room for a later version to widen it without the network. */
export const SLICE_MARGIN_MS = 5 * 60_000;

/** A time range in absolute ms, [from, to). */
export interface Span {
  from: number;
  to: number;
}

/** One raw file: an endpoint's records for every car over a span. */
export interface SlicePart {
  endpoint: SliceEndpoint;
  span: Span;
}

/** `location_1790420400_1790421600`: the endpoint and the span in Unix seconds. */
export const sliceFile = ({ endpoint, span }: SlicePart) => `${endpoint}_${span.from / 1000}_${span.to / 1000}`;

const SLICE_FILE = /^(location|car_data)_(\d{9,11})_(\d{9,11})$/;

/** The part a raw file name holds, or null if it isn't a slice (e.g. `car_data_44`, one car's whole session). */
export function parseSliceFile(name: string): SlicePart | null {
  const m = SLICE_FILE.exec(name);
  if (!m) return null;
  const from = Number(m[2]) * 1000;
  const to = Number(m[3]) * 1000;
  return to > from ? { endpoint: m[1] as SliceEndpoint, span: { from, to } } : null;
}

/** A car's whole-session file (`car_data_44`, `location_1`): the layout before slices, still used for qualifying. */
export const isPerDriverFile = (name: string) => /^(car_data|location)_\d{1,3}$/.test(name);

/** OpenF1 query for one part. */
export function sliceParams(sessionKey: number, span: Span): Record<string, string | number> {
  return { session_key: sessionKey, "date>=": new Date(span.from).toISOString(), "date<": new Date(span.to).toISOString() };
}

/** The span telemetry is downloaded for: the replay window and a margin, out to the grid. */
export function telemetrySpan(window: { t0: number; end: number }): Span {
  return {
    from: Math.floor((window.t0 - SLICE_MARGIN_MS) / SLICE_UNIT_MS) * SLICE_UNIT_MS,
    to: Math.ceil((window.end + SLICE_MARGIN_MS) / SLICE_UNIT_MS) * SLICE_UNIT_MS,
  };
}

const MISSING = 0;
const TAKEN = 1; // being downloaded
const STORED = 2;

/**
 * What of a session's telemetry span is stored or on its way, per endpoint and grid unit, and what to fetch next:
 * the first missing stretch at or after the playhead, else the last one before it (filling in backwards).
 */
export class SlicePlan {
  readonly units: number;
  private state: Record<SliceEndpoint, Uint8Array>;
  /** Units on their way in a long slice (slow to answer), and units asked for again on their own (urgent). */
  private long: Record<SliceEndpoint, Uint8Array>;
  private asked: Record<SliceEndpoint, Uint8Array>;

  /** `stored`: parts already in the raw cache (only their units inside the span count). */
  constructor(
    readonly span: Span,
    stored: readonly SlicePart[] = [],
  ) {
    this.units = Math.max(0, Math.round((span.to - span.from) / SLICE_UNIT_MS));
    this.state = { location: new Uint8Array(this.units), car_data: new Uint8Array(this.units) };
    this.long = { location: new Uint8Array(this.units), car_data: new Uint8Array(this.units) };
    this.asked = { location: new Uint8Array(this.units), car_data: new Uint8Array(this.units) };
    for (const p of stored) this.stored(p);
  }

  private unitOf(t: number): number {
    return Math.floor((t - this.span.from) / SLICE_UNIT_MS);
  }

  /** A part is stored (the units it covers whole). */
  stored({ endpoint, span }: SlicePart): void {
    const a = this.state[endpoint];
    const from = Math.max(0, Math.ceil((span.from - this.span.from) / SLICE_UNIT_MS));
    const to = Math.min(this.units, Math.floor((span.to - this.span.from) / SLICE_UNIT_MS));
    for (let u = from; u < to; u++) a[u] = STORED;
  }

  /** A part's download failed: it's missing again. */
  release(part: SlicePart): void {
    const a = this.state[part.endpoint];
    const from = Math.max(0, this.unitOf(part.span.from));
    const to = Math.min(this.units, this.unitOf(part.span.to));
    for (let u = from; u < to; u++) if (a[u] === TAKEN) a[u] = MISSING;
  }

  private open(u: number): boolean {
    return SLICE_ENDPOINTS.some((e) => this.state[e][u] === MISSING);
  }

  /** Whether a replay waiting at `playhead` should have its own slice now (urgent()). */
  waiting(playhead: number): boolean {
    return this.urgentUnits(playhead).some(([e, u]) => this.needsNow(e, u));
  }

  private needsNow(e: SliceEndpoint, u: number): boolean {
    const v = this.state[e][u];
    return v === MISSING || (v === TAKEN && this.long[e][u] === 1 && this.asked[e][u] === 0);
  }

  /** The playhead's unit, and the next one when the playhead is near its end. */
  private urgentUnits(playhead: number): [SliceEndpoint, number][] {
    const at = this.unitOf(playhead);
    if (at < 0 || at >= this.units) return [];
    const ahead = this.span.from + (at + 1) * SLICE_UNIT_MS - playhead;
    const units = ahead < FIRST_SLICE_AHEAD_MS && at + 1 < this.units ? [at, at + 1] : [at];
    return SLICE_ENDPOINTS.flatMap((e) => units.map((u): [SliceEndpoint, number] => [e, u]));
  }

  /**
   * What a replay waiting at `playhead` needs right away: its unit (and the next one near the end of it), for each
   * endpoint, if it's missing, or on its way in a long slice (several seconds to answer): then it's asked for again
   * on its own (a second or so). Stored slices may overlap: samples are the same, and normalize keeps one of each.
   * Each unit is asked for this way once; missing ones are taken.
   */
  urgent(playhead: number): SlicePart[] {
    const parts: SlicePart[] = [];
    for (const [endpoint, u] of this.urgentUnits(playhead)) {
      if (!this.needsNow(endpoint, u)) continue;
      this.asked[endpoint][u] = 1;
      if (this.state[endpoint][u] === MISSING) this.state[endpoint][u] = TAKEN;
      const from = this.span.from + u * SLICE_UNIT_MS;
      const last = parts.at(-1);
      if (last && last.endpoint === endpoint && last.span.to === from) last.span.to = from + SLICE_UNIT_MS;
      else parts.push({ endpoint, span: { from, to: from + SLICE_UNIT_MS } });
    }
    return parts;
  }

  /**
   * The parts to fetch next for playback at `playhead` (absolute ms): one slice of up to `maxUnits` units, starting at
   * the first unit at or after the playhead that's missing for either endpoint (else ending at the last one before
   * it), each endpoint's missing runs within it. A replay waiting at the playhead (its own unit missing) gets a short
   * slice first, the quickest to answer. They're taken (in flight) until stored() or release(). Empty when nothing is
   * missing.
   */
  next(playhead: number, maxUnits = SLICE_MAX_UNITS): SlicePart[] {
    const n = this.units;
    if (n === 0) return [];
    const at = Math.min(Math.max(this.unitOf(playhead), 0), n - 1);
    if (this.open(at)) {
      const ahead = this.span.from + (at + 1) * SLICE_UNIT_MS - playhead;
      maxUnits = Math.min(maxUnits, FIRST_SLICE_UNITS + (ahead < FIRST_SLICE_AHEAD_MS ? 1 : 0));
    }
    let lo = -1;
    let hi = -1;
    for (let u = at; u < n; u++) {
      if (!this.open(u)) continue;
      lo = u;
      for (hi = u + 1; hi < n && hi - lo < maxUnits && this.open(hi); hi++);
      break;
    }
    if (lo < 0) {
      for (let u = at - 1; u >= 0; u--) {
        if (!this.open(u)) continue;
        hi = u + 1;
        for (lo = u; lo > 0 && hi - lo < maxUnits && this.open(lo - 1); lo--);
        break;
      }
    }
    if (lo < 0) return [];
    const parts: SlicePart[] = [];
    for (const endpoint of SLICE_ENDPOINTS) {
      const a = this.state[endpoint];
      for (let u = lo; u < hi; ) {
        if (a[u] !== MISSING) {
          u++;
          continue;
        }
        let v = u;
        while (v < hi && a[v] === MISSING) a[v++] = TAKEN;
        if (v - u > SECOND_SLICE_UNITS) this.long[endpoint].fill(1, u, v);
        parts.push({ endpoint, span: { from: this.span.from + u * SLICE_UNIT_MS, to: this.span.from + v * SLICE_UNIT_MS } });
        u = v;
      }
    }
    return parts;
  }

  /** Spans stored for both endpoints (complete telemetry), merged and in order. */
  complete(): Span[] {
    const out: Span[] = [];
    for (let u = 0; u < this.units; u++) {
      if (this.state.location[u] !== STORED || this.state.car_data[u] !== STORED) continue;
      const from = this.span.from + u * SLICE_UNIT_MS;
      const last = out.at(-1);
      if (last && last.to === from) last.to = from + SLICE_UNIT_MS;
      else out.push({ from, to: from + SLICE_UNIT_MS });
    }
    return out;
  }

  /** Share of the span stored (both endpoints count half). */
  progress(): number {
    if (this.units === 0) return 1;
    let stored = 0;
    for (const e of SLICE_ENDPOINTS) for (const v of this.state[e]) if (v === STORED) stored++;
    return stored / (2 * this.units);
  }

  /** Units still missing (not stored, not in flight), over both endpoints. */
  missingUnits(): number {
    let n = 0;
    for (const e of SLICE_ENDPOINTS) for (const v of this.state[e]) if (v === MISSING) n++;
    return n;
  }

  /** Everything is stored. */
  done(): boolean {
    return SLICE_ENDPOINTS.every((e) => this.state[e].every((v) => v === STORED));
  }
}
