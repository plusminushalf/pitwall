// A race watched while it downloads (stream.ts + src/data/session.ts mergeTelemetry), against a fake OpenF1 serving a
// real cached race in slices: the first update can start a replay, every span's telemetry comes once, in any order,
// and what the page ends up with matches the stored replay. Needs `bun run ingest 11377` (skipped without).

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import { runIngest, type IngestIO } from "../../scripts/lib/ingestCore";
import type { Bytes } from "../../scripts/lib/rawCache";
import { buildSession, mergeTelemetry, streamSession, withMeta, type Session } from "../data/session";
import type { DriverTelemetry, SessionMeta } from "../types";
import type { StreamUpdate } from "./protocol";
import { StreamBuilder } from "./stream";

const KEY = 11377;
const rawDir = new URL(`../../data/raw/${KEY}/`, import.meta.url).pathname;
const outDir = new URL(`../../data/sessions/${KEY}/`, import.meta.url).pathname;
const available = existsSync(`${rawDir}sessions.json.gz`) && existsSync(`${outDir}meta.json`);

const readRaw = <T,>(name: string): T => JSON.parse(gunzipSync(readFileSync(`${rawDir}${name}.json.gz`)).toString("utf8")) as T;
type Rec = { date: string; driver_number: number };
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

async function streamRace(playhead: () => number | null) {
  const builder = new StreamBuilder(KEY);
  builder.watch();
  const updates: StreamUpdate[] = [];
  const cache = new Map<string, Bytes>();
  const io: IngestIO = {
    concurrency: 4,
    readFile: async (p) => cache.get(p),
    writeFileAtomic: async (p, b) => void cache.set(p, b),
    rawFiles: async () => [],
    playhead,
    gzip: async (b) => gzipSync(b) as Bytes,
    gunzip: async (b) => gunzipSync(b) as Bytes,
    async fetchEndpoint<T>(endpoint: string, params: Record<string, string | number>) {
      await new Promise((r) => setTimeout(r, Math.random() * 5));
      if (params["date>="] != null) {
        const from = Date.parse(String(params["date>="]));
        const to = Date.parse(String(params["date<"]));
        return allCars(endpoint).filter((r) => Date.parse(r.date) >= from && Date.parse(r.date) < to) as T[];
      }
      return readRaw<T[]>(endpoint === "meetings" ? "meeting" : endpoint);
    },
    fetchCircuit: async () => readRaw("circuit") as never,
    writeOutput: async (_p, json) => json.length,
    log: () => {},
    warn: () => {},
  };
  await runIngest(KEY, io, { rawDir: `raw/${KEY}`, sessionsDir: "sessions" }, (e) => {
    if (builder.onEvent(e)) {
      const u = builder.update();
      if (u) updates.push(u);
    }
  });
  return updates;
}

/** The page's side: the first update starts the replay, the rest grow it. */
function apply(updates: StreamUpdate[]): Session {
  let session: Session | null = null;
  for (const u of updates) {
    if (!session) session = streamSession(u.meta!, u.chunks);
    else {
      if (u.meta) session = withMeta(session, u.meta, false);
      session = mergeTelemetry(session, u.chunks);
    }
  }
  return session!;
}

describe.skipIf(!available)(`streaming a race while it downloads (${KEY})`, () => {
  const meta = JSON.parse(readFileSync(`${outDir}meta.json`, "utf8")) as SessionMeta;
  const stored = buildSession(
    meta,
    meta.drivers.map((d) => JSON.parse(readFileSync(`${outDir}drivers/${d.number}.json`, "utf8")) as DriverTelemetry),
  );

  for (const [name, playhead] of [
    ["from lights out", () => null],
    ["after a jump an hour in", (() => {
      let calls = 0;
      return () => (++calls > 2 ? Date.parse(meta.t0) + 3_600_000 : null);
    })()],
  ] as const) {
    test(`${name}: the first update starts the replay, each span comes once, and it ends up as the stored replay`, async () => {
      const updates = await streamRace(playhead);
      const first = updates[0]!;
      expect(first.meta).not.toBeNull();
      expect(first.meta!.laps.length).toBe(meta.laps.length);
      expect(first.chunks.length).toBeGreaterThan(0);
      // Every 5-minute unit's telemetry once: chunks of a driver never overlap.
      const seen = new Map<number, [number, number][]>();
      for (const u of updates) {
        for (const c of u.chunks) {
          const spans = seen.get(c.driver) ?? [];
          for (const [a, b] of spans) expect(c.to <= a || c.from >= b).toBe(true);
          spans.push([c.from, c.to]);
          seen.set(c.driver, spans);
        }
      }
      const last = updates.at(-1)!;
      expect(last.spans[0]![0]).toBeLessThanOrEqual(0);
      expect(last.spans.at(-1)![1]).toBeGreaterThanOrEqual(meta.duration);
      expect(last.spans.length).toBe(1);

      const session = apply(updates);
      // Everything but what depends on the reference lap (pinned to the first clean one while streaming) and the
      // telemetry right at span edges is the stored replay's.
      expect(session.meta.laps).toEqual(meta.laps);
      expect(session.meta.pits).toEqual(meta.pits);
      expect(session.meta.results).toEqual(meta.results);
      expect(session.meta.stints).toEqual(meta.stints);
      for (const n of stored.driverNumbers) {
        const a = stored.drivers.get(n)!;
        const b = session.drivers.get(n)!;
        expect(b.car.t.length).toBe(a.car.t.length);
        expect([...b.car.speed]).toEqual([...a.car.speed]);
        // Locations: the same samples, give or take dead reckoning across a span edge.
        expect(Math.abs(b.loc.t.length - a.loc.t.length)).toBeLessThanOrEqual(a.loc.t.length * 0.002);
      }
    }, 60_000);
  }
});
