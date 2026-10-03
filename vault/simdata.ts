// Dev and test only (never shipped, never imported by vault/src): a cached session's raw OpenF1 data
// (data/raw/<session_key>/, gitignored) turned into the timeline a live session would have published, for the
// vault's simulate mode. The vault dev server (simserver.ts) feeds it to the in-vault simulated broker and
// answers REST from it; e2e.ts rebuilds it to know what every tab should have received.
//
// The emission rules are server/simulate.ts's, so the payloads have the same topics and fields: time series
// at their `date`; laps at their start, after each sector, and complete; stints at their first lap's start and
// again every lap; pit stops once the car has left the pit lane; drivers (and here also the session) at the
// start; results 30 s after the last lap; telemetry from 10 min before the session start. Everything is
// shifted in time so the session happens "now" (see SimClock), and dates are written OpenF1's way
// (`2026-09-26T11:03:50.711000+00:00`). MQTT payloads carry `_id` (the event's place in the timeline, so every
// frame's broker numbers them the same) and `_key` (the document key: a newer version of a lap has the same
// one), like OpenF1's; REST rows have neither.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";

type Rec = Record<string, any>;

/** A telemetry slice's raw file: every car's records over [from, to) (Unix seconds). */
const SLICE_FILE = /^(car_data|location)_(\d{9,11})_(\d{9,11})\.json\.gz$/;

/** The topics the simulation publishes (OpenF1's MQTT v1/<topic>), in a fixed order (the feed's topic index). */
export const SIM_TOPICS = [
  "car_data",
  "drivers",
  "intervals",
  "laps",
  "location",
  "overtakes",
  "pit",
  "position",
  "race_control",
  "session_result",
  "sessions",
  "stints",
  "team_radio",
  "weather",
] as const;
export type SimTopic = (typeof SIM_TOPICS)[number];
const TOPIC_INDEX = new Map<string, number>(SIM_TOPICS.map((t, i) => [t, i]));

const T0_BEFORE_START_MS = 10 * 60_000;
const LIGHTS_OUT_AFTER_START_MS = 220_000;
const END_AFTER_FINISH_MS = 5 * 60_000;
const DATE_FIELDS = ["date", "date_start", "date_end"] as const;

const ms = (iso: unknown) => (typeof iso === "string" ? Date.parse(iso) : NaN);
/** A date the way OpenF1 writes them. */
export const openf1Date = (t: number) => new Date(t).toISOString().replace("Z", "000+00:00");

/** Document keys (server/store.ts KEYS): what makes a newer version replace an older one. */
const KEYS: Record<SimTopic, (r: Rec) => string> = {
  car_data: (r) => `${r.driver_number}:${ms(r.date)}`,
  location: (r) => `${r.driver_number}:${ms(r.date)}`,
  drivers: (r) => `${r.driver_number}`,
  sessions: (r) => `${r.session_key}`,
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
/** Topics whose documents are republished as they change (a lap gains sectors; a stint gains laps). */
export const VERSIONED: ReadonlySet<SimTopic> = new Set(["laps", "stints"]);

export type Timeline = {
  sessionKey: number;
  label: string;
  /** Original (unshifted) times, ms since the epoch. */
  lightsOut: number;
  startOrig: number;
  endOrig: number;
  /** Every event in emission order: original emission time, topic index, the record (original dates), doc key. */
  at: Float64Array;
  topic: Uint8Array;
  recs: Rec[];
  keys: string[];
  /** Per topic, the indices into the arrays above, in emission order. */
  byTopic: Map<SimTopic, Uint32Array>;
  session: Rec;
  meeting: Rec | null;
};

export function rawDir(repo: string, sessionKey: number) {
  return join(repo, "data", "raw", String(sessionKey));
}

export function hasRaw(repo: string, sessionKey: number) {
  return existsSync(join(rawDir(repo, sessionKey), "sessions.json.gz"));
}

function reader(dir: string) {
  return <T = Rec>(name: string): T[] => {
    const f = join(dir, `${name}.json.gz`);
    if (!existsSync(f)) return [];
    const x = JSON.parse(gunzipSync(readFileSync(f)).toString("utf8"));
    return Array.isArray(x) ? x : [];
  };
}

/** A lap as OpenF1 publishes it: at its start, then after each sector, then complete (server/simulate.ts). */
function lapVersions(l: Rec, nextStart: number | null, fallback: number): { at: number; rec: Rec }[] {
  const start = ms(l.date_start);
  const s1 = l.duration_sector_1;
  const s2 = l.duration_sector_2;
  const blank = {
    lap_duration: null,
    duration_sector_1: null,
    duration_sector_2: null,
    duration_sector_3: null,
    segments_sector_1: null,
    segments_sector_2: null,
    segments_sector_3: null,
    i1_speed: null,
    i2_speed: null,
    st_speed: null,
  };
  const end = l.lap_duration != null ? start + l.lap_duration * 1000 : (nextStart ?? fallback);
  if (!Number.isFinite(start)) return [{ at: nextStart ?? fallback, rec: l }];
  const out: { at: number; rec: Rec }[] = [{ at: start, rec: { ...l, ...blank } }];
  if (s1 != null) {
    const v1 = { ...l, ...blank, duration_sector_1: s1, segments_sector_1: l.segments_sector_1, i1_speed: l.i1_speed };
    out.push({ at: start + s1 * 1000, rec: v1 });
    if (s2 != null) out.push({ at: start + (s1 + s2) * 1000, rec: { ...v1, duration_sector_2: s2, segments_sector_2: l.segments_sector_2, i2_speed: l.i2_speed } });
  }
  out.push({ at: Math.max(end, start), rec: l });
  return out;
}

/** Lights out (the first lap 1 start), or the session start + 220 s. */
export function lightsOutOf(repo: string, sessionKey: number): number {
  const read = reader(rawDir(repo, sessionKey));
  const [session] = read("sessions");
  const lap1 = read("laps").filter((l) => l.lap_number === 1 && l.date_start).map((l) => ms(l.date_start));
  return lap1.length ? Math.min(...lap1) : ms(session?.date_start) + LIGHTS_OUT_AFTER_START_MS;
}

/**
 * The session's timeline, starting `startS` seconds from lights out (negative: before). Emission times are
 * the original ones; SimClock maps them onto now.
 */
export function buildTimeline(repo: string, sessionKey: number, startS: number): Timeline {
  const read = reader(rawDir(repo, sessionKey));
  const [session] = read("sessions");
  if (!session) throw new Error(`no raw cache in data/raw/${sessionKey}: run \`bun run ingest ${sessionKey}\` first`);
  const [meeting] = read("meeting");
  const drivers = read("drivers");
  const laps = read("laps");
  const stints = read("stints");
  const pits = read("pit");
  const raceControl = read("race_control");
  const results = read("session_result");

  const lap1 = laps.filter((l) => l.lap_number === 1 && l.date_start).map((l) => ms(l.date_start));
  const lightsOut = lap1.length ? Math.min(...lap1) : ms(session.date_start) + LIGHTS_OUT_AFTER_START_MS;
  const lapEnds = laps.filter((l) => l.date_start && l.lap_duration != null).map((l) => ms(l.date_start) + l.lap_duration * 1000);
  const lastLapEnd = lapEnds.length ? Math.max(...lapEnds) : lightsOut + 90 * 60_000;
  const chequered = ms(raceControl.find((m) => m.flag === "CHEQUERED")?.date);
  const endOrig = Math.max(Number.isFinite(chequered) ? chequered : lastLapEnd, lastLapEnd) + END_AFTER_FINISH_MS;
  const t0Orig = ms(session.date_start) - T0_BEFORE_START_MS;
  const startOrig = lightsOut + startS * 1000;
  const first = Math.min(t0Orig, startOrig);

  const events: { at: number; t: number; rec: Rec; telemetry: boolean }[] = [];
  const push = (topic: SimTopic, at: number, rec: Rec, telemetry = false) => {
    if (Number.isFinite(at)) events.push({ at, t: TOPIC_INDEX.get(topic)!, rec, telemetry });
  };

  const lapStart = new Map<string, number>();
  const byDriver = new Map<number, Rec[]>();
  for (const l of laps) {
    const list = byDriver.get(l.driver_number) ?? [];
    list.push(l);
    byDriver.set(l.driver_number, list);
  }
  for (const [n, own] of byDriver) {
    own.sort((a, b) => a.lap_number - b.lap_number);
    own.forEach((l, i) => {
      const start = l.date_start ? ms(l.date_start) : l.lap_number === 1 ? lightsOut : NaN;
      if (Number.isFinite(start)) lapStart.set(`${n}:${l.lap_number}`, start);
      const next = own.slice(i + 1).find((x) => x.date_start);
      for (const v of lapVersions(l, next ? ms(next.date_start) : null, lastLapEnd)) push("laps", v.at, v.rec);
    });
  }
  const stintSeen = new Set<string>();
  for (const s of stints) {
    for (let lap = s.lap_start; lap <= s.lap_end; lap++) {
      const at = lapStart.get(`${s.driver_number}:${lap}`) ?? (lap === s.lap_start && lap <= 1 ? lightsOut : NaN);
      if (Number.isFinite(at)) {
        push("stints", at, { ...s, lap_end: lap });
        stintSeen.add(`${s.driver_number}:${s.stint_number}`);
      }
    }
    if (!stintSeen.has(`${s.driver_number}:${s.stint_number}`)) push("stints", endOrig, s);
  }
  for (const rec of drivers) push("drivers", first, rec);
  push("sessions", first, session);
  for (const rec of pits) push("pit", ms(rec.date) + (rec.lane_duration ?? rec.pit_duration ?? 0) * 1000, rec);
  for (const rec of results) push("session_result", lastLapEnd + 30_000, rec);
  for (const topic of ["position", "intervals", "weather", "team_radio", "overtakes"] as const) for (const rec of read(topic)) push(topic, ms(rec.date), rec);
  for (const rec of raceControl) push("race_control", ms(rec.date), rec);
  // Telemetry: one file per car (the layout before slices), or every car's in time slices (`car_data_<from>_<to>`,
  // scripts/lib/slices.ts: what `bun run ingest` writes now), as server/simulate.ts reads it.
  const dir = rawDir(repo, sessionKey);
  const slices = readdirSync(dir)
    .map((f) => SLICE_FILE.exec(f))
    .filter((m) => m !== null)
    .map((m) => ({ topic: m[1] as "car_data" | "location", name: m[0].replace(/\.json\.gz$/, ""), from: Number(m[2]) }))
    .sort((a, b) => a.from - b.from);
  for (const topic of ["car_data", "location"] as const) {
    const recs = [...drivers.flatMap((d) => read(`${topic}_${d.driver_number}`)), ...slices.filter((s) => s.topic === topic).flatMap((s) => read(s.name))];
    for (const rec of recs) if (ms(rec.date) >= t0Orig) push(topic, ms(rec.date), rec, true);
  }

  // What a live session up to now would have published before the start is history (REST only); after the
  // end, documents published late (results, stewards' decisions) come at the end and telemetry stops.
  const kept = events.filter((e) => !(e.telemetry && e.at > endOrig)).map((e) => (e.at > endOrig ? { ...e, at: endOrig } : e));
  kept.sort((a, b) => a.at - b.at || a.t - b.t);
  const n = kept.length;
  const at = new Float64Array(n);
  const topic = new Uint8Array(n);
  const recs: Rec[] = new Array(n);
  const keys: string[] = new Array(n);
  const perTopic = SIM_TOPICS.map(() => [] as number[]);
  for (let i = 0; i < n; i++) {
    const e = kept[i]!;
    at[i] = e.at;
    topic[i] = e.t;
    recs[i] = e.rec;
    keys[i] = KEYS[SIM_TOPICS[e.t]!](e.rec);
    perTopic[e.t]!.push(i);
  }
  const byTopic = new Map<SimTopic, Uint32Array>(SIM_TOPICS.map((t, i) => [t, Uint32Array.from(perTopic[i]!)]));
  const label = [session.circuit_short_name ?? session.location, session.session_name].filter(Boolean).join(" ");
  return { sessionKey, label, lightsOut, startOrig, endOrig, at, topic, recs, keys, byTopic, session, meeting: meeting ?? null };
}

// ---------------------------------------------------------------- the clock

/**
 * The simulated clock. At wall time `anchorWall` the simulation is at the original time `startOrig`; it
 * runs `speed` times faster than the wall clock. Dates are shifted by `offset = anchorWall - startOrig`, so a
 * record's shifted date is where it sits on the simulated clock ("sim time"), which starts at anchorWall.
 */
export type SimClock = { anchorWall: number; startOrig: number; speed: number };
export const simNow = (c: SimClock, wall: number) => c.anchorWall + (wall - c.anchorWall) * c.speed;
export const offsetOf = (c: SimClock) => c.anchorWall - c.startOrig;

/** A record with its dates shifted onto the simulated clock, written OpenF1's way. */
export function shift(rec: Rec, offset: number): Rec {
  const out: Rec = { ...rec };
  for (const f of DATE_FIELDS) {
    const t = ms(out[f]);
    if (Number.isFinite(t)) out[f] = openf1Date(t + offset);
  }
  return out;
}

/** The number of events emitted at or before original time `orig` (binary search; events are in order). */
export function countUntil(at: Float64Array, orig: number, lo = 0, hi = at.length): number {
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (at[mid]! <= orig) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The MQTT payload of event i (as OpenF1 would send it: `_id`, `_key`). */
export function payload(tl: Timeline, i: number, offset: number): string {
  return JSON.stringify({ ...shift(tl.recs[i]!, offset), _id: i + 1, _key: tl.keys[i] });
}

// ---------------------------------------------------------------- REST

/**
 * OpenF1 REST as of sim time `now`: what was published by then (each document's latest version), filtered like
 * OpenF1 (`session_key` = N or latest, `meeting_key`, `driver_number`, `lap_number`, `date` / `date_start` with
 * =, >, <, >=, <=). Rows have no `_id` / `_key`. null: not an endpoint the simulation has.
 */
export function restQuery(tl: Timeline, clock: SimClock, endpoint: string, search: string, now: number): Rec[] | null {
  const offset = offsetOf(clock);
  const orig = now - offset;
  let rows: Rec[];
  if (endpoint === "meetings") rows = tl.meeting && orig >= tl.startOrig - 86_400_000 ? [shift(tl.meeting, offset)] : [];
  else {
    const idx = tl.byTopic.get(endpoint as SimTopic);
    if (!idx) return null;
    // idx is in emission order: the prefix emitted by now.
    let lo = 0;
    let hi = idx.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (tl.at[idx[mid]!]! <= orig) lo = mid + 1;
      else hi = mid;
    }
    const upTo = lo;
    // Date filters first (cheap, on the original dates) for the big time series.
    const filters = parseFilters(search);
    const dateFilter = filters.filter((f) => f.key === "date" || f.key === "date_start");
    const picked: number[] = [];
    if (VERSIONED.has(endpoint as SimTopic) || endpoint === "drivers" || endpoint === "sessions" || endpoint === "session_result") {
      const latest = new Map<string, number>();
      for (let j = 0; j < upTo; j++) latest.set(tl.keys[idx[j]!]!, idx[j]!);
      picked.push(...[...latest.values()].sort((a, b) => a - b));
    } else {
      let from = 0;
      const lower = dateFilter.find((f) => f.key === "date" && (f.op === ">=" || f.op === ">"));
      if (lower && endpoint !== "pit") {
        // Emission time = date for these topics: skip straight to it.
        const t = Date.parse(lower.value) - offset;
        let a = 0;
        let b = upTo;
        while (a < b) {
          const mid = (a + b) >>> 1;
          if (tl.at[idx[mid]!]! < t) a = mid + 1;
          else b = mid;
        }
        from = a;
      }
      for (let j = from; j < upTo; j++) picked.push(idx[j]!);
    }
    rows = picked.map((i) => shift(tl.recs[i]!, offset));
  }
  const filters = parseFilters(search);
  return rows.filter((r) => filters.every((f) => match(r, f, tl.sessionKey)));
}

type Filter = { key: string; op: string; value: string };

function parseFilters(search: string): Filter[] {
  const out: Filter[] = [];
  for (const part of search.replace(/^\?/, "").split("&").filter(Boolean)) {
    let raw: string;
    try {
      raw = decodeURIComponent(part.replaceAll("+", " "));
    } catch {
      continue;
    }
    const m = /^([a-z_]+)(>=|<=|>|<|=)(.*)$/.exec(raw);
    if (m) out.push({ key: m[1]!, op: m[2]!, value: m[3]! });
  }
  return out;
}

function match(r: Rec, f: Filter, sessionKey: number): boolean {
  if (f.key === "session_key" && f.value === "latest") return r.session_key === undefined || r.session_key === sessionKey;
  const v = r[f.key];
  if (v === undefined) return true;
  const date = f.key === "date" || f.key === "date_start" || f.key === "date_end";
  const a = date ? Date.parse(String(v)) : typeof v === "number" ? v : String(v);
  const b = date ? Date.parse(f.value) : typeof v === "number" ? Number(f.value) : f.value;
  switch (f.op) {
    case "=":
      return a === b;
    case ">=":
      return a >= b;
    case ">":
      return a > b;
    case "<=":
      return a <= b;
    case "<":
      return a < b;
  }
  return true;
}
