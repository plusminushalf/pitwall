// Download cost model and live ETA (eta.ts), and the job tracker that feeds it from worker events (runner.ts).

import { describe, expect, test } from "bun:test";
import {
  cacheProgress,
  downloadSeconds,
  estimate,
  EWMA_ALPHA,
  etaSeconds,
  expectedRawFiles,
  fileForFetch,
  fileSeconds,
  layoutOf,
  minuteFloor,
  nextProcessingS,
  nextRatio,
  placeholderFiles,
  PROCESSING_PRIOR_S,
  progressOf,
  retryNotice,
  sizeScale,
  STARTUP_S,
  stepLabel,
} from "./eta";
import { JobTracker, type JobInfo } from "./runner";
import { TIER_PACE } from "./eta";

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

  test("a race in slices: the session files, then slice placeholders that the stored slices fill in time order", () => {
    expect(layoutOf([])).toBe("sliced");
    expect(layoutOf(["sessions", "car_data_44"])).toBe("per-driver");
    const files = expectedRawFiles("Race", null, 22, "sliced", 1);
    expect(files.map((f) => f.name).slice(0, 8)).toEqual(["sessions", "meeting", "circuit", "drivers", "laps", "race_control", "location#0", "car_data#0"]);
    expect(files.length).toBe(26); // 14 session files, 6 slices of each (2026 Baku's plan)
    const mb = files.reduce((s, f) => s + f.bytes, 0) / 1e6;
    expect(mb).toBeGreaterThan(10);
    expect(mb).toBeLessThan(14);
    // A sprint's window: fewer slices.
    expect(expectedRawFiles("Race", null, 22, "sliced", 0.5).length).toBeLessThan(files.length);
    const stored = placeholderFiles(
      cachedOf(["sessions", "car_data_1790420400_1790420700", "location_1790420700_1790422500", "location_1790420400_1790420700"]),
    );
    expect([...stored.keys()].sort()).toEqual(["car_data#0", "location#0", "location#1", "sessions"]);
    expect(cacheProgress(files, stored).cachedFiles).toBe(4);
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

  test("free tier: the burst's gap or a quarter of the work (4 in flight); signed in (the vault, 6 in flight): a sixth", () => {
    const [sessions] = expectedRawFiles("Race", [1]);
    const car = expectedRawFiles("Race", [1]).find((f) => f.name === "car_data_1")!;
    expect(fileSeconds(sessions, "free", 1)).toBe(0.5);
    expect(fileSeconds(car, "free", 1)).toBeCloseTo((0.64 + 295_000 * 5.4e-6) / 4);
    expect(fileSeconds(sessions, "sponsor", 1)).toBeCloseTo(1.15 / 6);
    expect(fileSeconds(car, "sponsor", 1)).toBeCloseTo((0.64 + 295_000 * 5.4e-6) / 6);
    expect(fileSeconds(car, "sponsor", 0.5)).toBeLessThan(fileSeconds(car, "sponsor", 1));
  });

  test("a minute's worth of requests, then the next minute", () => {
    const small = Array.from({ length: 30 }, (_, i) => ({ name: `f${i}`, required: true, bytes: 100 }));
    expect(downloadSeconds(small.slice(0, 24), "free", 1)).toBeCloseTo(24 * 0.5);
    // The 25th waits for the minute to roll over; the next minute's go a gap apart again.
    expect(downloadSeconds(small.slice(0, 25), "free", 1)).toBeCloseTo(60.5);
    expect(downloadSeconds(small, "free", 1)).toBeCloseTo(63);
    // 20 made 30 s ago: 4 more fit, the 5th waits 30 s.
    expect(downloadSeconds(small.slice(0, 5), "free", 1, 20, 30)).toBeCloseTo(30.5);
    expect(downloadSeconds(small, "sponsor", 1)).toBeCloseTo(30 * (1.15 / 6));
  });

  test("a race in slices: a minute and a bit on the free tier, ~12 MB", () => {
    const race = estimate(expectedRawFiles("Race", null, 22, "sliced", 1), "free", 1);
    // 2026 Baku in the browser: 63.8 s for 26 requests, 11.7 MB of slices (2026-10-01).
    expect(race.seconds).toBeGreaterThan(60);
    expect(race.seconds).toBeLessThan(80);
    expect(race.mb).toBeGreaterThan(10);
    expect(race.mb).toBeLessThan(14);
    const fast = estimate(expectedRawFiles("Race", null, 22, "sliced", 1), "sponsor", 1);
    expect(fast.seconds).toBeLessThan(30);
  });

  test("a whole race, per driver", () => {
    const race = estimate(expectedRawFiles("Race", DRIVERS_2026), "free", 1);
    // ~13 MB raw cache and a couple of minutes (57 requests: three minutes' worth of the free tier's 24).
    expect(race.mb).toBeGreaterThan(11);
    expect(race.mb).toBeLessThan(16);
    expect(race.seconds).toBeGreaterThan(100);
    expect(race.seconds).toBeLessThan(180);
    // Signed in, in parallel through the vault: well under a minute.
    const fast = estimate(expectedRawFiles("Race", DRIVERS_2026), "sponsor", 1);
    expect(fast.seconds).toBeGreaterThan(15);
    expect(fast.seconds).toBeLessThan(45);
    const sprint = estimate(expectedRawFiles("Race", DRIVERS_2026), "free", 0.5);
    expect(sprint.mb).toBeLessThan(race.mb * 0.6);
    // Nothing left: startup + processing only.
    expect(estimate([], "free", 1).seconds).toBe(STARTUP_S + PROCESSING_PRIOR_S);
    // A learned speed ratio scales the download part.
    expect(estimate(expectedRawFiles("Race", DRIVERS_2026), "free", 1, 2).seconds).toBeGreaterThan(race.seconds * 1.8);
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
    expect(progressOf({ phase: "downloading", headS: 0, elapsedS: 0, etaS: 60 })).toBe(0);
    expect(progressOf({ phase: "downloading", headS: 0, elapsedS: 30, etaS: 30 })).toBeCloseTo(0.5);
    // What earlier runs stored counts as done.
    expect(progressOf({ phase: "downloading", headS: 10, elapsedS: 0, etaS: 30 })).toBeCloseTo(0.25);
    expect(progressOf({ phase: "processing", headS: 0, elapsedS: 99, etaS: 1 })).toBeLessThan(1);
    expect(progressOf({ phase: "done", headS: 0, elapsedS: 0, etaS: 10 })).toBe(1);
  });

  // Replays a download second by second, as the tracker sees it (files landing, ratio updated per file, the minute's
  // requests counted). `actualSeconds(i)`: when file i lands after the one before, or after its start if that's later
  // (requests start at the tier's pace: a minute's worth a gap apart, then the next minute).
  function simulate(actualSeconds: (i: number) => number, tier: "free" | "sponsor", layout: "sliced" | "per-driver" = "per-driver") {
    const files = expectedRawFiles("Race", DRIVERS_2026, 22, layout, 1).filter((f) => f.required);
    const predicted = files.map((f) => fileSeconds(f, tier, 1));
    const { perMinute, gapS } = TIER_PACE[tier];
    const startAt = files.map((_, i) => 60 * Math.floor(i / perMinute) + (i % perMinute) * gapS);
    const landAt: number[] = [];
    let t = 0;
    files.forEach((_, i) => landAt.push((t = Math.max(t + actualSeconds(i), startAt[i] + actualSeconds(i)))));
    const total = t + PROCESSING_PRIOR_S;
    const etas: { t: number; eta: number; actual: number }[] = [];
    let ratio = 1;
    let landed = 0;
    let mark = 0;
    for (let now = 0; now < t; now++) {
      while (landed < files.length && landAt[landed] <= now) {
        const observed = landAt[landed] - mark;
        if (observed < 10 + 4 * predicted[landed]) ratio = nextRatio(ratio, observed, predicted[landed]);
        mark = landAt[landed++];
      }
      const started = startAt.filter((s) => s <= now && s > now - 60);
      const inFlight = startAt.filter((s) => s <= now).length - landed;
      const rest = files.slice(landed);
      const remainingS = rest.reduce((a, f) => a + fileSeconds(f, tier, 1), 0);
      const floorS = minuteFloor(rest.length, tier, Math.max(0, started.length - inFlight), started.length ? now - started[0] : 0);
      const eta = etaSeconds({ phase: "downloading", remainingS, currentS: predicted[landed] ?? 0, sinceMarkS: now - mark, ratio, floorS });
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
    const files = expectedRawFiles("Race", DRIVERS_2026, 22, "sliced", 1).filter((f) => f.required);
    // Real-looking free-tier timings: a slice every ~1.5-2 s while 4 are in flight, small files at the burst's gap.
    const etas = simulate((i) => (files[i].bytes > 100_000 ? 1.6 + rand() * 0.6 : 0.5 + rand() * 0.1), "free", "sliced");
    const first = etas[0];
    expect(Math.abs(first.eta - first.actual) / first.actual).toBeLessThan(0.15);
    for (let i = 1; i < etas.length; i++) {
      // Counts down; a slow file nudges it up by a few seconds at most.
      expect(etas[i].eta - etas[i - 1].eta).toBeLessThan(5);
    }
    for (const e of etas.slice(10)) expect(Math.abs(e.eta - e.actual)).toBeLessThan(Math.max(8, e.actual * 0.2));
  });

  test("signed in, in parallel: files land every few hundred ms, the ETA is sensible and counts down", () => {
    const rand = rng(11);
    const files = expectedRawFiles("Race", DRIVERS_2026).filter((f) => f.required);
    // Six at a time: telemetry lands every ~0.3-0.6 s, small files every ~0.2 s.
    const etas = simulate((i) => (files[i].bytes > 100_000 ? 0.3 + rand() * 0.3 : 0.2 + rand() * 0.05), "sponsor");
    const first = etas[0];
    expect(Math.abs(first.eta - first.actual) / first.actual).toBeLessThan(0.25);
    for (let i = 1; i < etas.length; i++) expect(etas[i].eta - etas[i - 1].eta).toBeLessThan(3);
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
    expect(fileForFetch("location", { session_key: 1, "date>=": "2026-09-26T11:00:00.000Z", "date<": "2026-09-26T11:05:00.000Z" })).toBe(
      "location_1790420400_1790420700",
    );
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
  const learned = () => ({ ratio: 1, sponsorRatio: 1, processingS: PROCESSING_PRIOR_S, reprocessS: 15 });

  test("resumes: files stored earlier count as done", () => {
    const t = new JobTracker(info, learned(), 0);
    t.onMessage({ type: "start", cached: { sessions: 300, meeting: 400, circuit: 6000, drivers: 1600 }, drivers: DRIVERS_2026 }, 0);
    const v = t.view(0);
    expect(v.cachedFiles).toBe(4);
    expect(v.expectedFiles).toBe(26); // a race in slices
    // Begun per driver: it carries on per driver.
    const old = new JobTracker(info, learned(), 0);
    old.onMessage({ type: "start", cached: { sessions: 300, car_data_1: 300_000 }, drivers: DRIVERS_2026 }, 0);
    expect(old.view(0).expectedFiles).toBe(57); // (the circuit map is skipped once a later file is in)
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
    // Slower than predicted (the burst's 0.5 s): the ratio goes up and the ETA follows.
    t.onMessage({ type: "fetched", file: "sessions", source: "network", ms: 4400 }, 4400);
    t.onMessage({ type: "stored", file: "sessions", bytes: 310 }, 4500);
    expect(l.ratio).toBeGreaterThan(1);
    const v = t.view(4500);
    expect(v.cachedFiles).toBe(1);
    expect(v.cachedBytes).toBe(310);
    expect(v.step).toBe("Session info");
    // (No lower than the time gone: what's left of the minute's pace bounds it.)
    expect(v.etaSeconds).toBeGreaterThanOrEqual(first - 6);
    // A rate-limit wait shows up as a notice and in the ETA.
    t.onMessage({ type: "retry", status: 429, waitMs: 10_000 }, 5000);
    expect(t.view(5000).notice).toBe("Rate-limited by OpenF1, retrying in 10s");
    expect(t.view(5000).etaSeconds).toBeGreaterThan(v.etaSeconds + 5);
    expect(v.fast).toBeNull();
    t.onMessage({ type: "phase", phase: "normalize" }, 200_000);
    const p = t.view(201_000);
    expect(p.phase).toBe("processing");
    expect(p.etaSeconds).toBe(PROCESSING_PRIOR_S - 1);
    expect(p.progress).toBeGreaterThan(0.9);
  });

  test("signed in: the vault's cost model and its own learned ratio; the ETA drops when it falls back to the free tier's", () => {
    const l = learned();
    const t = new JobTracker(info, l, 0);
    t.onMessage({ type: "start", cached: {}, drivers: DRIVERS_2026 }, 0);
    const before = t.view(0).etaSeconds;
    t.onMessage({ type: "path", path: "vault", reason: "signed in" }, 0);
    const fast = t.view(0);
    expect(fast.fast).toBe(true);
    expect(fast.etaSeconds).toBeLessThan(before / 2);
    t.onMessage({ type: "fetch", file: "sessions", endpoint: "sessions", params: { session_key: 11377 } }, 0);
    t.onMessage({ type: "fetched", file: "sessions", source: "network", ms: 400 }, 400);
    expect(l.sponsorRatio).toBeGreaterThan(1); // 0.4 s against a predicted 0.19 s
    expect(l.ratio).toBe(1); // the free tier's is untouched
    // The vault went away: the rest goes direct, and the ETA says so.
    t.onMessage({ type: "path", path: "direct", reason: "the vault didn't answer" }, 500);
    const slow = t.view(500);
    expect(slow.fast).toBe(false);
    expect(slow.etaSeconds).toBeGreaterThan(fast.etaSeconds * 2);
  });

  test("in slices: what's left is what the plan says, even past the placeholders", () => {
    const t = new JobTracker(info, learned(), 0);
    const docs = Object.fromEntries(["sessions", "meeting", "circuit", "drivers", "laps", "race_control", "position", "intervals", "stints", "pit", "session_result", "weather", "team_radio", "overtakes"].map((n) => [n, 1000]));
    // More slices stored than there are placeholders (a jump, the backfill), half the telemetry still to come.
    const slices = Object.fromEntries(
      Array.from({ length: 16 }, (_, i) => [[`location_${1790419800 + i * 300}_${1790420100 + i * 300}`, 100_000], [`car_data_${1790419800 + i * 300}_${1790420100 + i * 300}`, 100_000]]).flat(),
    );
    t.onMessage({ type: "start", cached: { ...docs, ...slices }, drivers: DRIVERS_2026 }, 0);
    t.onMessage({ type: "telemetry", progress: 0.5 }, 0);
    const v = t.view(0);
    expect(v.etaSeconds).toBeGreaterThan(PROCESSING_PRIOR_S + 3);
    expect(v.progress).toBeLessThan(0.9);
    t.onMessage({ type: "telemetry", progress: 1 }, 0);
    expect(t.view(0).etaSeconds).toBeLessThan(v.etaSeconds);
  });

  test("processing time is learned, within bounds", () => {
    expect(nextProcessingS(8, 18)).toBe(11);
    expect(nextProcessingS(8, 0)).toBe(8);
    expect(nextProcessingS(100, 10_000)).toBe(120);
  });
});
