// Live-mode normalization on real 2026 Azerbaijan GP data cut off mid-race
// (needs the raw cache: run `bun run ingest 11377` first).

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readCache, type RawCarData, type RawLap, type RawLocation, type RawSession, type RawStint } from "../openf1";
import { DriverSamples, estimateTotalLaps, normalize, type RawSessionData } from "./normalize";

const dir = new URL("../../data/raw/11377/", import.meta.url).pathname;
const available = existsSync(`${dir}sessions.json.gz`);

type Rec = Record<string, any>;
const ms = (iso: string) => Date.parse(iso);

async function loadBaku(): Promise<RawSessionData> {
  const read = async <T>(name: string) => (await readCache<T[]>(`${dir}${name}.json`)) ?? [];
  const drivers = await read<Rec>("drivers");
  const car = new Map<number, RawCarData[]>();
  const location = new Map<number, RawLocation[]>();
  for (const d of drivers) {
    car.set(d.driver_number, await read<RawCarData>(`car_data_${d.driver_number}`));
    location.set(d.driver_number, await read<RawLocation>(`location_${d.driver_number}`));
  }
  return {
    session: (await read<RawSession>("sessions"))[0],
    meeting: (await read<Rec>("meeting"))[0] as never,
    circuit: (await readCache(`${dir}circuit.json`)) ?? null,
    drivers: drivers as never,
    laps: await read("laps"),
    stints: await read("stints"),
    pits: await read("pit"),
    positions: await read("position"),
    intervals: await read("intervals"),
    raceControl: await read("race_control"),
    weather: await read("weather"),
    radio: await read("team_radio"),
    overtakes: await read("overtakes"),
    results: await read("session_result"),
    car,
    location,
  };
}

/** What OpenF1 would have published by `cut`: laps in progress have no end yet, no results. */
function truncate(raw: RawSessionData, cut: number): RawSessionData {
  const until = <T extends { date: string }>(xs: T[]) => xs.filter((x) => ms(x.date) <= cut);
  const laps: RawLap[] = raw.laps.flatMap((l) => {
    if (!l.date_start || ms(l.date_start) > cut) return [];
    if (l.lap_duration != null && ms(l.date_start) + l.lap_duration * 1000 <= cut) return [l];
    return [{ ...l, lap_duration: null, duration_sector_1: null, duration_sector_2: null, duration_sector_3: null }];
  });
  const current = new Map<number, number>();
  for (const l of laps) current.set(l.driver_number, Math.max(current.get(l.driver_number) ?? 0, l.lap_number));
  const stints: RawStint[] = raw.stints.flatMap((s) => {
    const lap = current.get(s.driver_number) ?? 0;
    return s.lap_start <= lap ? [{ ...s, lap_end: Math.min(s.lap_end, lap) }] : [];
  });
  const map = <T extends { date: string }>(m: Map<number, T[]>) => new Map([...m].map(([n, xs]) => [n, until(xs)]));
  return {
    ...raw,
    laps,
    stints,
    pits: until(raw.pits),
    positions: until(raw.positions),
    intervals: until(raw.intervals),
    raceControl: until(raw.raceControl),
    weather: until(raw.weather),
    radio: until(raw.radio),
    overtakes: until(raw.overtakes),
    results: [],
    car: map(raw.car!),
    location: map(raw.location!),
  };
}

describe.skipIf(!available)("live normalization, Baku 2026", async () => {
  const raw = available ? await loadBaku() : (null as unknown as RawSessionData);
  const t0 = available ? ms(raw.session.date_start) - 10 * 60_000 : 0;
  const lightsOutAbs = available ? Math.min(...raw.laps.filter((l) => l.lap_number === 1).map((l) => ms(l.date_start!))) : 0;
  // The leader (RUS, #63) completes lap 10.
  const lap10End = available
    ? Math.min(...raw.laps.filter((l) => l.lap_number === 10 && l.lap_duration != null).map((l) => ms(l.date_start!) + l.lap_duration! * 1000))
    : 0;

  test("cut at lap 10: no throw, leader on lap ~10, duration = now, sane positions", () => {
    const now = lap10End + 20_000;
    const { meta, telemetry } = normalize(truncate(raw, now), { live: { t0, now } });
    expect(meta.t0).toBe(new Date(t0).toISOString());
    expect(meta.duration).toBe(now - t0);
    expect(meta.lightsOut).toBe(lightsOutAbs - t0);
    expect(meta.lightsOutEstimated).toBe(false);
    expect(meta.chequered).toBeNull();
    expect(meta.results).toEqual([]);
    expect(meta.totalLaps).toBe(51);
    expect(meta.totalLapsEstimated).toBe(true);

    const leaderLap = Math.max(...meta.laps.map((l) => l.lap));
    expect(leaderLap).toBeGreaterThanOrEqual(10);
    expect(leaderLap).toBeLessThanOrEqual(11);
    // Laps still running have no end; completed ones end before now.
    for (const l of meta.laps) if (l.end != null) expect(l.end).toBeLessThanOrEqual(meta.duration);

    // Latest position per driver: a permutation of 1..22.
    const latest = new Map<number, number>();
    for (const p of meta.positions) latest.set(p.driver, p.position);
    expect(latest.size).toBe(22);
    expect([...latest.values()].sort((a, b) => a - b)).toEqual(Array.from({ length: 22 }, (_, i) => i + 1));
    expect(meta.grid.length).toBe(22);
    expect(meta.grid[0].position).toBe(1);

    // A clean lap exists by now: the outline comes from it.
    expect(meta.track.referenceLap.lap).toBeGreaterThan(1);
    expect(meta.track.outline.x.length).toBeGreaterThan(300);
    expect(meta.track.marshalSectors.length).toBe(21);

    for (const tel of telemetry.values()) {
      expect(tel.car.t.at(-1)!).toBeLessThanOrEqual(meta.duration);
      expect(tel.loc.t.at(-1) ?? 0).toBeLessThanOrEqual(meta.duration);
      for (let i = 1; i < tel.loc.t.length; i++) expect(tel.loc.t[i]).toBeGreaterThan(tel.loc.t[i - 1]);
    }
  });

  test("before lights out: estimated start, circuit outline, grid from positions", () => {
    const now = lightsOutAbs - 2 * 60_000;
    const { meta } = normalize(truncate(raw, now), { live: { t0, now } });
    expect(meta.duration).toBe(now - t0);
    expect(meta.laps).toEqual([]);
    expect(meta.lightsOutEstimated).toBe(true);
    expect(meta.lightsOut).toBeGreaterThanOrEqual(meta.duration);
    expect(meta.track.referenceLap).toEqual({ driver: 0, lap: 0, duration: 0 });
    expect(meta.track.outline.x.length).toBe(raw.circuit!.x!.length);
    expect(meta.track.marshalSectors.length).toBe(21);
    expect(meta.totalLaps).toBe(51);
    expect(meta.grid.length).toBe(22);
  });

  test("a session with nothing published yet", () => {
    const now = t0 + 60_000;
    const empty: RawSessionData = {
      ...raw,
      drivers: [],
      laps: [],
      stints: [],
      pits: [],
      positions: [],
      intervals: [],
      raceControl: [],
      weather: [],
      radio: [],
      overtakes: [],
      results: [],
      car: new Map(),
      location: new Map(),
    };
    const { meta, telemetry } = normalize(empty, { live: { t0, now } });
    expect(meta.duration).toBe(60_000);
    expect(meta.drivers).toEqual([]);
    expect(telemetry.size).toBe(0);
    expect(normalize({ ...empty, circuit: null }, { live: { t0, now } }).meta.track.bounds).toEqual({ minX: 0, maxX: 0, minY: 0, maxY: 0 });
  });

  test("replays still require a clean lap", () => {
    expect(() => normalize(truncate(raw, lightsOutAbs))).toThrow("No clean lap");
  });

  test("incremental cleaning matches cleaning everything at once", () => {
    const n = 16;
    const car = raw.car!.get(n)!;
    const loc = raw.location!.get(n)!;
    const cut = lap10End;
    const batch = new DriverSamples(n, t0);
    for (const c of car) batch.addCar(c);
    for (const l of loc) batch.addLocation(l);

    // Arrival in small interleaved batches with views in between, a few samples late, some twice.
    const live = new DriverSamples(n, t0);
    const events = [...car.map((s) => ({ s, car: true })), ...loc.map((s) => ({ s, car: false }))].sort(
      (a, b) => ms(a.s.date) - ms(b.s.date),
    );
    for (let i = 0; i < events.length; i++) {
      const e = i % 997 === 5 && i + 3 < events.length ? events[i + 3] : i % 997 === 8 ? events[i - 3] : events[i];
      if (e.car) live.addCar(e.s as RawCarData);
      else live.addLocation(e.s as RawLocation);
      if (i % 50 === 0) live.view(ms(e.s.date) - t0);
      if (i % 401 === 0 && e.car) live.addCar(e.s as RawCarData); // duplicate
    }
    const a = batch.view(cut - t0);
    const b = live.view(cut - t0);
    expect(b.telemetry).toEqual(a.telemetry);
    expect(b.stale).toBe(a.stale);
    expect(live.distance()).toEqual(batch.distance());
  });
});

describe("race distance estimate", () => {
  const baku = { session_name: "Race", circuit_short_name: "Baku" };
  test("from the circuit trace length (decimetres)", () => {
    expect(estimateTotalLaps(baku, { circuit: 59_930 })).toBe(51);
    expect(estimateTotalLaps({ ...baku, session_name: "Sprint" }, { circuit: 59_930 })).toBe(17);
    expect(estimateTotalLaps({ session_name: "Race", circuit_short_name: "Monte Carlo" }, { outline: 33_000 })).toBe(78);
  });
  test("falls back to typical distances without any length", () => {
    expect(estimateTotalLaps(baku, {})).toBe(57);
    expect(estimateTotalLaps({ ...baku, session_name: "Sprint" }, {})).toBe(19);
  });
});
