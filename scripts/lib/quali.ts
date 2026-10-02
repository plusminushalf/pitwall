// Qualifying on top of normalize() (which targets races): Q1/Q2/Q3 segments, lap attribution,
// deleted laps, eliminations, the classification, and per-lap telemetry aligned by distance so
// two drivers' laps can be overlaid (lapTraces.ts, shared with free practice). Pure: no file or
// network I/O.
//
// Mutates the normalized meta where race assumptions don't hold: lap 1 dating, lap starts/ends
// (chained through the official lap times, lapTraces.ts), lights out / chequered flag, track status
// (a flag per segment) and the grid (none).

import type { RawLap, RawPit, RawRaceControl, RawResult, RawSession } from "./openf1Types";
import { deletedLaps } from "./deletedLaps";
import { buildLapTraces, chainLapStarts, lerpAt, lineCrossings, median, quantile, timingLine } from "./lapTraces";
import type { CleanTelemetry, NormalizeResult } from "./normalize";
import type { DriverLapTraces, Lap, Ms, QualiData, QualiLap, QualiResult, QualiSegment, TrackStatusEvent } from "../../src/types";

export interface QualiInput {
  session: RawSession;
  laps: RawLap[];
  pits: RawPit[];
  raceControl: (RawRaceControl & { qualifying_phase?: number | null })[];
  results: RawResult[];
}

export interface QualiReport {
  lines: string[]; // summary for ingest's output
  problems: string[]; // things that look wrong (sanity check failures)
}

export interface QualiOutput {
  data: QualiData;
  traces: Map<number, DriverLapTraces>;
  report: QualiReport;
}

const PUSH_RATIO = 1.07; // the 107% rule: slower laps are cool-down / preparation laps
const PIT_SEGMENT = 2064; // mini-sector status: pit lane
const TIME_EPS = 0.0015; // s, matching official times

const fmtLap = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(3).padStart(6, "0")}`;

/**
 * Raw qualifying laps made safe for normalize(), before it runs. OpenF1 dates a pit-out lap at the
 * pit exit, but times it from the previous pit-lane crossing (garage time included): normalize's
 * race repairs trust start + duration, so they would re-date the next lap and split phantom laps.
 * Pit-out laps get no duration (it isn't a lap time), and an undated first out-lap starts at the
 * pit exit (normalize would date it at the first car's start, as if it were a race's lap 1).
 */
export function prepareQualiLaps(laps: RawLap[], pits: RawPit[]): RawLap[] {
  return laps.map((l) => {
    if (!l.is_pit_out_lap) return l;
    const exit = l.date_start ?? pits.find((p) => p.driver_number === l.driver_number && p.lap_number === l.lap_number)?.date ?? null;
    return { ...l, lap_duration: null, date_start: exit };
  });
}

export function buildQuali(raw: QualiInput, norm: NormalizeResult): QualiOutput {
  const { meta, telemetry } = norm;
  const t0 = Date.parse(meta.t0);
  const rel = (iso: string): Ms => Date.parse(iso) - t0;
  const lines: string[] = [];
  const problems: string[] = [];
  const prefix = /sprint/i.test(raw.session.session_name) ? "SQ" : "Q";

  // ---------------------------------------------------------------- segments

  const control = [...raw.raceControl].sort((a, b) => a.date.localeCompare(b.date));
  const isStart = (m: RawRaceControl) => m.category === "SessionStatus" && /STARTED/i.test(m.message);
  const isEnd = (m: RawRaceControl) =>
    (m.category === "SessionStatus" && /FINISHED/i.test(m.message)) || (m.flag === "CHEQUERED" && m.scope === "Track");
  const bounds: { start: Ms; end: Ms }[] = [];
  const phases = [...new Set(control.flatMap((m) => (m.qualifying_phase != null && m.qualifying_phase > 0 ? [m.qualifying_phase] : [])))].sort();
  if (phases.length) {
    // OpenF1 tags every message with its qualifying phase (a red-flag restart stays in its phase).
    for (const p of phases) {
      const ms = control.filter((m) => m.qualifying_phase === p);
      const start = ms.find(isStart);
      const end = ms.filter(isEnd).at(-1);
      if (start && end) bounds.push({ start: rel(start.date), end: rel(end.date) });
    }
  } else {
    // Fallback: a segment runs from the first start after the previous flag to the next flag.
    let from: Ms | null = null;
    for (const m of control) {
      if (from == null && isStart(m)) from = rel(m.date);
      else if (from != null && m.flag === "CHEQUERED") {
        bounds.push({ start: from, end: rel(m.date) });
        from = null;
      }
    }
  }
  if (bounds.length !== 3) problems.push(`found ${bounds.length} qualifying segments, expected 3`);

  const classified = raw.results.length;
  const q2Size = 10 + Math.ceil((classified - 10) / 2); // 20 cars: 15, 22 cars: 16
  const advances = bounds.length === 3 ? [q2Size, 10, null] : bounds.map((_, i) => (i === bounds.length - 1 ? null : null));
  const segments: QualiSegment[] = bounds.map((b, i) => ({
    number: i + 1,
    name: `${prefix}${i + 1}`,
    start: Math.round(b.start),
    end: Math.round(b.end),
    advance: advances[i] ?? null,
  }));

  // ---------------------------------------------------------------- track status: one flag per segment

  // normalize() stops at the first chequered flag (a race ends there); here every segment ends
  // with one, and red flags suspend a segment until it's restarted.
  const status: TrackStatusEvent[] = [{ t: 0, status: "GREEN" }];
  for (const seg of segments) {
    status.push({ t: seg.start, status: "GREEN" });
    let red = false;
    for (const m of meta.raceControl) {
      if (m.t <= seg.start || m.t >= seg.end) continue;
      const msg = m.message.toUpperCase();
      if (!red && (m.flag === "RED" || msg.startsWith("RED FLAG"))) {
        status.push({ t: m.t, status: "RED" });
        red = true;
      } else if (red && ((m.category === "SessionStatus" && /STARTED|RESUMED/.test(msg)) || (m.flag === "GREEN" && m.scope === "Track"))) {
        status.push({ t: m.t, status: "GREEN" });
        red = false;
      }
    }
    status.push({ t: seg.end, status: "CHEQUERED" });
  }
  meta.trackStatus = status.filter((e, i, arr) => e.t <= meta.duration && (i === 0 || arr[i - 1].status !== e.status));
  if (segments.length) {
    meta.lightsOut = segments[0].start;
    meta.chequered = segments.at(-1)!.end;
  }
  meta.grid = [];

  // ---------------------------------------------------------------- lap timing repairs

  const lapsOf = new Map<number, Lap[]>();
  for (const l of meta.laps) {
    if (!lapsOf.has(l.driver)) lapsOf.set(l.driver, []);
    lapsOf.get(l.driver)!.push(l);
  }
  for (const own of lapsOf.values()) own.sort((a, b) => a.lap - b.lap);

  // Pit-out laps start at the pit exit: normalize's late-start repair moves them back to the
  // previous pit-lane crossing (in a race the stop is part of the lap; here it's garage time).
  let pitExitStarts = 0;
  for (const [n, own] of lapsOf) {
    const exits = meta.pits.filter((p) => p.driver === n).map((p) => p.exit).sort((a, b) => a - b);
    own.forEach((l, i) => {
      if (!l.pitOut) return;
      const prev = own[i - 1];
      const next = own[i + 1];
      const from = prev ? (prev.end ?? prev.start) - 5_000 : -Infinity;
      const exit = exits.filter((e) => e >= from && (!next || e < next.start)).at(-1);
      if (exit != null && Math.abs(exit - l.start) > 1_000) {
        l.start = Math.round(exit);
        pitExitStarts++;
      }
    });
  }

  // Chain lap starts through the official lap durations within each run of consecutive laps, anchored on the
  // timing line (median car position at lap starts) and each car's crossings of it.
  const line = timingLine(meta.laps, telemetry);
  const { moves, brokenRuns } = chainLapStarts(lapsOf, (n) => lineCrossings(line, telemetry.get(n)?.loc));
  for (const own of lapsOf.values()) {
    // A pit-out lap (untimed, see prepareQualiLaps) ends where the next lap starts.
    own.forEach((l, i) => {
      const next = own[i + 1];
      if (l.pitOut) l.end = next && next.lap === l.lap + 1 ? next.start : null;
    });
  }
  meta.laps.sort((a, b) => a.start - b.start || a.driver - b.driver);
  for (const r of meta.results) {
    const last = lapsOf.get(r.driver)?.find((l) => l.lap === r.laps);
    if (r.finish != null && last?.end != null) r.finish = last.end;
  }
  lines.push(
    `lap starts chained through official lap times: ${moves.length} laps, moved median ${median(moves).toFixed(0)} ms, p95 ${quantile(moves, 0.95).toFixed(0)} ms, max ${Math.max(0, ...moves).toFixed(0)} ms` +
      (brokenRuns ? ` (${brokenRuns} runs left alone: durations don't chain)` : "") +
      (pitExitStarts ? `; ${pitExitStarts} out-laps re-dated to the pit exit` : ""),
  );

  // ---------------------------------------------------------------- deleted laps

  const { deleted: deletions, unmatched: unmatchedDeletions } = deletedLaps(meta.raceControl, lapsOf, meta.gmtOffset, t0);
  const deleted = new Map([...deletions].map(([key, d]) => [key, d.reason])); // `${driver}:${lap}` -> reason
  if (unmatchedDeletions) problems.push(`${unmatchedDeletions} deleted-lap messages matched no lap`);

  // ---------------------------------------------------------------- lap attribution

  const segmentAt = (t: Ms): { segment: number | null; afterFlag: boolean } => {
    for (let i = segments.length - 1; i >= 0; i--) {
      const s = segments[i];
      if (t >= s.start - 2_000) return { segment: s.number, afterFlag: t > s.end };
    }
    return { segment: null, afterFlag: false };
  };
  const timed = meta.laps.filter((l) => l.duration != null && !l.pitOut).map((l) => l.duration!);
  const fastest = Math.min(...timed);
  const carOf = (n: number): CleanTelemetry["car"] | null => telemetry.get(n)?.car ?? null;
  function speedAt(n: number, t: Ms): number | null {
    const car = carOf(n);
    if (!car || !car.t.length) return null;
    return lerpAt(car.t, car.speed, t);
  }
  const isInLap = (l: Lap, next: Lap | undefined) =>
    (next != null && next.lap === l.lap + 1 && next.pitOut) ||
    l.segments[2].some((c) => c === PIT_SEGMENT) ||
    (next == null && l.end != null && (speedAt(l.driver, l.end) ?? 999) < 120);

  const qualiLaps: QualiLap[] = [];
  const qlap = new Map<string, QualiLap>();
  for (const [n, own] of lapsOf) {
    own.forEach((l, i) => {
      const { segment, afterFlag } = segmentAt(l.start);
      const kind: QualiLap["kind"] = l.pitOut
        ? "out"
        : isInLap(l, own[i + 1])
          ? "in"
          : l.duration != null && l.duration <= PUSH_RATIO * fastest
            ? "push"
            : "cool";
      const q: QualiLap = { driver: n, lap: l.lap, segment, afterFlag, kind, deleted: deleted.get(`${n}:${l.lap}`) ?? null, best: false, trace: false };
      qualiLaps.push(q);
      qlap.set(`${n}:${l.lap}`, q);
    });
  }

  // ---------------------------------------------------------------- classification

  const results: QualiResult[] = [...raw.results]
    .sort((a, b) => (a.position ?? 99) - (b.position ?? 99))
    .map((r) => {
      const n = r.driver_number;
      const official = (Array.isArray(r.duration) ? r.duration : [r.duration]).slice(0, segments.length);
      while (official.length < segments.length) official.push(null);
      const own = lapsOf.get(n) ?? [];
      const counting = (seg: number) =>
        own.filter((l) => {
          const q = qlap.get(`${n}:${l.lap}`)!;
          return l.duration != null && q.segment === seg && !q.afterFlag && !q.deleted && q.kind !== "out" && q.kind !== "in";
        });
      const laps = segments.map((s, k) => {
        const time = official[k];
        const mine = counting(s.number).sort((a, b) => a.duration! - b.duration!)[0] ?? null;
        if (time == null) {
          if (mine) problems.push(`#${n} ${s.name}: lap ${mine.lap} (${fmtLap(mine.duration!)}) counts here but there's no official time`);
          return null;
        }
        if (mine && Math.abs(mine.duration! - time) < TIME_EPS) return mine.lap;
        // Not what we computed: find the lap that did set the official time.
        const match = own.find((l) => l.duration != null && Math.abs(l.duration - time) < TIME_EPS);
        problems.push(
          `#${n} ${s.name}: official ${fmtLap(time)} but computed ${mine ? `${fmtLap(mine.duration!)} (lap ${mine.lap})` : "none"}` +
            (match ? `; official time is lap ${match.lap} (${qlap.get(`${n}:${match.lap}`)?.segment ? `${prefix}${qlap.get(`${n}:${match.lap}`)!.segment}` : "no segment"}${qlap.get(`${n}:${match.lap}`)?.deleted ? ", deleted" : ""})` : ""),
        );
        return match?.lap ?? null;
      });
      laps.forEach((lap, k) => {
        const q = lap != null ? qlap.get(`${n}:${lap}`) : null;
        if (q && q.segment === k + 1) q.best = true;
      });
      const pos = r.position;
      const eliminated =
        segments.length !== 3 ? null : pos == null || pos > (segments[0].advance ?? Infinity) ? 1 : pos > (segments[1].advance ?? Infinity) ? 2 : null;
      if (eliminated != null && official.slice(eliminated).some((t) => t != null)) {
        problems.push(`#${n} P${pos} is knocked out in ${prefix}${eliminated} but has a later segment time`);
      }
      return { driver: n, position: pos, times: official.map((t) => (typeof t === "number" ? t : null)), laps, eliminated };
    });

  // ---------------------------------------------------------------- distance-aligned traces

  // Push and cool-down laps, measured on the push laps.
  const lapByKey = new Map(meta.laps.map((l) => [`${l.driver}:${l.lap}`, l]));
  const traceable = qualiLaps.filter((q) => q.kind === "push" || q.kind === "cool").map((q) => lapByKey.get(`${q.driver}:${q.lap}`)!);
  const built = buildLapTraces(traceable, (l) => qlap.get(`${l.driver}:${l.lap}`)!.kind === "push", telemetry, meta.track);
  problems.push(...built.problems);
  for (const key of built.traced) qlap.get(key)!.trace = true;
  const { traces, lapLength, sectorDistances } = built;

  lines.push(
    `segments: ${segments.map((s) => `${s.name} +${Math.round(s.start / 1000)}s..+${Math.round(s.end / 1000)}s${s.advance ? ` (top ${s.advance} through)` : ""}`).join(", ")}`,
  );
  lines.push(
    `laps: ${qualiLaps.length} (${qualiLaps.filter((q) => q.kind === "push").length} push, ${qualiLaps.filter((q) => q.kind === "cool").length} cool, ${qualiLaps.filter((q) => q.kind === "out").length} out, ${qualiLaps.filter((q) => q.kind === "in").length} in), ${deleted.size} deleted by race control`,
  );
  lines.push(...built.lines);
  const eliminatedIn = (k: number) => results.filter((r) => r.eliminated === k).length;
  if (segments.length === 3) {
    lines.push(`eliminated: ${eliminatedIn(1)} in ${prefix}1, ${eliminatedIn(2)} in ${prefix}2, ${results.filter((r) => r.eliminated == null).length} in ${prefix}3`);
  }

  const data: QualiData = { segments, laps: qualiLaps, results, lapLength: Math.round(lapLength * 10) / 10, sectorDistances: [Math.round(sectorDistances[0] * 10) / 10, Math.round(sectorDistances[1] * 10) / 10] };
  meta.quali = data;
  return { data, traces, report: { lines, problems } };
}
