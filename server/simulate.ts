// Simulated live session: replays a finished session's raw cache (data/raw/<key>/) through the
// same ingestion path as MQTT messages, time-shifted so it behaves like a session happening now.
//
//   LIVE_SIMULATE=<session_key>   LIVE_SIMULATE_SPEED=1   LIVE_SIMULATE_START=-60 (s from lights out; practice: the green light)
//
// Time series are emitted at their `date`. Documents without a natural timestamp are emitted as
// OpenF1 publishes them: laps at their start and again as each sector and the lap complete, stints
// at their first lap's start and updated every lap, pit stops once the car is out of the pit lane,
// drivers at the start, results after the last car finishes.

import {
  readCache,
  type RawCircuit,
  type RawLap,
  type RawMeeting,
  type RawPit,
  type RawRaceControl,
  type RawSession,
  type RawStint,
} from "../scripts/openf1";
import { readdir } from "node:fs/promises";
import { practiceStart } from "../scripts/lib/practice";
import { isFreePractice } from "../scripts/lib/season";
import { parseSliceFile, sliceFile } from "../scripts/lib/slices";
import type { Hub } from "./hub";
import { LiveStore, type Topic } from "./store";

type Rec = Record<string, any>;

export interface SimulateOptions {
  sessionKey: number;
  speed: number;
  /** Seconds relative to lights out at which the simulation starts (negative: before). */
  start: number;
}

interface Stream {
  topic: Topic;
  at: number[]; // original emission times (absolute ms), ascending
  recs: Rec[];
  i: number;
  telemetry: boolean;
}

const TICK_MS = 100;
const T0_BEFORE_START_MS = 10 * 60_000;
const LIGHTS_OUT_AFTER_START_MS = 220_000;
const END_AFTER_FINISH_MS = 5 * 60_000;
const DATE_FIELDS = ["date", "date_start", "date_end"] as const;

const ms = (iso: string | null | undefined) => (iso ? Date.parse(iso) : NaN);

function stream(topic: Topic, events: { at: number; rec: Rec }[], telemetry = false): Stream {
  const sorted = events.filter((e) => Number.isFinite(e.at)).sort((a, b) => a.at - b.at);
  return { topic, at: sorted.map((e) => e.at), recs: sorted.map((e) => e.rec), i: 0, telemetry };
}

/** A lap as OpenF1 publishes it: at its start, then after each sector, then complete. */
function lapVersions(l: RawLap, nextStart: number | null, fallback: number): { at: number; rec: Rec }[] {
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
  if (!Number.isFinite(start)) return [{ at: nextStart ?? fallback, rec: l }]; // undated: when the next lap starts
  const out: { at: number; rec: Rec }[] = [{ at: start, rec: { ...l, ...blank } }];
  if (s1 != null) {
    const v1 = { ...l, ...blank, duration_sector_1: s1, segments_sector_1: l.segments_sector_1, i1_speed: l.i1_speed };
    out.push({ at: start + s1 * 1000, rec: v1 });
    if (s2 != null) {
      out.push({
        at: start + (s1 + s2) * 1000,
        rec: { ...v1, duration_sector_2: s2, segments_sector_2: l.segments_sector_2, i2_speed: l.i2_speed },
      });
    }
  }
  out.push({ at: Math.max(end, start), rec: l });
  return out;
}

export async function simulate(hub: Hub, opts: SimulateOptions): Promise<void> {
  const key = opts.sessionKey;
  const dir = `data/raw/${key}`;
  const read = async <T>(name: string): Promise<T[]> => (await readCache<T[]>(`${dir}/${name}.json`)) ?? [];

  const [session] = await read<RawSession>("sessions");
  if (!session) {
    hub.setStatus({ state: "error", sessionKey: key, detail: `No raw cache in ${dir}: run \`bun run ingest ${key}\` first` });
    return;
  }
  hub.setStatus({ state: "connecting", sessionKey: key, next: null });
  const [meeting] = await read<RawMeeting>("meeting");
  const circuit = (await readCache<RawCircuit>(`${dir}/circuit.json`)) ?? null;
  const drivers = await read<Rec>("drivers");
  const laps = await read<RawLap>("laps");
  const stints = await read<RawStint>("stints");
  const pits = await read<RawPit>("pit");
  const raceControl = await read<RawRaceControl>("race_control");
  const results = await read<Rec>("session_result");

  // The original timeline.
  const lap1 = laps.filter((l) => l.lap_number === 1 && l.date_start).map((l) => ms(l.date_start));
  const lightsOut = isFreePractice(session)
    ? (practiceStart(raceControl) ?? ms(session.date_start))
    : lap1.length
      ? Math.min(...lap1)
      : ms(session.date_start) + LIGHTS_OUT_AFTER_START_MS;
  const lapEnds = laps.filter((l) => l.date_start && l.lap_duration != null).map((l) => ms(l.date_start) + l.lap_duration! * 1000);
  const lastLapEnd = lapEnds.length ? Math.max(...lapEnds) : lightsOut + 90 * 60_000;
  const chequered = ms(raceControl.find((m) => m.flag === "CHEQUERED")?.date);
  const endOrig = Math.max(Number.isFinite(chequered) ? chequered : lastLapEnd, lastLapEnd) + END_AFTER_FINISH_MS;
  const t0Orig = ms(session.date_start) - T0_BEFORE_START_MS;

  // Map the original timeline onto now: the simulation starts at lights out + `start` seconds.
  const startOrig = lightsOut + opts.start * 1000;
  const wallStart = Date.now();
  const offset = wallStart - startOrig;
  const origNow = () => startOrig + (Date.now() - wallStart) * opts.speed;
  const shift = (rec: Rec): Rec => {
    const out = { ...rec };
    for (const f of DATE_FIELDS) if (typeof out[f] === "string") out[f] = new Date(ms(out[f]) + offset).toISOString();
    return out;
  };

  // Lap start per driver and lap (for stints), from the laps themselves.
  const lapStart = new Map<string, number>();
  const byDriver = new Map<number, RawLap[]>();
  for (const l of laps) {
    const list = byDriver.get(l.driver_number) ?? [];
    list.push(l);
    byDriver.set(l.driver_number, list);
  }
  const lapEvents: { at: number; rec: Rec }[] = [];
  for (const [n, own] of byDriver) {
    own.sort((a, b) => a.lap_number - b.lap_number);
    own.forEach((l, i) => {
      const start = l.date_start ? ms(l.date_start) : l.lap_number === 1 ? lightsOut : NaN;
      if (Number.isFinite(start)) lapStart.set(`${n}:${l.lap_number}`, start);
      const next = own.slice(i + 1).find((x) => x.date_start);
      lapEvents.push(...lapVersions(l, next ? ms(next.date_start) : null, lastLapEnd));
    });
  }
  const stintEvents: { at: number; rec: Rec }[] = [];
  for (const s of stints) {
    for (let lap = s.lap_start; lap <= s.lap_end; lap++) {
      const at = lapStart.get(`${s.driver_number}:${lap}`) ?? (lap === s.lap_start && lap <= 1 ? lightsOut : NaN);
      if (Number.isFinite(at)) stintEvents.push({ at, rec: { ...s, lap_end: lap } });
    }
    // Stints whose laps are unknown still show up once the race is over.
    if (!stintEvents.some((e) => e.rec.driver_number === s.driver_number && e.rec.stint_number === s.stint_number)) {
      stintEvents.push({ at: endOrig, rec: s });
    }
  }

  const timed = (topic: Topic, recs: Rec[]) => stream(topic, recs.map((rec) => ({ at: ms(rec.date), rec })));
  const streams: Stream[] = [
    stream("drivers", drivers.map((rec) => ({ at: Math.min(t0Orig, startOrig), rec }))),
    stream("laps", lapEvents),
    stream("stints", stintEvents),
    // Pit records are complete once the car has left the pit lane (the date may be entry or exit).
    stream("pit", pits.map((rec) => ({ at: ms(rec.date) + (rec.lane_duration ?? rec.pit_duration ?? 0) * 1000, rec }))),
    stream("session_result", results.map((rec) => ({ at: lastLapEnd + 30_000, rec }))),
    timed("position", await read("position")),
    timed("intervals", await read("intervals")),
    timed("race_control", raceControl),
    timed("weather", await read("weather")),
    timed("team_radio", await read("team_radio")),
    timed("overtakes", await read("overtakes")),
  ];
  // Telemetry: every car's in time slices (scripts/lib/slices.ts, from `bun run ingest`), or one file per driver (an
  // ingest from before slices, the relay's own cache).
  const names = (await readdir(dir).catch(() => [] as string[])).map((n) => n.replace(/\.json(\.gz)?$/, ""));
  const slices = names.flatMap((n) => parseSliceFile(n) ?? []).sort((a, b) => a.span.from - b.span.from);
  const sliced = new Map<string, Rec[]>();
  for (const part of slices) {
    for (const r of await read<Rec>(sliceFile(part))) {
      const k = `${part.endpoint}_${r.driver_number}`;
      const list = sliced.get(k);
      if (list) list.push(r);
      else sliced.set(k, [r]);
    }
  }
  for (const d of drivers) {
    for (const topic of ["car_data", "location"] as const) {
      const name = `${topic}_${d.driver_number}`;
      const recs = (sliced.get(name) ?? (await read<Rec>(name))).filter((r) => ms(r.date) >= t0Orig);
      streams.push({ ...stream(topic, recs.map((rec) => ({ at: ms(rec.date), rec }))), telemetry: true });
    }
  }

  const store = new LiveStore({
    session: shift(session) as RawSession,
    meeting: meeting ?? null,
    circuit,
    t0: t0Orig + offset,
    clock: () => origNow() + offset,
  });

  let emitted = 0;
  const pump = (until: number, telemetryUntil = until) => {
    for (const s of streams) {
      const limit = s.telemetry ? telemetryUntil : until;
      while (s.i < s.at.length && s.at[s.i] <= limit) {
        store.ingest(s.topic, shift(s.recs[s.i++]));
        emitted++;
      }
    }
  };

  pump(origNow());
  console.log(
    `[live] simulating #${key} (${session.circuit_short_name} ${session.session_name}) at ${opts.speed}x from lights out ${opts.start >= 0 ? "+" : ""}${opts.start}s: ${emitted} records up front`,
  );
  hub.startSession(store);

  const timer = setInterval(() => {
    const now = origNow();
    if (now < endOrig) {
      pump(now);
      return;
    }
    clearInterval(timer);
    pump(Infinity, endOrig); // documents published late (results, stewards' decisions); no more telemetry
    console.log(`[live] simulation of #${key} finished (${emitted} records)`);
    hub.endSession("simulation finished");
  }, TICK_MS);
}
