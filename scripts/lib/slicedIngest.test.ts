// Races downloaded in time slices (slices.ts) against a fake OpenF1 serving a real cached race: the processed
// output is byte-identical to the per-driver download's, whatever order the slices come in, and a resumed
// download only fetches what's missing. Needs the raw cache and output: `bun run ingest 11377` (skipped without).

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import { runIngest, type IngestEvent, type IngestIO } from "./ingestCore";
import type { Bytes } from "./rawCache";
import { parseSliceFile } from "./slices";

const KEY = 11377;
const rawDir = new URL(`../../data/raw/${KEY}/`, import.meta.url).pathname;
const outDir = new URL(`../../data/sessions/${KEY}/`, import.meta.url).pathname;
const available = existsSync(`${rawDir}sessions.json.gz`) && existsSync(`${outDir}meta.json`);

const readRaw = <T,>(name: string): T => JSON.parse(gunzipSync(require("node:fs").readFileSync(`${rawDir}${name}.json.gz`)).toString("utf8")) as T;

type Rec = { date: string; driver_number: number };

/** Every car's records of an endpoint, merged in time order (as one request for all cars returns them). */
const merged = new Map<string, Rec[]>();
function allCars(endpoint: string): Rec[] {
  let all = merged.get(endpoint);
  if (!all) {
    const drivers = readRaw<{ driver_number: number }[]>("drivers").map((d) => d.driver_number);
    all = drivers.flatMap((n) => readRaw<Rec[]>(`${endpoint}_${n}`)).sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
    merged.set(endpoint, all);
  }
  return all;
}

function world(opts: {
  concurrency: number;
  playhead?: () => number | null;
  cache?: Map<string, Bytes>;
  failAfter?: number;
  laps?: unknown[];
  /** ms per minute of a slice (long slices answer slowly). */
  sliceDelay?: number;
}) {
  const cache = opts.cache ?? new Map<string, Bytes>();
  const outputs = new Map<string, string>();
  const started: string[] = [];
  const serve = async (endpoint: string, params: Record<string, string | number>): Promise<unknown[]> => {
    const file = endpoint === "meetings" ? "meeting" : endpoint;
    started.push(params["date>="] != null ? `${file} ${params["date>="]} ${params["date<"]}` : file);
    if (opts.failAfter != null && started.length > opts.failAfter) throw new Error("OpenF1 503");
    await new Promise((r) => setTimeout(r, Math.random() * 8));
    if (params["date>="] != null) {
      const from = Date.parse(String(params["date>="]));
      const to = Date.parse(String(params["date<"]));
      if (opts.sliceDelay) await new Promise((r) => setTimeout(r, ((to - from) / 60_000) * opts.sliceDelay!));
      return allCars(endpoint).filter((r) => Date.parse(r.date) >= from && Date.parse(r.date) < to);
    }
    if (params.driver_number != null) throw new Error(`per-driver request for ${endpoint} ${params.driver_number}`);
    if ((file === "laps" || file === "race_control") && opts.laps) return opts.laps;
    return readRaw<unknown[]>(file);
  };
  const io: IngestIO = {
    concurrency: opts.concurrency,
    async readFile(path) {
      return cache.get(path);
    },
    async writeFileAtomic(path, bytes) {
      cache.set(path, bytes);
    },
    async rawFiles(dir) {
      return [...cache.keys()].filter((k) => k.startsWith(`${dir}/`)).map((k) => k.slice(dir.length + 1, -".json.gz".length));
    },
    playhead: opts.playhead,
    gzip: async (b) => gzipSync(b) as Bytes,
    gunzip: async (b) => gunzipSync(b) as Bytes,
    fetchEndpoint: <T,>(endpoint: string, params: Record<string, string | number>) => serve(endpoint, params) as Promise<T[]>,
    fetchCircuit: async () => readRaw("circuit") as never,
    async writeOutput(path, json) {
      outputs.set(path, json);
      return json.length;
    },
    log: () => {},
    warn: () => {},
  };
  const events: IngestEvent[] = [];
  const run = () => runIngest(KEY, io, { rawDir: `raw/${KEY}`, sessionsDir: "sessions" }, (e) => events.push(e));
  return { cache, outputs, started, events, run };
}

function expectReference(outputs: Map<string, string>) {
  const files = [...outputs.keys()].map((p) => p.replace(`sessions/${KEY}/`, "")).sort();
  const expected = ["meta.json", ...require("node:fs").readdirSync(`${outDir}drivers`).map((f: string) => `drivers/${f}`)].sort();
  expect(files).toEqual(expected);
  for (const f of files) {
    const want = require("node:fs").readFileSync(`${outDir}${f}`, "utf8");
    expect(outputs.get(`sessions/${KEY}/${f}`) === want).toBe(true);
  }
}

describe.skipIf(!available)(`ingest core: a race in slices (${KEY})`, () => {
  test("one at a time: the files a replay needs, the first slice, the rest; byte-identical output", async () => {
    const w = world({ concurrency: 1 });
    await w.run();
    expect(w.started.slice(0, 5)).toEqual(["sessions", "meeting", "drivers", "laps", "race_control"]);
    // The first slice (location, then car data) before the remaining session files.
    expect(w.started[5]).toStartWith("location ");
    expect(w.started[6]).toStartWith("car_data ");
    expect(w.started.slice(7, 15)).toEqual(["position", "intervals", "stints", "pit", "session_result", "weather", "team_radio", "overtakes"]);
    expect(w.started.slice(15).every((s) => /^(location|car_data) /.test(s))).toBe(true);
    // From lights out on: the slices after the first come in time order, then the ones before it.
    const plan = w.events.find((e) => e.kind === "plan") as Extract<IngestEvent, { kind: "plan" }>;
    const starts = w.started.slice(5).filter((s) => s.startsWith("location ")).map((s) => Date.parse(s.split(" ")[1]));
    const before = starts.filter((t) => t < starts[0]);
    expect(starts.filter((t) => t >= starts[0])).toEqual([...starts.filter((t) => t >= starts[0])].sort((a, b) => a - b));
    expect(before).toEqual([...before].sort((a, b) => b - a));
    expect(starts[0]).toBeLessThanOrEqual(plan.window.lightsOut);
    expectReference(w.outputs);
  }, 60_000);

  test("in parallel, from a playhead mid-race: byte-identical output", async () => {
    let calls = 0;
    // The viewer jumps an hour in after a few slices.
    const w = world({ concurrency: 6, playhead: () => (++calls > 3 ? Date.parse("2026-09-26T12:05:00Z") : null) });
    await w.run();
    expectReference(w.outputs);
  }, 60_000);

  test("a failure keeps what was downloaded; the next run fetches only the missing slices", async () => {
    const cache = new Map<string, Bytes>();
    const first = world({ concurrency: 3, cache, failAfter: 20 });
    expect(await first.run().catch((e) => e)).toBeInstanceOf(Error);
    const storedSlices = [...cache.keys()].flatMap((k) => parseSliceFile(k.split("/").at(-1)!.replace(".json.gz", "")) ?? []);
    expect(storedSlices.length).toBeGreaterThan(0);
    const second = world({ concurrency: 3, cache });
    await second.run();
    // Nothing fetched twice.
    for (const s of second.started) expect(first.started.slice(0, 20)).not.toContain(s);
    expectReference(second.outputs);
  }, 60_000);

  test("a failure planning the slices is the error (not 'telemetry incomplete'), and stops the rest", async () => {
    // No laps and no race control: no replay window.
    const w = world({ concurrency: 3, laps: [] });
    const err = await w.run().catch((e) => e);
    expect(String(err?.message)).toContain("no timed laps");
    expect(w.started.some((s) => s.startsWith("location ") || s.startsWith("car_data "))).toBe(false);
  }, 60_000);

  test("a jump into a long slice on its way: that unit is asked for again on its own; the overlap changes nothing", async () => {
    let ph: number | null = Date.parse("2026-09-26T11:03:00Z");
    const w = world({ concurrency: 4, playhead: () => ph, sliceDelay: 60 });
    const run = w.run();
    // Into the middle of the first 30-minute slice, once it's on its way.
    const long = () =>
      w.started.map((x) => x.split(" ")).find(([e, from, to]) => e === "location" && Date.parse(to!) - Date.parse(from!) >= 30 * 60_000);
    let target: string[] | undefined;
    for (let i = 0; i < 600 && !(target = long()); i++) await new Promise((r) => setTimeout(r, 5));
    expect(target).toBeDefined();
    const unit = Date.parse(target![1]!) + 10 * 60_000;
    ph = unit + 60_000;
    await run;
    // The unit on its own, as well as in the long slice.
    expect(w.started.some((x) => x.startsWith(`location ${new Date(unit).toISOString()} `))).toBe(true);
    expectReference(w.outputs);
  }, 60_000);
});
