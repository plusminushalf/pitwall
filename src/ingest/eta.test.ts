// Download cost model and live ETA (eta.ts), and the job tracker that feeds it from worker events (runner.ts).

import { describe, expect, test } from "bun:test";
import {
  cacheProgress,
  estimate,
  EWMA_ALPHA,
  etaSeconds,
  expectedRawFiles,
  fileForFetch,
  fileSeconds,
  nextProcessingS,
  nextRatio,
  PROCESSING_PRIOR_S,
  progressOf,
  retryNotice,
  sizeScale,
  STARTUP_S,
  stepLabel,
} from "./eta";
import { JobTracker, type JobInfo } from "./runner";

const DRIVERS_2026 = [1, 3, 5, 6, 10, 11, 12, 14, 16, 18, 22, 23, 27, 30, 31, 41, 43, 44, 55, 63, 77, 87];
const cachedOf = (names: string[], size = 100) => new Map(names.map((n) => [n, size]));

describe("expected raw files", () => {
  test("a race: 14 session files (circuit optional) + car_data/location per driver", () => {
    const files = expectedRawFiles("Race", null);
    expect(files.length).toBe(58);
    expect(files.filter((f) => f.required).length).toBe(57);
    expect(files.slice(0, 4).map((f) => f.name)).toEqual(["sessions", "meeting", "circuit", "drivers"]);
    expect(expectedRawFiles("Race", null, 20).length).toBe(54);
    const known = expectedRawFiles("Race", [1, 44]).map((f) => f.name);
    expect(known.slice(-4)).toEqual(["car_data_1", "location_1", "car_data_44", "location_44"]);
    // Unknown types fall back to the race list; qualifying makes the same requests.
    expect(expectedRawFiles("Qualifying", DRIVERS_2026).length).toBe(58);
    expect(expectedRawFiles("Mystery", [1]).length).toBe(16);
  });

  test("placeholders never match cached files", () => {
    const files = expectedRawFiles("Race", null);
    const p = cacheProgress(files, cachedOf(["sessions", "meeting", "car_data_1"]));
    expect(p.cachedFiles).toBe(2);
  });

  test("counting cached files", () => {
    const expected = expectedRawFiles("Race", DRIVERS_2026);
    expect(cacheProgress(expected, new Map())).toMatchObject({ cachedFiles: 0, expectedFiles: 58, cachedBytes: 0, complete: false });

    const some = cacheProgress(expected, cachedOf(["sessions", "meeting", "circuit", "drivers"], 1000));
    expect(some).toMatchObject({ cachedFiles: 4, expectedFiles: 58, cachedBytes: 4000, complete: false });
    expect(some.missing[0].name).toBe("laps");

    const all = cacheProgress(expected, cachedOf(expected.map((f) => f.name)));
    expect(all).toMatchObject({ cachedFiles: 58, expectedFiles: 58, complete: true });
    expect(all.missing).toEqual([]);
  });

  test("a missing circuit map doesn't block completion", () => {
    const expected = expectedRawFiles("Race", DRIVERS_2026);
    const names = expected.map((f) => f.name).filter((n) => n !== "circuit");
    // Still possible while nothing after it is cached...
    const early = cacheProgress(expected, cachedOf(["sessions", "meeting"]));
    expect(early.expectedFiles).toBe(58);
    expect(early.missing[0].name).toBe("circuit");
    // ...skipped once a later file exists.
    const later = cacheProgress(expected, cachedOf(["sessions", "meeting", "drivers"]));
    expect(later.expectedFiles).toBe(57);
    expect(later.missing.some((f) => f.name === "circuit")).toBe(false);
    expect(cacheProgress(expected, cachedOf(names))).toMatchObject({ cachedFiles: 57, expectedFiles: 57, complete: true });
  });

  test("files outside the expected list count towards bytes only", () => {
    const p = cacheProgress(expectedRawFiles("Race", [1]), cachedOf(["sessions", "legacy_extra"], 50));
    expect(p.cachedFiles).toBe(1);
    expect(p.cachedBytes).toBe(100);
  });
});

describe("estimates", () => {
  test("session window scale", () => {
    expect(sizeScale("2026-03-08T04:00:00+00:00", "2026-03-08T06:00:00+00:00")).toBe(1);
    expect(sizeScale("2026-03-14T03:00:00+00:00", "2026-03-14T04:00:00+00:00")).toBe(0.5);
    expect(sizeScale("bad", "date")).toBe(1);
  });

  test("small files are interval-bound, telemetry is transfer-bound", () => {
    const [sessions] = expectedRawFiles("Race", [1]);
    const car = expectedRawFiles("Race", [1]).find((f) => f.name === "car_data_1")!;
    expect(fileSeconds(sessions, "free", 1)).toBe(2.2);
    expect(fileSeconds(sessions, "sponsor", 1)).toBe(1.1);
    expect(fileSeconds(car, "sponsor", 1)).toBeGreaterThan(2);
    expect(fileSeconds(car, "sponsor", 0.5)).toBeLessThan(fileSeconds(car, "sponsor", 1));
  });

  test("a whole race", () => {
    const race = estimate(expectedRawFiles("Race", DRIVERS_2026), "sponsor", 1);
    // ~13 MB raw cache and a couple of minutes (cache mtimes of real downloads: 124-163 s).
    expect(race.mb).toBeGreaterThan(11);
    expect(race.mb).toBeLessThan(16);
    expect(race.seconds).toBeGreaterThan(100);
    expect(race.seconds).toBeLessThan(180);
    const sprint = estimate(expectedRawFiles("Race", DRIVERS_2026), "sponsor", 0.5);
    expect(sprint.mb).toBeLessThan(race.mb * 0.6);
    // Nothing left: startup + processing only.
    expect(estimate([], "free", 1).seconds).toBe(STARTUP_S + PROCESSING_PRIOR_S);
    // A learned speed ratio scales the download part.
    expect(estimate(expectedRawFiles("Race", DRIVERS_2026), "sponsor", 1, 2).seconds).toBeGreaterThan(race.seconds * 1.8);
  });
});

describe("ETA", () => {
  test("EWMA ratio moves toward samples, clamped", () => {
    expect(nextRatio(1, 2, 2)).toBe(1);
    const r = nextRatio(1, 4, 2); // sample 2
    expect(r).toBeCloseTo(1 + EWMA_ALPHA);
    expect(nextRatio(1, 4, 2, 3)).toBeGreaterThan(r); // three files at once weigh more
    expect(nextRatio(1, 1000, 1)).toBeCloseTo(1 + EWMA_ALPHA * 3); // sample clamped to 4
    expect(nextRatio(1, 0, 1)).toBeCloseTo(1 - EWMA_ALPHA * 0.75); // clamped to 0.25
    expect(nextRatio(2.9, 1000, 1, 40)).toBe(3);
    expect(nextRatio(1.2, 5, 0)).toBe(1.2); // nothing predicted: unchanged
  });

  test("before the first fetch, during a file, and processing", () => {
    const base = { phase: "downloading" as const, remainingS: 100, currentS: 2, ratio: 1 };
    expect(etaSeconds({ ...base, sinceMarkS: null })).toBe(STARTUP_S + 100 + PROCESSING_PRIOR_S);
    expect(etaSeconds({ ...base, sinceMarkS: 1 })).toBe(99 + PROCESSING_PRIOR_S);
    // A slow file doesn't count down past the files after it.
    expect(etaSeconds({ ...base, sinceMarkS: 30 })).toBe(98 + PROCESSING_PRIOR_S);
    expect(etaSeconds({ ...base, sinceMarkS: 0, waitS: 10 })).toBe(110 + PROCESSING_PRIOR_S);
    expect(etaSeconds({ ...base, ratio: 1.5, sinceMarkS: 0 })).toBe(150 + PROCESSING_PRIOR_S);
    expect(etaSeconds({ phase: "processing", remainingS: 0, currentS: 0, sinceMarkS: 0, ratio: 1, processingS: 1 })).toBe(PROCESSING_PRIOR_S - 1);
    expect(etaSeconds({ phase: "processing", remainingS: 0, currentS: 0, sinceMarkS: 0, ratio: 1, processingS: 60 })).toBe(1);
  });

  test("progress", () => {
    const totalS = 100 - PROCESSING_PRIOR_S; // downloading + processing = 100 s
    expect(progressOf({ phase: "downloading", totalS, remainingS: totalS, currentS: 1, inFlight: 0 })).toBe(0);
    expect(progressOf({ phase: "downloading", totalS, remainingS: totalS - 48, currentS: 1, inFlight: 0 })).toBeCloseTo(0.48);
    expect(progressOf({ phase: "processing", totalS, remainingS: 0, currentS: 0, inFlight: 0, processingS: 0 })).toBeCloseTo(totalS / 100);
    expect(progressOf({ phase: "processing", totalS, remainingS: 0, currentS: 0, inFlight: 0, processingS: 99 })).toBeLessThan(1);
    expect(progressOf({ phase: "done", totalS, remainingS: totalS, currentS: 0, inFlight: 0 })).toBe(1);
  });

  // Replays a download second by second, as the plugin sees it (files landing, ratio updated per file).
  function simulate(actualSeconds: (i: number) => number, tier: "free" | "sponsor") {
    const files = expectedRawFiles("Race", DRIVERS_2026).filter((f) => f.required);
    const predicted = files.map((f) => fileSeconds(f, tier, 1));
    const landAt: number[] = [];
    let t = 0;
    files.forEach((_, i) => landAt.push((t += actualSeconds(i))));
    const total = t + PROCESSING_PRIOR_S;
    const etas: { t: number; eta: number; actual: number }[] = [];
    let ratio = 1;
    let landed = 0;
    let mark = 0;
    for (let now = 0; now < t; now++) {
      while (landed < files.length && landAt[landed] <= now) {
        ratio = nextRatio(ratio, landAt[landed] - mark, predicted[landed]);
        mark = landAt[landed++];
      }
      const remainingS = predicted.slice(landed).reduce((a, b) => a + b, 0);
      const eta = etaSeconds({ phase: "downloading", remainingS, currentS: predicted[landed] ?? 0, sinceMarkS: now - mark, ratio });
      etas.push({ t: now, eta, actual: total - now });
    }
    return etas;
  }

  // Deterministic noise.
  function rng(seed: number) {
    return () => ((seed = (seed * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32);
  }

  test("sensible from the first second and steady on a typical download", () => {
    const rand = rng(7);
    const files = expectedRawFiles("Race", DRIVERS_2026).filter((f) => f.required);
    // Real-looking sponsor-tier timings (2025 Australia): small files interval-bound, telemetry 1.8-3.4 s.
    const etas = simulate((i) => (files[i].bytes > 100_000 ? 1.8 + rand() * 1.6 : 1.1 + rand() * 0.1), "sponsor");
    const first = etas[0];
    expect(Math.abs(first.eta - first.actual) / first.actual).toBeLessThan(0.15);
    for (let i = 1; i < etas.length; i++) {
      // Counts down; a slow file nudges it up by a few seconds at most.
      expect(etas[i].eta - etas[i - 1].eta).toBeLessThan(5);
    }
    for (const e of etas.slice(10)) expect(Math.abs(e.eta - e.actual)).toBeLessThan(Math.max(8, e.actual * 0.2));
  });

  test("adapts when the network is twice as slow as predicted", () => {
    const files = expectedRawFiles("Race", DRIVERS_2026).filter((f) => f.required);
    const etas = simulate((i) => 2 * fileSeconds(files[i], "sponsor", 1), "sponsor");
    const mid = etas[Math.floor(etas.length / 2)];
    expect(Math.abs(mid.eta - mid.actual) / mid.actual).toBeLessThan(0.15);
  });
});

describe("labels", () => {
  test("raw file per request", () => {
    expect(fileForFetch("meetings", { meeting_key: 1 })).toBe("meeting");
    expect(fileForFetch("car_data", { session_key: 1, driver_number: 44 })).toBe("car_data_44");
    expect(fileForFetch("session_result", { session_key: 1 })).toBe("session_result");
    expect(fileForFetch("circuit", {})).toBe("circuit");
  });

  test("step labels and retry notices", () => {
    expect(stepLabel("car_data", { driver_number: 44 }, DRIVERS_2026)).toBe("Car telemetry · #44 (18/22)");
    expect(stepLabel("location", { driver_number: "1" }, DRIVERS_2026)).toBe("Track positions · #1 (1/22)");
    expect(stepLabel("car_data", { driver_number: 44 }, null)).toBe("Car telemetry · #44");
    expect(stepLabel("laps", { session_key: 1 }, DRIVERS_2026)).toBe("Lap times");
    expect(stepLabel("brand_new_endpoint", {}, null)).toBe("brand new endpoint");
    expect(retryNotice(429, 4.2)).toBe("Rate-limited by OpenF1, retrying in 5s");
    expect(retryNotice(503, 20)).toBe("OpenF1 error 503, retrying in 20s");
  });
});

describe("job tracker", () => {
  const info: JobInfo = {
    key: 11377,
    label: "Azerbaijan Grand Prix · Race",
    sessionType: "Race",
    year: 2026,
    dateStart: "2026-09-27T11:00:00+00:00",
    dateEnd: "2026-09-27T13:00:00+00:00",
    mode: "download",
  };
  const learned = () => ({ ratio: 1, processingS: PROCESSING_PRIOR_S, reprocessS: 15 });

  test("resumes: files stored earlier count as done", () => {
    const t = new JobTracker(info, learned(), 0);
    t.onMessage({ type: "start", cached: { sessions: 300, meeting: 400, circuit: 6000, drivers: 1600 }, drivers: DRIVERS_2026 }, 0);
    const v = t.view(0);
    expect(v.cachedFiles).toBe(4);
    expect(v.expectedFiles).toBe(58);
    expect(v.cachedBytes).toBe(8300);
    expect(v.phase).toBe("downloading");
    expect(v.progress).toBeGreaterThan(0);
    expect(v.progress).toBeLessThan(0.1);
  });

  test("counts down as files arrive, learns the speed, then processes", () => {
    const l = learned();
    const t = new JobTracker(info, l, 0);
    t.onMessage({ type: "start", cached: {}, drivers: null }, 0);
    const first = t.view(0).etaSeconds;
    t.onMessage({ type: "fetch", file: "sessions", endpoint: "sessions", params: { session_key: 11377 } }, 0);
    // Twice as slow as predicted (2.2 s interval): the ratio goes up and the ETA follows.
    t.onMessage({ type: "fetched", file: "sessions", source: "network", ms: 4400 }, 4400);
    t.onMessage({ type: "stored", file: "sessions", bytes: 310 }, 4500);
    expect(l.ratio).toBeGreaterThan(1);
    const v = t.view(4500);
    expect(v.cachedFiles).toBe(1);
    expect(v.cachedBytes).toBe(310);
    expect(v.step).toBe("Session info");
    expect(v.etaSeconds).toBeGreaterThan(first - 5);
    // A rate-limit wait shows up as a notice and in the ETA.
    t.onMessage({ type: "retry", status: 429, waitMs: 10_000 }, 5000);
    expect(t.view(5000).notice).toBe("Rate-limited by OpenF1, retrying in 10s");
    expect(t.view(5000).etaSeconds).toBeGreaterThan(v.etaSeconds + 5);
    t.onMessage({ type: "phase", phase: "normalize" }, 200_000);
    const p = t.view(201_000);
    expect(p.phase).toBe("processing");
    expect(p.etaSeconds).toBe(PROCESSING_PRIOR_S - 1);
    expect(p.progress).toBeGreaterThan(0.9);
  });

  test("processing time is learned, within bounds", () => {
    expect(nextProcessingS(8, 18)).toBe(11);
    expect(nextProcessingS(8, 0)).toBe(8);
    expect(nextProcessingS(100, 10_000)).toBe(120);
  });
});
