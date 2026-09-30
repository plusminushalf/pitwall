// Ingest one session, independent of platform: download every endpoint (raw cache first), normalize,
// encode and write the processed replay format (src/types.ts). All I/O goes through an IngestIO adapter:
// the Bun CLI (scripts/ingest.ts) uses files under data/raw and data/sessions, the browser worker
// (src/ingest/worker.ts) uses the browser's session store (OPFS), CompressionStream and fetch.
//
// Freshly downloaded responses are normalized from memory; the raw cache is written in the background
// (for resuming an interrupted download and re-processing offline) and only read back for files that
// were already cached.
//
// Requests run concurrently (IngestIO.concurrency at once; the rate limiter behind fetchEndpoint is the real
// limit), started in the order they always were: sessions, then meeting (and the circuit map as soon as the
// meeting says where it is), drivers and the other session files, then car_data / location per driver once
// the drivers are known. A failure stops new requests; the ones in flight finish and are cached, so the
// next run resumes from there. The processed output doesn't depend on the order responses arrive in.

import type {
  RawCarData,
  RawCircuit,
  RawDriver,
  RawInterval,
  RawLap,
  RawLocation,
  RawMeeting,
  RawOvertake,
  RawPit,
  RawPosition,
  RawRaceControl,
  RawRadio,
  RawResult,
  RawSession,
  RawStint,
  RawWeather,
} from "./openf1Types";
import type { SessionIndexEntry } from "../../src/types";
import { encodeTelemetry, normalize, type RawSessionData } from "./normalize";
import { buildQuali, prepareQualiLaps } from "./quali";
import { readCache, writeCache, type RawCacheIO } from "./rawCache";

export { FORMAT_VERSION } from "./formatVersion";

export interface IngestIO extends RawCacheIO {
  fetchEndpoint<T>(endpoint: string, params: Record<string, string | number>): Promise<T[]>;
  /** Requests (and cache reads) at once. Default 1: one after the other. */
  concurrency?: number;
  fetchCircuit(url: string): Promise<RawCircuit>;
  /** Write one processed JSON file; resolves to its gzipped size in bytes. */
  writeOutput(path: string, json: string): Promise<number>;
  /** The session index, or undefined if there is none yet. Without readIndex / writeIndex no index is kept. */
  readIndex?(path: string): Promise<SessionIndexEntry[] | undefined>;
  writeIndex?(path: string, text: string): Promise<void>;
  log(line: string): void;
  warn(line: string): void;
}

export interface IngestPaths {
  /** Raw cache directory for this session, e.g. `data/raw/11377`. */
  rawDir: string;
  /** Processed sessions directory (holds index.json and <key>/), e.g. `data/sessions`. */
  sessionsDir: string;
}

/** Milliseconds spent per phase. */
export interface IngestTimings {
  /** Network requests (OpenF1 + MultiViewer), including parsing the response: wall time with any in flight. */
  fetch: number;
  /** Gzip + write of freshly downloaded responses into the raw cache (in the background, overlapping fetches). */
  rawWrite: number;
  /** Read + gunzip + JSON.parse of cached raw responses. */
  cacheRead: number;
  /** normalize() plus the qualifying pass. */
  normalize: number;
  /** encodeTelemetry + JSON.stringify of the output files. */
  encode: number;
  /** Gzip (or size) + write of the output files and the index. */
  write: number;
}

export type IngestEvent =
  /** A raw file is in memory: read from the cache, or downloaded (its cache write may still be running). */
  | { kind: "raw"; name: string; source: "cache" | "network"; ms: number }
  /** The session's driver numbers, in the order their car_data / location files are requested. */
  | { kind: "drivers"; numbers: number[] }
  | { kind: "phase"; phase: "download" | "normalize" | "write" | "done" };

const now = () => performance.now();

/** Thrown into the requests still queued once one has failed: they never start. */
class Stopped extends Error {}

/** At most `limit` tasks at once, started in submission order (`front`: before the queued ones). */
function limiter(limit: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  let stopped = false;
  const next = () => {
    while (active < limit && queue.length) queue.shift()!();
  };
  function run<T>(task: () => Promise<T>, front = false): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        if (stopped) return reject(new Stopped());
        active++;
        task()
          .then(resolve, reject)
          .finally(() => {
            active--;
            next();
          });
      };
      if (front) queue.unshift(start);
      else queue.push(start);
      next();
    });
  }
  return {
    run,
    /** No more starts: everything queued (now or later) rejects with Stopped. */
    stop() {
      stopped = true;
      for (const start of queue.splice(0)) start();
    },
  };
}

/** Download (or read from cache), normalize and write one session. Throws on unsupported sessions. */
export async function runIngest(sessionKey: number, io: IngestIO, paths: IngestPaths, onEvent?: (e: IngestEvent) => void) {
  const { rawDir, sessionsDir } = paths;
  const outDir = `${sessionsDir}/${sessionKey}`;
  const timings: IngestTimings = { fetch: 0, rawWrite: 0, cacheRead: 0, normalize: 0, encode: 0, write: 0 };

  // Cache writes run in the background while the next request is under way; a failed one fails the ingest.
  const pendingWrites: Promise<void>[] = [];
  let writeError: { error: unknown } | null = null;
  const rethrowWriteError = () => {
    if (writeError) throw writeError.error;
  };

  // Wall time with at least one request in flight.
  let inFlight = 0;
  let fetchSince = 0;
  const fetching = (on: boolean) => {
    if (on && inFlight++ === 0) fetchSince = now();
    if (!on && --inFlight === 0) timings.fetch += now() - fetchSince;
  };

  async function cached<T>(name: string, fetcher: () => Promise<T>): Promise<T | undefined> {
    rethrowWriteError();
    const file = `${rawDir}/${name}.json`;
    const t0 = now();
    const hit = await readCache<T>(io, file);
    if (hit !== undefined) {
      timings.cacheRead += now() - t0;
      onEvent?.({ kind: "raw", name, source: "cache", ms: now() - t0 });
      return hit;
    }
    const t1 = now();
    let data: T;
    fetching(true);
    try {
      data = await fetcher();
    } finally {
      fetching(false);
    }
    const t2 = now();
    pendingWrites.push(
      writeCache(io, file, data).then(
        () => void (timings.rawWrite += now() - t2),
        (error) => void (writeError ??= { error }),
      ),
    );
    onEvent?.({ kind: "raw", name, source: "network", ms: t2 - t1 });
    return data;
  }

  function endpoint<T>(name: string, ep: string, params: Record<string, number>): Promise<T[]> {
    return cached<T[]>(name, () => {
      const label = Object.entries(params).map(([k, v]) => `${k}=${v}`).join(" ");
      io.log(`  fetching ${ep} ${label}`);
      return io.fetchEndpoint<T>(ep, params);
    }) as Promise<T[]>;
  }

  function get<T>(ep: string, extra: Record<string, number> = {}) {
    const suffix = Object.values(extra).join("_");
    return endpoint<T>(`${ep}${suffix ? `_${suffix}` : ""}`, ep, { session_key: sessionKey, ...extra });
  }

  // Every request goes through the limiter; the first failure stops the ones not started yet.
  const limit = limiter(Math.max(1, Math.floor(io.concurrency ?? 1)));
  const tasks: Promise<unknown>[] = [];
  let failure: { error: unknown } | null = null;
  function task<T>(fn: () => Promise<T>, front = false): Promise<T> {
    const p = limit.run(fn, front);
    tasks.push(
      p.catch((error) => {
        if (error instanceof Stopped) return;
        failure ??= { error };
        limit.stop();
      }),
    );
    return p;
  }
  /** Wait for every request, including the ones started while waiting (the per-driver files). */
  async function settled() {
    for (let n = -1; n !== tasks.length; ) {
      n = tasks.length;
      await Promise.all(tasks.slice());
    }
  }
  /** After a failure: let what's in flight finish and be cached (a later run resumes from it), then throw. */
  async function rethrowFailure() {
    if (!failure) return;
    await settled();
    await Promise.allSettled(pendingWrites);
    throw failure.error;
  }

  // ---------------------------------------------------------------- download

  io.log(`Ingesting session ${sessionKey}`);
  onEvent?.({ kind: "phase", phase: "download" });
  const [session] = await get<RawSession>("sessions");
  if (!session) throw new Error(`Session ${sessionKey} not found`);
  if (session.session_type !== "Race" && session.session_type !== "Qualifying") {
    throw new Error(`Session ${sessionKey} is "${session.session_name}" (${session.session_type}); only races, sprints and qualifying are supported`);
  }

  async function circuitInfo(meeting: RawMeeting | undefined): Promise<RawCircuit | null> {
    const url = meeting?.circuit_info_url;
    if (!url) return null;
    try {
      // Next (ahead of the queue), and not through task(): it isn't an OpenF1 request, and its failure is only
      // a warning, so it doesn't stop the others.
      return (
        (await limit.run(
          () =>
            cached<RawCircuit>("circuit", () => {
              io.log(`  fetching circuit info ${url}`);
              return io.fetchCircuit(url);
            }),
          true,
        )) ?? null
      );
    } catch (e) {
      if (e instanceof Stopped) throw e;
      io.warn(`  circuit info unavailable (${e}); map will have no rotation, corners or marshal sectors`);
      return null;
    }
  }
  const meetingP = task(() => endpoint<RawMeeting>("meeting", "meetings", { meeting_key: session.meeting_key }));
  // The circuit map as soon as the meeting says where it is.
  const circuitP = meetingP.then(([meeting]) => circuitInfo(meeting));
  const driversP = task(() => get<RawDriver>("drivers"));
  const lapsP = task(() => get<RawLap>("laps"));
  const stintsP = task(() => get<RawStint>("stints"));
  const pitsP = task(() => get<RawPit>("pit"));
  const positionsP = task(() => get<RawPosition>("position"));
  const intervalsP = task(() => get<RawInterval>("intervals"));
  const raceControlP = task(() => get<RawRaceControl>("race_control"));
  const weatherP = task(() => get<RawWeather>("weather"));
  const radioP = task(() => get<RawRadio>("team_radio"));
  const overtakesP = task(() => get<RawOvertake>("overtakes"));
  const resultsP = task(() => get<RawResult>("session_result"));

  // Per driver, once the drivers are known: queued behind the session files.
  const perDriverP = driversP.then((drivers) => {
    const numbers = [...new Set(drivers.map((d) => d.driver_number))].sort((a, b) => a - b);
    onEvent?.({ kind: "drivers", numbers });
    return numbers.map((n) => ({ n, car: task(() => get<RawCarData>("car_data", { driver_number: n })), loc: task(() => get<RawLocation>("location", { driver_number: n })) }));
  });
  perDriverP.catch(() => {});
  tasks.push(circuitP.catch(() => {}), perDriverP.catch(() => {}));

  await settled();
  await rethrowFailure();
  const [meeting] = await meetingP;
  const circuit = await circuitP;
  const rawDrivers = await driversP;
  const rawLaps = await lapsP;
  const rawStints = await stintsP;
  const rawPits = await pitsP;
  const rawPositions = await positionsP;
  const rawIntervals = await intervalsP;
  const rawRaceControl = await raceControlP;
  const rawWeather = await weatherP;
  const rawRadio = await radioP;
  const rawOvertakes = await overtakesP;
  const rawResults = await resultsP;
  const perDriver = await perDriverP;
  const driverNumbers = perDriver.map((d) => d.n);
  // In driver order, whatever order they arrived in (normalize iterates these maps).
  const rawCar = new Map<number, RawCarData[]>();
  const rawLoc = new Map<number, RawLocation[]>();
  for (const d of perDriver) {
    rawCar.set(d.n, await d.car);
    rawLoc.set(d.n, await d.loc);
  }

  await Promise.all(pendingWrites);
  rethrowWriteError();

  // ---------------------------------------------------------------- process

  onEvent?.({ kind: "phase", phase: "normalize" });
  const tNorm = now();
  const isQuali = session.session_type === "Qualifying";
  let raw: RawSessionData | null = {
    session,
    meeting: meeting ?? null,
    circuit,
    drivers: rawDrivers,
    laps: isQuali ? prepareQualiLaps(rawLaps, rawPits) : rawLaps,
    stints: rawStints,
    pits: rawPits,
    positions: rawPositions,
    intervals: rawIntervals,
    raceControl: rawRaceControl,
    weather: rawWeather,
    radio: rawRadio,
    overtakes: rawOvertakes,
    results: rawResults,
    car: rawCar,
    location: rawLoc,
  };
  const { meta, telemetry, report } = normalize(raw);
  raw = null;
  rawCar.clear();
  rawLoc.clear();
  for (const w of report.warnings) io.warn(w);
  // Qualifying: segments, classification and distance-aligned lap traces (adjusts meta, adds meta.quali).
  const quali = isQuali
    ? buildQuali({ session, laps: rawLaps, pits: rawPits, raceControl: rawRaceControl, results: rawResults }, { meta, telemetry, report })
    : null;
  timings.normalize += now() - tNorm;

  // ---------------------------------------------------------------- write

  onEvent?.({ kind: "phase", phase: "write" });
  const sizes: [string, number, number][] = [];
  async function writeJson(path: string, data: () => unknown) {
    const t0 = now();
    const json = JSON.stringify(data());
    const t1 = now();
    timings.encode += t1 - t0;
    sizes.push([path, json.length, await io.writeOutput(path, json)]);
    timings.write += now() - t1;
  }

  await writeJson(`${outDir}/meta.json`, () => meta);
  for (const n of driverNumbers) await writeJson(`${outDir}/drivers/${n}.json`, () => encodeTelemetry(telemetry.get(n)!));
  if (quali) for (const tr of quali.traces.values()) await writeJson(`${outDir}/laps/${tr.driver}.json`, () => tr);

  const tIndex = now();
  const entry: SessionIndexEntry = {
    sessionKey,
    meetingName: meta.meetingName,
    sessionName: meta.sessionName,
    year: meta.year,
    circuit: meta.circuit,
    country: meta.country,
    dateStart: session.date_start,
    sessionType: isQuali ? "Qualifying" : "Race",
  };
  if (io.readIndex && io.writeIndex) {
    const indexFile = `${sessionsDir}/index.json`;
    const index = (await io.readIndex(indexFile)) ?? [];
    const nextIndex = [...index.filter((e) => e.sessionKey !== sessionKey), entry].sort((a, b) =>
      a.dateStart.localeCompare(b.dateStart),
    );
    await io.writeIndex(indexFile, JSON.stringify(nextIndex, null, 2) + "\n");
  }
  timings.write += now() - tIndex;
  onEvent?.({ kind: "phase", phase: "done" });

  return { session, meta, telemetry, report, quali, driverNumbers, sizes, outDir, timings, entry };
}

export type IngestResult = Awaited<ReturnType<typeof runIngest>>;
