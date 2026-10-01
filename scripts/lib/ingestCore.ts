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
// limit), started in a fixed order: sessions, then meeting (and the circuit map as soon as the meeting says where
// it is), drivers and the other session files, then the telemetry, in time slices of every car (slices.ts) planned
// from the laps and race control (and, qualifying, the pit stops): a short first slice at the playhead right after
// them, then the other session files (positions, intervals and stints first: a replay needs them to start), then
// slice after slice from wherever the session is being watched (IngestIO.playhead), so a race can be watched while
// it downloads (the worker streams it, src/ingest/stream.ts). Downloads begun before slices carry on with one
// car_data / location file per driver, once the drivers are known. A failure stops new requests; the ones in flight
// finish and are cached, so the next run resumes from there. The processed output doesn't depend on the order
// responses arrive in, nor on the layout: slices are split back into each driver's records, in time order.

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
import { encodeTelemetry, normalize, replayWindow, type RawSessionData } from "./normalize";
import { buildQuali, prepareQualiLaps } from "./quali";
import { readCache, writeCache, type RawCacheIO } from "./rawCache";
import {
  isPerDriverFile,
  SECOND_SLICE_UNITS,
  SLICE_MAX_UNITS,
  parseSliceFile,
  sliceFile,
  sliceParams,
  SlicePlan,
  telemetrySpan,
  type SlicePart,
  type Span,
} from "./slices";

export { FORMAT_VERSION } from "./formatVersion";

export interface IngestIO extends RawCacheIO {
  fetchEndpoint<T>(endpoint: string, params: Record<string, string | number>): Promise<T[]>;
  /** Requests (and cache reads) at once. Default 1: one after the other. Read as it goes (it may change). */
  concurrency?: number | (() => number);
  fetchCircuit(url: string): Promise<RawCircuit>;
  /**
   * Names of the raw files already stored for this session (without `.json.gz`), so a race downloaded in slices
   * resumes from the ones it has. Without it, only fixed names are looked up (readFile).
   */
  rawFiles?(rawDir: string): Promise<string[]>;
  /** Where the race is being watched (absolute ms), if it is: its telemetry slices are fetched from there on. */
  playhead?(): number | null;
  /**
   * Resolves when a request could start (the rate limiter's pace), with `reserve` of the minute's requests left for
   * others: the next slice is picked then, not before.
   */
  whenReady?(reserve?: number): Promise<void>;
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

/** A finished session's replay window (normalize.ts replayWindow), absolute ms. */
export interface ReplayWindow {
  lightsOut: number;
  t0: number;
  end: number;
}

export type IngestEvent =
  /**
   * A raw file is in memory: read from the cache, or downloaded (its cache write may still be running). `data` is
   * the parsed response (records; the circuit map's object), not to be changed.
   */
  | { kind: "raw"; name: string; source: "cache" | "network"; ms: number; data: unknown }
  /** The session's driver numbers, in the order their car_data / location files are requested. */
  | { kind: "drivers"; numbers: number[] }
  /** A race's telemetry comes in slices (slices.ts): its replay window, the span downloaded, the parts stored. */
  | { kind: "plan"; window: ReplayWindow; span: Span; stored: SlicePart[] }
  | { kind: "phase"; phase: "download" | "normalize" | "write" | "done" };

const now = () => performance.now();
/** How often the urgent lane looks at the playhead, and the requests of each minute kept for it (a slice is two). */
const URGENT_POLL_MS = 250;
const URGENT_RESERVE = 2;

/** Thrown into the requests still queued once one has failed: they never start. */
class Stopped extends Error {}

/**
 * At most `limit` tasks at once, started in submission order (`front`: before the queued ones; `now`: at once, over
 * the limit if need be).
 */
function limiter(limit: () => number) {
  let active = 0;
  const queue: (() => void)[] = [];
  let stopped = false;
  const next = () => {
    while (active < limit() && queue.length) queue.shift()!();
  };
  function run<T>(task: () => Promise<T>, front = false, now = false): Promise<T> {
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
      if (now) return start();
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
      onEvent?.({ kind: "raw", name, source: "cache", ms: now() - t0, data: hit });
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
    onEvent?.({ kind: "raw", name, source: "network", ms: t2 - t1, data });
    return data;
  }

  function endpoint<T>(name: string, ep: string, params: Record<string, string | number>): Promise<T[]> {
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
  const concurrency = () => Math.max(1, Math.floor((typeof io.concurrency === "function" ? io.concurrency() : io.concurrency) ?? 1));
  const limit = limiter(concurrency);
  const tasks: Promise<unknown>[] = [];
  let failure: { error: unknown } | null = null;
  function task<T>(fn: () => Promise<T>, front = false, now = false): Promise<T> {
    const p = limit.run(fn, front, now);
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
  const isQuali = session.session_type === "Qualifying";
  const stored = (await io.rawFiles?.(rawDir)) ?? [];
  // In slices, unless a download from before slices left per-driver files to resume from.
  const sliced = !stored.some(isPerDriverFile);

  // Sliced, the session files after laps and race control (which plan the slices) wait for the first slice.
  let releaseRest = () => {};
  const rest = sliced ? new Promise<void>((resolve) => (releaseRest = resolve)) : null;
  function doc<T>(name: string): Promise<T[]> {
    if (!rest) return task(() => get<T>(name));
    const p = rest.then(() => task(() => get<T>(name)));
    tasks.push(p.catch(() => {}));
    return p;
  }

  const meetingP = task(() => endpoint<RawMeeting>("meeting", "meetings", { meeting_key: session.meeting_key }));
  // The circuit map as soon as the meeting says where it is.
  const circuitP = meetingP.then(([meeting]) => circuitInfo(meeting));
  const driversP = task(() => get<RawDriver>("drivers"));
  const lapsP = task(() => get<RawLap>("laps"));
  let stintsP: Promise<RawStint[]>, pitsP: Promise<RawPit[]>, positionsP: Promise<RawPosition[]>, intervalsP: Promise<RawInterval[]>;
  let raceControlP: Promise<RawRaceControl[]>;
  if (sliced) {
    raceControlP = task(() => get<RawRaceControl>("race_control"));
    positionsP = doc<RawPosition>("position");
    intervalsP = doc<RawInterval>("intervals");
    stintsP = doc<RawStint>("stints");
    // Qualifying's window comes from its laps as prepared with the pit stops (quali.ts): before the first slice.
    pitsP = isQuali ? task(() => get<RawPit>("pit")) : doc<RawPit>("pit");
  } else {
    stintsP = task(() => get<RawStint>("stints"));
    pitsP = task(() => get<RawPit>("pit"));
    positionsP = task(() => get<RawPosition>("position"));
    intervalsP = task(() => get<RawInterval>("intervals"));
    raceControlP = task(() => get<RawRaceControl>("race_control"));
  }
  const resultsP = sliced ? doc<RawResult>("session_result") : null;
  const weatherP = doc<RawWeather>("weather");
  const radioP = doc<RawRadio>("team_radio");
  const overtakesP = doc<RawOvertake>("overtakes");
  const resultsLastP = resultsP ?? task(() => get<RawResult>("session_result"));

  const driverNumbersP = driversP.then((drivers) => {
    const numbers = [...new Set(drivers.map((d) => d.driver_number))].sort((a, b) => a - b);
    onEvent?.({ kind: "drivers", numbers });
    return numbers;
  });
  driverNumbersP.catch(() => {});

  // Per driver, once the drivers are known: queued behind the session files.
  const perDriverP = sliced
    ? null
    : driverNumbersP.then((numbers) =>
        numbers.map((n) => ({ n, car: task(() => get<RawCarData>("car_data", { driver_number: n })), loc: task(() => get<RawLocation>("location", { driver_number: n })) })),
      );
  perDriverP?.catch(() => {});

  // In slices, once the laps and race control give the replay window.
  const partRecords = new Map<string, { part: SlicePart; records: Promise<unknown[]> }>();
  let plan = null as SlicePlan | null;
  const slicesP = sliced
    ? (async () => {
        try {
          const [laps, raceControl] = await Promise.all([lapsP, raceControlP]);
          const window = replayWindow({ session, laps: isQuali ? prepareQualiLaps(laps, await pitsP) : laps, raceControl });
          if (!Number.isFinite(window.t0) || !Number.isFinite(window.end)) throw new Error(`Session ${sessionKey} has no timed laps`);
          const span = telemetrySpan(window);
          const storedParts = stored.flatMap((name) => parseSliceFile(name) ?? []);
          const p = (plan = new SlicePlan(span, storedParts));
          onEvent?.({ kind: "plan", window, span, stored: storedParts });
          const playhead = () => io.playhead?.() ?? window.lightsOut - 10_000;
          // Someone is watching (a jump is urgent only then).
          const watched = () => io.playhead?.() != null;
          const load = (part: SlicePart, urgent = false) => {
            const name = sliceFile(part);
            const records = task(() => endpoint<unknown>(name, part.endpoint, sliceParams(sessionKey, part.span)), false, urgent);
            partRecords.set(name, { part, records });
            records.then(
              () => p.stored(part),
              () => p.release(part),
            );
            return records;
          };
          // What an earlier run stored, nearest the playhead first; then the first slice, the session files left, and
          // slice after slice (one per request slot), each from wherever the replay is by then.
          const at = playhead();
          const order = (s: SlicePart) => (s.span.to > at ? s.span.from - at : at - s.span.from + 1e12);
          const reads = [...storedParts].filter((s) => s.span.from < span.to && s.span.to > span.from).sort((a, b) => order(a) - order(b)).map((part) => load(part));
          const first = p.next(at).map((part) => load(part));
          releaseRest();
          await rest; // the session files queue up first
          // A slice is picked when it can be requested, so a jump while requests wait for the rate limit still counts.
          // One lane per two requests in flight (a slice is two): no slice waits in the queue, picked long before its
          // turn. The first after the start is short too (10 minutes, ~2 s to answer), while the replay begins.
          let picks = 0;
          const lane = async () => {
            for (;;) {
              // (Leaving some of the minute's requests for a jump, and standing aside while one waits: see urgent.)
              await io.whenReady?.(URGENT_RESERVE);
              if (watched() && p.waiting(playhead())) {
                await new Promise((r) => setTimeout(r, URGENT_POLL_MS));
                continue;
              }
              const next = p.next(playhead(), picks++ === 0 ? SECOND_SLICE_UNITS : SLICE_MAX_UNITS);
              if (!next.length) return;
              await Promise.all(next.map((part) => load(part)));
            }
          };
          const lanes = Array.from({ length: Math.max(1, Math.floor(concurrency() / 2)) }, lane);
          // A jump to where nothing is in yet doesn't wait for a lane, nor for a long slice on its way: a short slice
          // there, right away.
          const urgent = async () => {
            while (!p.done() && !failure) {
              if (watched() && p.waiting(playhead())) {
                await io.whenReady?.();
                const next = p.urgent(playhead());
                if (next.length) {
                  // (Not behind the requests in flight: the rate limiter still paces it.)
                  await Promise.all(next.map((part) => load(part, true)));
                  continue;
                }
              }
              await new Promise((r) => setTimeout(r, URGENT_POLL_MS));
            }
          };
          await Promise.all([...reads, ...first, ...lanes, urgent()]);
        } finally {
          releaseRest();
        }
      })()
    : null;
  // (A failure planning them, not a request's: as a request's would, it stops the rest.)
  slicesP?.catch((error) => {
    if (error instanceof Stopped) return;
    failure ??= { error };
    limit.stop();
  });
  tasks.push(circuitP.catch(() => {}), driverNumbersP.catch(() => {}), (perDriverP ?? slicesP)!.catch(() => {}));

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
  const rawResults = await resultsLastP;
  const driverNumbers = await driverNumbersP;
  // In driver order, whatever order they arrived in (normalize iterates these maps).
  const rawCar = new Map<number, RawCarData[]>();
  const rawLoc = new Map<number, RawLocation[]>();
  if (perDriverP) {
    for (const d of await perDriverP) {
      rawCar.set(d.n, await d.car);
      rawLoc.set(d.n, await d.loc);
    }
  } else {
    if (!plan?.done()) throw new Error(`Session ${sessionKey}: telemetry incomplete`);
    // Each driver's records from the slices, in time order (as one request per driver returns them).
    for (const n of driverNumbers) {
      rawCar.set(n, []);
      rawLoc.set(n, []);
    }
    const parts = [...partRecords.values()].sort((a, b) => a.part.span.from - b.part.span.from);
    for (const { part, records } of parts) {
      const out = part.endpoint === "car_data" ? rawCar : rawLoc;
      for (const r of (await records) as { driver_number: number }[]) out.get(r.driver_number)?.push(r as never);
    }
  }

  await Promise.all(pendingWrites);
  rethrowWriteError();

  // ---------------------------------------------------------------- process

  onEvent?.({ kind: "phase", phase: "normalize" });
  const tNorm = now();
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
