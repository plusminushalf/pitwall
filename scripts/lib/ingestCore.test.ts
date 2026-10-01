// Concurrent downloads in the ingest core, per driver (a download begun before slices: one per-driver file is
// stored), on a real cached race served as a fake OpenF1 (random delays, so responses arrive out of order): the
// processed output is identical at any concurrency, the requests start in the order they always did, a failure
// keeps what was downloaded (in-flight requests finish and are cached) and the next run resumes from it. Races in
// slices: slicedIngest.test.ts. Needs the raw cache with per-driver files: `bun run ingest 11377` from before
// slices, as the tests' data/raw/11377 is (skipped without it).

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import { runIngest, type IngestEvent, type IngestIO } from "./ingestCore";
import type { Bytes } from "./rawCache";

const KEY = 11377;
const dir = new URL(`../../data/raw/${KEY}/`, import.meta.url).pathname;
const drivers = existsSync(`${dir}drivers.json.gz`)
  ? [...new Set((JSON.parse(gunzipSync(require("node:fs").readFileSync(`${dir}drivers.json.gz`)).toString("utf8")) as { driver_number: number }[]).map((d) => d.driver_number))].sort((a, b) => a - b)
  : [];
/** Stored before the run: the layout of a download begun per driver. */
const SEED = `car_data_${drivers[0]}`;
const available = existsSync(`${dir}sessions.json.gz`) && existsSync(`${dir}${SEED}.json.gz`);

/** The raw file a request fills (src/ingest/eta.ts fileForFetch). */
const fileOf = (endpoint: string, params: Record<string, string | number>) => (endpoint === "meetings" ? "meeting" : params.driver_number != null ? `${endpoint}_${params.driver_number}` : endpoint);

function world(opts: { concurrency: number; failOn?: string; cache?: Map<string, Bytes> }) {
  const cache = opts.cache ?? new Map<string, Bytes>([[`raw/${KEY}/${SEED}.json.gz`, require("node:fs").readFileSync(`${dir}${SEED}.json.gz`) as Bytes]]);
  const outputs = new Map<string, string>();
  const started: string[] = [];
  const finished: string[] = [];
  let active = 0;
  let peak = 0;
  let failedAt = -1;
  const serve = async <T,>(file: string): Promise<T> => {
    started.push(file);
    active++;
    peak = Math.max(peak, active);
    try {
      // Random latency: responses come back in any order.
      await new Promise((r) => setTimeout(r, Math.random() * 12));
      if (file === opts.failOn) {
        failedAt = started.length;
        throw new Error(`OpenF1 503 for ${file}`);
      }
      const bytes = await Bun.file(`${dir}${file}.json.gz`).bytes();
      finished.push(file);
      return JSON.parse(gunzipSync(bytes).toString("utf8")) as T;
    } finally {
      active--;
    }
  };
  const io: IngestIO = {
    concurrency: opts.concurrency,
    async readFile(path) {
      return cache.get(path);
    },
    async writeFileAtomic(path, bytes) {
      await new Promise((r) => setTimeout(r, Math.random() * 3));
      cache.set(path, bytes);
    },
    async rawFiles(rawDir) {
      return [...cache.keys()].filter((k) => k.startsWith(`${rawDir}/`)).map((k) => k.slice(rawDir.length + 1, -".json.gz".length));
    },
    gzip: async (b) => gzipSync(b) as Bytes,
    gunzip: async (b) => gunzipSync(b) as Bytes,
    fetchEndpoint: <T,>(endpoint: string, params: Record<string, string | number>) => serve<T[]>(fileOf(endpoint, params)),
    fetchCircuit: <T,>() => serve<T>("circuit") as never,
    async writeOutput(path, json) {
      outputs.set(path, json);
      return json.length;
    },
    log: () => {},
    warn: () => {},
  };
  const events: IngestEvent[] = [];
  const run = () => runIngest(KEY, io, { rawDir: `raw/${KEY}`, sessionsDir: "sessions" }, (e) => events.push(e));
  return { io, cache, outputs, started, finished, events, run, peak: () => peak, failedAt: () => failedAt };
}

const cachedNames = (cache: Map<string, Bytes>) => [...cache.keys()].map((k) => k.replace(`raw/${KEY}/`, "").replace(".json.gz", "")).sort();

describe.skipIf(!available)(`ingest core: concurrent downloads per driver (${KEY})`, () => {
  let reference: Map<string, string>;

  test("one at a time: the same order as always (sessions, meeting, circuit, drivers, the session files, then per driver)", async () => {
    const w = world({ concurrency: 1 });
    await w.run();
    reference = w.outputs;
    expect(w.peak()).toBe(1);
    const numbers = (w.events.find((e) => e.kind === "drivers") as { numbers: number[] }).numbers;
    expect(w.started).toEqual([
      "sessions",
      "meeting",
      "circuit",
      "drivers",
      "laps",
      "stints",
      "pit",
      "position",
      "intervals",
      "race_control",
      "weather",
      "team_radio",
      "overtakes",
      "session_result",
      ...numbers.flatMap((n) => [`car_data_${n}`, `location_${n}`]).filter((f) => f !== SEED),
    ]);
    expect(reference.size).toBeGreaterThan(10);
  }, 60_000);

  test("six at a time: parallel, started in the same order, byte-identical output", async () => {
    const w = world({ concurrency: 6 });
    const out = await w.run();
    // In parallel, never more than the bound (a task also reads the cache first, so not always all 6 at the server).
    expect(w.peak()).toBeGreaterThanOrEqual(3);
    expect(w.peak()).toBeLessThanOrEqual(6);
    expect(w.started.slice(0, 2)).toEqual(["sessions", "meeting"]);
    // The per-driver files come after every session file.
    const firstCar = w.started.findIndex((f) => f.startsWith("car_data_"));
    expect(w.started.slice(firstCar).every((f) => f.startsWith("car_data_") || f.startsWith("location_"))).toBe(true);
    expect([...w.outputs.keys()].sort()).toEqual([...reference.keys()].sort());
    for (const [path, json] of reference) expect(w.outputs.get(path) === json).toBe(true);
    expect(out.timings.fetch).toBeGreaterThan(0);
    // Events: every raw file once, from the network (and the one stored before, from the cache).
    const raws = w.events.filter((e) => e.kind === "raw" && e.source === "network");
    expect(raws.length).toBe(w.started.length);
    expect(new Set(raws.map((e) => (e as { name: string }).name)).size).toBe(raws.length);
  }, 60_000);

  test("a failure keeps what was downloaded (in-flight requests finish and are cached), starts nothing more; the next run resumes", async () => {
    const failOn = `car_data_${drivers[3]}`;
    const first = world({ concurrency: 6, failOn });
    const cache = first.cache;
    const err = await first.run().catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(String(err.message)).toContain(failOn);
    // Nothing started after the failure beyond what was already queued to start with it in the same tick.
    expect(first.started.length).toBeLessThanOrEqual(first.failedAt() + 6);
    // Everything that finished is in the raw cache (with what was stored before): nothing downloaded was thrown away.
    expect(cachedNames(cache)).toEqual([...first.finished, SEED].sort());
    expect(first.outputs.size).toBe(0);
    // Resume: only the missing files are fetched, and the output is the same as a clean run's.
    const second = world({ concurrency: 6, cache });
    await second.run();
    expect(second.started.sort()).toEqual(
      first.started
        .concat(second.started)
        .filter((f, i, a) => a.indexOf(f) === i && !first.finished.includes(f))
        .sort(),
    );
    expect(second.started.some((f) => first.finished.includes(f))).toBe(false);
    expect(second.events.filter((e) => e.kind === "raw" && e.source === "cache").length).toBe(first.finished.length + 1);
    for (const [path, json] of reference) expect(second.outputs.get(path) === json).toBe(true);
  }, 60_000);

  test("the circuit map failing is only a warning: the download carries on", async () => {
    const w = world({ concurrency: 4, failOn: "circuit" });
    await w.run();
    expect(w.started.length).toBeGreaterThan(40);
    expect(cachedNames(w.cache)).not.toContain("circuit");
  }, 60_000);
});
