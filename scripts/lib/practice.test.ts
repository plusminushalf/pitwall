// Free practice (practice.ts): the timing screen by best lap, the laps either side of a garage visit, the green light.
// The last tests run on real 2026 Australian GP FP2 data (need the raw cache: run `bun run ingest 11228` first).

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { readCache, type RawLap, type RawPit } from "../openf1";
import { normalize, type RawSessionData } from "./normalize";
import { parseSliceFile, sliceFile } from "./slices";
import { formatVersion, isCurrentFormat } from "./formatVersion";
import { buildPracticeTraces, endInLapsAtPitEntry, practiceStandings, practiceStart, preparePracticeLaps, TRACE_RATIO } from "./practice";
import type { Lap, PitStop } from "../../src/types";

const lap = (driver: number, n: number, start: number, duration: number | null, extra: Partial<Lap> = {}): Lap => ({
  driver,
  lap: n,
  start,
  end: duration != null ? start + duration * 1000 : null,
  duration,
  sectors: [null, null, null],
  segments: [[], [], []],
  speedTrap: { i1: null, i2: null, st: null },
  pitOut: false,
  ...extra,
});

/** Position and gaps of every car at t, from the events. */
function screenAt(s: ReturnType<typeof practiceStandings>, t: number) {
  const pos = new Map<number, number>();
  const gap = new Map<number, number | string | null>();
  const int = new Map<number, number | string | null>();
  for (const p of s.positions) if (p.t <= t) pos.set(p.driver, p.position);
  for (const i of s.intervals) if (i.t <= t) (gap.set(i.driver, i.gapToLeader), int.set(i.driver, i.interval));
  return [...pos].sort((a, b) => a[1] - b[1]).map(([n, p]) => `P${p} #${n} ${gap.get(n) ?? "-"} ${int.get(n) ?? "-"}`);
}

describe("practice standings", () => {
  test("every car from the start, without times, in car number order", () => {
    const s = practiceStandings([], [44, 1, 16]);
    expect(screenAt(s, 0)).toEqual(["P1 #1 - -", "P2 #16 - -", "P3 #44 - -"]);
  });

  test("by best lap so far, with gaps to the fastest and to the car ahead; no time: behind, no gaps", () => {
    const laps = [lap(1, 2, 100_000, 81.5), lap(16, 2, 110_000, 80.9), lap(1, 3, 181_500, 80.2), lap(44, 2, 300_000, 95)];
    const s = practiceStandings(laps, [1, 16, 44, 63]);
    expect(screenAt(s, 181_499)).toEqual(["P1 #1 - -", "P2 #16 - -", "P3 #44 - -", "P4 #63 - -"]);
    expect(screenAt(s, 200_000)).toEqual(["P1 #16 - -", "P2 #1 0.6 0.6", "P3 #44 - -", "P4 #63 - -"]);
    // #1 goes fastest at the end of lap 3 (181.5 + 80.2 s).
    expect(screenAt(s, 261_700)).toEqual(["P1 #1 - -", "P2 #16 0.7 0.7", "P3 #44 - -", "P4 #63 - -"]);
    expect(screenAt(s, 395_000)).toEqual(["P1 #1 - -", "P2 #16 0.7 0.7", "P3 #44 14.8 14.1", "P4 #63 - -"]);
  });

  test("a deleted lap counts until race control deletes it, then the next best does", () => {
    const deleted = lap(1, 3, 181_500, 80.2, { deleted: { t: 300_000, reason: "TRACK LIMITS AT TURN 3" } });
    const s = practiceStandings([lap(1, 2, 100_000, 81.5), lap(16, 2, 110_000, 80.9), deleted], [1, 16]);
    expect(screenAt(s, 299_999)).toEqual(["P1 #1 - -", "P2 #16 0.7 0.7"]);
    expect(screenAt(s, 300_000)).toEqual(["P1 #16 - -", "P2 #1 0.6 0.6"]);
  });

  test("equal times: the one set first ranks first", () => {
    const s = practiceStandings([lap(44, 2, 200_000, 80), lap(16, 2, 100_000, 80)], [16, 44]);
    expect(screenAt(s, 400_000)).toEqual(["P1 #16 - -", "P2 #44 0 0"]);
  });

  test("untimed laps (out-laps, in-laps) don't count", () => {
    const s = practiceStandings([lap(1, 1, 0, null, { pitOut: true, end: 90_000 })], [1, 16]);
    expect(screenAt(s, 200_000)).toEqual(["P1 #1 - -", "P2 #16 - -"]);
  });
});

const raw = (driver: number, n: number, start: string | null, duration: number | null, pitOut = false): RawLap =>
  ({ driver_number: driver, lap_number: n, date_start: start, lap_duration: duration, is_pit_out_lap: pitOut }) as RawLap;

describe("practice laps", () => {
  test("no lap time for out-laps and the in-laps before them (OpenF1's include the garage); an undated out-lap starts at the pit exit", () => {
    const laps = [
      raw(81, 1, null, 129.4, true),
      raw(81, 2, "2026-03-06T05:03:22Z", 102.4),
      raw(81, 3, "2026-03-06T05:05:05Z", 952.1), // into the garage
      raw(81, 4, "2026-03-06T05:21:00Z", 103.6, true),
      raw(81, 5, "2026-03-06T05:22:40Z", 79.7),
    ];
    const pits = [{ driver_number: 81, lap_number: 1, date: "2026-03-06T05:01:24Z" }] as RawPit[];
    const out = preparePracticeLaps(laps, pits);
    expect(out.map((l) => l.lap_duration)).toEqual([null, 102.4, null, null, 79.7]);
    expect(out[0].date_start).toBe("2026-03-06T05:01:24Z");
  });

  test("an in-lap ends at the pit entry: the car is in the garage until its out-lap", () => {
    const own = [lap(81, 3, 100_000, null, { end: 1_050_000 }), lap(81, 4, 1_050_000, null, { pitOut: true, end: 1_150_000 })];
    const pits = [{ driver: 81, lap: 4, entry: 190_000, exit: 1_050_000, laneDuration: 860, stopDuration: null }] as PitStop[];
    endInLapsAtPitEntry(new Map([[81, own]]), pits);
    expect(own.map((l) => l.end)).toEqual([190_000, 1_150_000]);
  });

  test("the session starts at the green light (the first one: a red flag's restart is another)", () => {
    const m = (date: string, category: string, message: string, flag: string | null = null, scope: string | null = null) => ({ date, category, message, flag, scope });
    expect(
      practiceStart([
        m("2026-03-06T04:11:40Z", "Other", "AIR TEMPERATURE 1 HOUR BEFORE F1 FREE PRACTICE 2 = 22.6 DEGREES"),
        m("2026-03-06T05:00:00Z", "Flag", "GREEN LIGHT - PIT EXIT OPEN", "GREEN", "Track"),
        m("2026-03-06T05:00:00Z", "SessionStatus", "SESSION STARTED"),
        m("2026-03-06T05:30:00Z", "SessionStatus", "SESSION STARTED"),
      ]),
    ).toBe(Date.parse("2026-03-06T05:00:00Z"));
    expect(practiceStart([m("2026-03-06T04:11:40Z", "Other", "RISK OF RAIN FOR F1 FREE PRACTICE 2 IS 0%")])).toBeNull();
  });
});

describe("format version", () => {
  test("per session type: practice's output changing doesn't ask for races and qualifying to be updated", () => {
    expect(formatVersion("Practice")).toBe(2);
    expect(formatVersion("Race")).toBe(1);
    expect(formatVersion(undefined)).toBe(formatVersion("Race"));
    expect(isCurrentFormat({ format: 1, sessionType: "Practice" })).toBe(false);
    expect(isCurrentFormat({ format: 1, sessionType: "Qualifying" })).toBe(true);
  });
});

const dir = new URL("../../data/raw/11228/", import.meta.url).pathname;
const available = existsSync(`${dir}sessions.json.gz`);

/** The session from its raw cache, read once for the tests below. */
let loaded: Promise<RawSessionData> | null = null;
const load = () => (loaded ??= readSession());

async function readSession(): Promise<RawSessionData> {
  const read = async <T>(name: string) => (await readCache<T[]>(`${dir}${name}.json`)) ?? [];
  const drivers = await read<{ driver_number: number }>("drivers");
  const car = new Map<number, never[]>(drivers.map((d) => [d.driver_number, []]));
  const location = new Map<number, never[]>(drivers.map((d) => [d.driver_number, []]));
  const slices = readdirSync(dir)
    .map((f) => parseSliceFile(f.replace(/\.json\.gz$/, "")))
    .filter((p) => p != null)
    .sort((a, b) => a.span.from - b.span.from);
  for (const part of slices) {
    for (const r of await read<{ driver_number: number }>(sliceFile(part))) (part.endpoint === "car_data" ? car : location).get(r.driver_number)?.push(r as never);
  }
  const data: RawSessionData = {
    session: (await read<RawSessionData["session"]>("sessions"))[0],
    meeting: (await read<NonNullable<RawSessionData["meeting"]>>("meeting"))[0],
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
  return data;
}

describe.skipIf(!available)("2026 Australian GP FP2 (raw cache)", () => {
  test("the timing screen at the flag is the official classification; the session runs from the green light to the flag", async () => {
    const { meta } = normalize(await load());
    expect(meta.practice?.scheduledEnd).toBe(Date.parse("2026-03-06T06:00:00Z") - Date.parse(meta.t0));
    expect(meta.lightsOut).toBe(Date.parse("2026-03-06T05:00:00Z") - Date.parse(meta.t0));
    expect(meta.chequered).toBe(Date.parse("2026-03-06T06:00:00Z") - Date.parse(meta.t0));
    expect(meta.grid).toEqual([]);
    // No garage time in any lap time.
    expect(Math.max(...meta.laps.flatMap((l) => (l.duration != null ? [l.duration] : [])))).toBeLessThan(200);
    const end = meta.duration;
    const screen = new Map<number, { position: number; gap: number | string | null }>();
    for (const p of meta.positions) if (p.t <= end) screen.set(p.driver, { position: p.position, gap: null });
    for (const i of meta.intervals) if (i.t <= end) screen.get(i.driver)!.gap = i.gapToLeader;
    for (const r of meta.results) {
      expect(screen.get(r.driver)?.position).toBe(r.position!);
      if (r.position! > 1 && typeof r.gapToLeader === "number") expect(screen.get(r.driver)?.gap).toBe(r.gapToLeader);
    }
  });

  test("lap traces of the laps at pace, without touching the laps", async () => {
    const { meta, telemetry } = normalize(await load());
    const laps = structuredClone(meta.laps);
    const { traces } = buildPracticeTraces({ meta, telemetry });
    expect(meta.laps).toEqual(laps);
    const p = meta.practice!;
    expect(p.lapLength).toBeGreaterThan(5200);
    expect(p.lapLength).toBeLessThan(5260);
    expect(p.sectorDistances![0]).toBeLessThan(p.sectorDistances![1]);
    expect(p.traced!.map((t) => t.driver)).toEqual([...traces.keys()]);
    const best = new Map<number, number>();
    for (const l of meta.laps) if (l.duration != null && !l.pitOut) best.set(l.driver, Math.min(best.get(l.driver) ?? Infinity, l.duration));
    let count = 0;
    for (const { driver, laps: traced } of p.traced!) {
      expect(traces.get(driver)!.laps.map((l) => l.lap)).toEqual(traced);
      for (const lt of traces.get(driver)!.laps) {
        const l = meta.laps.find((x) => x.driver === driver && x.lap === lt.lap)!;
        expect(l.pitOut).toBe(false);
        expect(l.duration!).toBeLessThanOrEqual(TRACE_RATIO * best.get(driver)!);
        // From line to line: the lap time, and the lap length.
        expect(lt.t.reduce((a, b) => a + b, 0)).toBe(Math.round(l.duration! * 1000));
        expect(lt.d.reduce((a, b) => a + b, 0)).toBe(Math.round(p.lapLength! * 10));
        count++;
      }
    }
    // Every driver's best lap with a time has one.
    for (const [driver, time] of best) {
      const l = meta.laps.find((x) => x.driver === driver && x.duration === time)!;
      expect(p.traced!.find((t) => t.driver === driver)?.laps).toContain(l.lap);
    }
    expect(count).toBe(225);
  });
});
