// Engine checks against the real 2026 Azerbaijan GP (run `bun run ingest 11377` first).

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { buildSession, type Session } from "../data/session";
import type { DriverTelemetry, SessionMeta } from "../types";
import { carPositionAt, driverStateAt, feedAt, leaderLapAt, mapOpacity, raceStateAt, telemetryAt } from "./raceState";

const dir = new URL("../../public/sessions/11377/", import.meta.url).pathname;
const available = existsSync(`${dir}meta.json`);

function load(): Session {
  const meta: SessionMeta = JSON.parse(readFileSync(`${dir}meta.json`, "utf8"));
  const telemetry: DriverTelemetry[] = meta.drivers.map((d) =>
    JSON.parse(readFileSync(`${dir}drivers/${d.number}.json`, "utf8")),
  );
  return buildSession(meta, telemetry);
}

describe.skipIf(!available)("Baku 2026 replay", () => {
  const s = available ? load() : (null as unknown as Session);
  const driver = (n: number) => s.drivers.get(n)!;

  test("at lights out every car is running lap 1 in grid order", () => {
    const race = raceStateAt(s, s.meta.lightsOut + 1_000);
    expect(race.leaderLap).toBe(1);
    expect(race.drivers.every((d) => d.status === "RUNNING" && d.lap === 1)).toBe(true);
    expect(race.drivers.map((d) => d.driver)).toEqual(s.meta.grid.map((g) => g.driver));
  });

  test("SAI (#55) pits after lap 20 and changes tyres", () => {
    const pit = s.meta.pits.find((p) => p.driver === 55 && p.lap === 20)!;
    const before = driverStateAt(driver(55), pit.entry - 5_000);
    const during = driverStateAt(driver(55), (pit.entry + pit.exit) / 2);
    const after = driverStateAt(driver(55), pit.exit + 5_000);
    expect(before.status).toBe("RUNNING");
    expect(before.stint).toBe(1);
    expect(during.status).toBe("PIT");
    expect(after.status).toBe("RUNNING");
    expect(after.stint).toBe(2);
    expect(after.pitStops).toBe(1);
    const stint2 = s.meta.stints.find((x) => x.driver === 55 && x.stint === 2)!;
    expect(after.compound).toBe(stint2.compound);
    expect(after.tyreAge).toBe(stint2.ageAtStart);
  });

  test("safety car on lap 32", () => {
    expect(raceStateAt(s, s.lapStartTimes[32] + 10_000).trackStatus).toBe("SC");
    expect(raceStateAt(s, s.lapStartTimes[25]).trackStatus).toBe("GREEN");
  });

  test("leader lap follows lap starts", () => {
    expect(leaderLapAt(s, s.lapStartTimes[20] + 1_000)).toBe(20);
    expect(leaderLapAt(s, s.meta.duration)).toBe(51);
  });

  test("final tower matches the classification (except the post-race penalty)", () => {
    const race = raceStateAt(s, s.meta.duration);
    const classified = s.meta.results.filter((r) => !r.dnf).map((r) => r.driver);
    // P1-P12 are unaffected by BOR's post-race penalty (13th on the road, classified 15th).
    expect(race.drivers.slice(0, 12).map((d) => d.driver)).toEqual(classified.slice(0, 12));
    for (const n of classified) expect(race.drivers.find((d) => d.driver === n)!.status).toBe("FINISHED");
  });

  test("retired cars go OUT and leave the map", () => {
    const stroll = driver(18);
    const retired = stroll.result!.retired!;
    expect(driverStateAt(stroll, retired - 5_000).status).not.toBe("OUT");
    expect(driverStateAt(stroll, retired + 1_000).status).toBe("OUT");
    expect(mapOpacity(stroll, retired + 60_000)).toBe(0);
    expect(raceStateAt(s, 30 * 60_000).drivers.at(-1)!.driver).toBe(18);
  });

  test("interpolated positions stay on the track outline under green", () => {
    const o = s.meta.track.outline;
    const distToOutline = (x: number, y: number) => {
      let best = Infinity;
      for (let i = 0; i < o.x.length; i++) best = Math.min(best, Math.hypot(o.x[i] - x, o.y[i] - y));
      return best;
    };
    let checked = 0;
    for (let lap = 3; lap <= 28; lap += 5) {
      for (let k = 0; k < 10; k++) {
        const t = s.lapStartTimes[lap] + k * 9_700;
        for (const d of s.drivers.values()) {
          const nearPit = d.pits.some((p) => t > p.entry - 15_000 && t < p.exit + 15_000);
          if (nearPit || driverStateAt(d, t).status !== "RUNNING") continue;
          const p = carPositionAt(d, t)!;
          expect(distToOutline(p.x, p.y)).toBeLessThan(400); // 40 m (units are 10 cm)
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(500);
  });

  test("finished cars stay on the map after their location feed ends", () => {
    const finishers = [...s.drivers.values()].filter((d) => d.result?.finish != null && d.result.retired == null);
    expect(finishers.length).toBeGreaterThan(10);
    for (const d of finishers) expect(carPositionAt(d, s.meta.duration)).not.toBeNull();
  });

  test("telemetry is sane mid-race", () => {
    const tel = telemetryAt(driver(63), s.lapStartTimes[10] + 30_000)!;
    expect(tel.speed).toBeGreaterThan(50);
    expect(tel.speed).toBeLessThan(370);
    expect(tel.gear).toBeGreaterThanOrEqual(1);
    expect(tel.gear).toBeLessThanOrEqual(8);
  });

  test("feed shows post-race stewards' decisions at the end", () => {
    const end = feedAt(s, s.meta.duration, 1_000);
    expect(end.some((f) => f.kind === "stewards" && f.text.includes("PENALTY FOR CAR 43"))).toBe(true);
    const mid = feedAt(s, s.lapStartTimes[20], 1_000);
    expect(mid.every((f) => f.t <= s.lapStartTimes[20])).toBe(true);
  });
});
