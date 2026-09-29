// Qualifying on top of normalize() (which targets races): Q1/Q2/Q3 segments, lap attribution,
// deleted laps, eliminations, the classification, and per-lap telemetry aligned by distance so
// two drivers' laps can be overlaid. Pure: no file or network I/O.
//
// Distance alignment. Each full lap (timing line to timing line) gets a distance per car sample:
//   1. Lap starts. OpenF1's `date_start` jitters by up to ~1 s, but lap durations are exact official
//      times, so within a run of consecutive laps each start is the run's anchor plus the preceding
//      durations; the anchor is the median of the laps' own starts and their GPS timing-line
//      crossings (each shifted back by the preceding durations).
//   2. Distance comes from integrating the speed trace (smooth, and immune to location-feed gaps),
//      normalized piecewise between four anchors whose times are exact: the line (0), the sector 2
//      and 3 boundaries (from the official sector times) and the line again (the lap length). The
//      anchor distances are session constants: medians over all push laps.
//   3. The location trace is only used for the car's position, and to validate step 2: GPS positions
//      projected onto the track outline are compared with the aligned distance (see the report).
// Mutates the normalized meta where race assumptions don't hold: lap 1 dating, lap starts/ends,
// lights out / chequered flag, track status (a flag per segment) and the grid (none).

import type { RawLap, RawPit, RawRaceControl, RawResult, RawSession } from "./openf1Types";
import type { CleanTelemetry, NormalizeResult } from "./normalize";
import type {
  DriverLapTraces,
  Lap,
  LapTrace,
  Ms,
  QualiData,
  QualiLap,
  QualiResult,
  QualiSegment,
  TrackStatusEvent,
} from "../../src/types";

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
const GAP_MS = 1_500; // car data missing between two samples this far apart
const TRACE_MAX_GAP_MS = 8_000; // no trace for laps with a longer car-data gap...
const MAX_GAP_SHARE = 0.15; // ...or with more of the lap missing than this
const FROZEN_MS = 1_000; // identical samples for this long while moving: a stuck feed
const FROZEN_MIN_SPEED = 50; // km/h
const PIT_SEGMENT = 2064; // mini-sector status: pit lane
const TIME_EPS = 0.0015; // s, matching official times

const median = (xs: number[]) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const quantile = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * s.length)))] ?? NaN;
};
const encodeDeltas = (xs: number[]) => xs.map((x, i) => (i === 0 ? x : x - xs[i - 1]));

/** Index of the last element <= t in ascending `xs`, or -1. */
function lastAtOrBefore(xs: ArrayLike<number>, t: number): number {
  let lo = 0;
  let hi = xs.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

/** Linear interpolation of ys over ascending xs at x (clamped to the ends). */
function lerpAt(xs: ArrayLike<number>, ys: ArrayLike<number>, x: number): number {
  const n = xs.length;
  if (!n) return NaN;
  const i = lastAtOrBefore(xs, x);
  if (i < 0) return ys[0];
  if (i >= n - 1) return ys[n - 1];
  const span = xs[i + 1] - xs[i];
  return span > 0 ? ys[i] + ((x - xs[i]) / span) * (ys[i + 1] - ys[i]) : ys[i];
}

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

  // The timing line (median car position at lap starts) and each car's crossings of it.
  const locOf = (n: number) => telemetry.get(n)?.loc;
  function locAt(n: number, t: Ms): { x: number; y: number; dx: number; dy: number } | null {
    const loc = locOf(n);
    if (!loc || loc.t.length < 2) return null;
    const i = lastAtOrBefore(loc.t, t);
    if (i < 0 || i >= loc.t.length - 1 || loc.t[i + 1] - loc.t[i] > 1_500) return null;
    const f = (t - loc.t[i]) / (loc.t[i + 1] - loc.t[i]);
    const dx = loc.x[i + 1] - loc.x[i];
    const dy = loc.y[i + 1] - loc.y[i];
    return { x: loc.x[i] + f * dx, y: loc.y[i] + f * dy, dx, dy };
  }
  const lineXs: number[] = [];
  const lineYs: number[] = [];
  let hx = 0;
  let hy = 0;
  for (const l of meta.laps) {
    if (l.lap < 2 || l.pitOut) continue;
    const p = locAt(l.driver, l.start);
    if (!p) continue;
    lineXs.push(p.x);
    lineYs.push(p.y);
    const len = Math.hypot(p.dx, p.dy);
    if (len > 0) {
      hx += p.dx / len;
      hy += p.dy / len;
    }
  }
  const hl = Math.hypot(hx, hy);
  const line = lineXs.length >= 20 && hl > 0 ? { x: median(lineXs), y: median(lineYs), ux: hx / hl, uy: hy / hl } : null;
  function crossings(n: number): Ms[] {
    const loc = locOf(n);
    if (!line || !loc) return [];
    const out: Ms[] = [];
    for (let i = 1; i < loc.t.length; i++) {
      const a = (loc.x[i - 1] - line.x) * line.ux + (loc.y[i - 1] - line.y) * line.uy;
      const b = (loc.x[i] - line.x) * line.ux + (loc.y[i] - line.y) * line.uy;
      if (!(a < 0 && b >= 0) || b - a > 1_500 || loc.t[i] - loc.t[i - 1] > 1_500) continue;
      const f = -a / (b - a);
      const off = -(loc.x[i - 1] + f * (loc.x[i] - loc.x[i - 1]) - line.x) * line.uy + (loc.y[i - 1] + f * (loc.y[i] - loc.y[i - 1]) - line.y) * line.ux;
      if (Math.abs(off) < 300) out.push(loc.t[i - 1] + f * (loc.t[i] - loc.t[i - 1])); // main straight only (not the pit lane)
    }
    return out;
  }

  // Chain lap starts through the official lap durations within each run of consecutive laps.
  const moves: number[] = [];
  let brokenRuns = 0;
  for (const [n, own] of lapsOf) {
    const cross = crossings(n);
    const runs: Lap[][] = [];
    let run: Lap[] = [];
    for (const l of own) {
      const prev = run.at(-1);
      if (prev && l.lap === prev.lap + 1 && prev.duration != null && !prev.pitOut && !l.pitOut) run.push(l);
      else {
        if (run.length) runs.push(run);
        run = [l];
      }
    }
    if (run.length) runs.push(run);
    for (const r of runs) {
      if (r[0].pitOut) continue; // a lone out-lap: starts at the pit exit, nothing to chain
      const cum: number[] = [];
      let acc = 0;
      for (const l of r) {
        cum.push(acc);
        acc += (l.duration ?? 0) * 1000;
      }
      const votes: number[] = [];
      r.forEach((l, i) => {
        votes.push(l.start - cum[i]);
        const c = cross.find((c) => Math.abs(c - l.start) < 1_500);
        if (c != null) votes.push(c - cum[i]);
      });
      const anchor = median(votes);
      // Durations that don't chain (a lost record in between) leave the run alone.
      if (r.some((l, i) => Math.abs(l.start - (anchor + cum[i])) > 2_500)) {
        brokenRuns++;
        continue;
      }
      r.forEach((l, i) => {
        const start = Math.round(anchor + cum[i]);
        moves.push(Math.abs(start - l.start));
        l.start = start;
        if (l.duration != null) l.end = start + Math.round(l.duration * 1000);
      });
    }
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

  // "CAR 30 (LAW) TIME 2:00.207 DELETED - DOUBLE YELLOW AT TURN 7 LAP 3 16:07:45"
  // "CAR 18 (STR) LAP DELETED - TRACK LIMITS AT TURN 7 LAP 3 16:07:34 (PIT)"
  const DELETED = /^CAR (\d+)\b.*?\b(?:TIME (\d+:\d{2}\.\d{3}) DELETED|LAP DELETED) - (.+?) LAP (\d+) (\d{1,2}):(\d{2}):(\d{2})/;
  const REINSTATED = /^CAR (\d+)\b.*?\b(?:TIME (\d+:\d{2}\.\d{3}) )?(?:LAP )?(?:TIME )?REINSTATED/;
  const [oh, om] = meta.gmtOffset.replace("-", "").split(":").map(Number);
  const offsetMs = (meta.gmtOffset.startsWith("-") ? -1 : 1) * ((oh || 0) * 60 + (om || 0)) * 60_000;
  const parseTime = (s: string) => {
    const [m, sec] = s.split(":");
    return Number(m) * 60 + Number(sec);
  };
  /** Local wall-clock time of an incident -> ms since t0, on the day that puts it just before `issued`. */
  function incidentTime(issued: Ms, h: number, m: number, s: number): Ms {
    const local = new Date(t0 + issued + offsetMs);
    const day = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
    let t = day + ((h * 60 + m) * 60 + s) * 1000 - offsetMs - t0;
    if (t > issued + 60_000) t -= 86_400_000;
    return t;
  }
  const deleted = new Map<string, string>(); // `${driver}:${lap}` -> reason
  let unmatchedDeletions = 0;
  for (const m of meta.raceControl) {
    const msg = m.message.toUpperCase();
    const del = msg.match(DELETED);
    if (del) {
      const n = Number(del[1]);
      const own = lapsOf.get(n) ?? [];
      const time = del[2] ? parseTime(del[2]) : null;
      const at = incidentTime(m.t, Number(del[5]), Number(del[6]), Number(del[7]));
      const byTime = time != null ? own.filter((l) => l.duration != null && Math.abs(l.duration - time) < TIME_EPS) : [];
      const during = (l: Lap) => l.start - 1_000 <= at && at <= (l.end ?? l.start + 200_000) + 1_000;
      const lap = (byTime.length === 1 ? byTime[0] : null) ?? byTime.find(during) ?? own.find(during) ?? own.find((l) => l.lap === Number(del[4]));
      if (lap) deleted.set(`${n}:${lap.lap}`, del[3].trim());
      else unmatchedDeletions++;
      continue;
    }
    const back = msg.match(REINSTATED);
    if (back) {
      const n = Number(back[1]);
      const time = back[2] ? parseTime(back[2]) : null;
      const lap = (lapsOf.get(n) ?? []).find((l) => deleted.has(`${n}:${l.lap}`) && (time == null || (l.duration != null && Math.abs(l.duration - time) < TIME_EPS)));
      if (lap) deleted.delete(`${n}:${lap.lap}`);
    }
  }
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

  // OpenF1's car-data feed sometimes sticks: every channel repeats for seconds while the car moves
  // (2026 Monza: 307 km/h, 7th gear, full throttle straight through the first chicane). Such samples
  // are dropped, and the gap they leave is bridged below.
  const frozenCache = new Map<number, Uint8Array>();
  function frozenOf(n: number): Uint8Array {
    let mask = frozenCache.get(n);
    if (mask) return mask;
    const c = carOf(n)!;
    mask = new Uint8Array(c.t.length);
    const same = (a: number, b: number) =>
      c.speed[a] === c.speed[b] && c.rpm[a] === c.rpm[b] && c.gear[a] === c.gear[b] && c.throttle[a] === c.throttle[b] && c.brake[a] === c.brake[b];
    for (let i = 0; i < c.t.length; ) {
      let j = i;
      while (j + 1 < c.t.length && same(j + 1, i)) j++;
      if (c.speed[i] > FROZEN_MIN_SPEED && c.t[j] - c.t[i] >= FROZEN_MS) for (let k = i + 1; k <= j; k++) mask[k] = 1;
      i = j + 1;
    }
    frozenCache.set(n, mask);
    return mask;
  }

  interface Integrated {
    t: number[]; // ms since t0: the lap's good car samples, plus exact samples on the line at both ends
    v: number[]; // km/h
    gap: boolean[]; // gap[k]: no car data between samples k - 1 and k (dropout or frozen feed)
    D: number[]; // m, integrated from the speed trace (gaps bridged at the mean of their ends)
  }
  /** The lap's samples from line to line with integrated distance, or null if too much is missing. */
  function integrate(l: Lap): Integrated | null {
    const car = carOf(l.driver);
    if (!car || l.end == null || car.t.length < 3) return null;
    const frozen = frozenOf(l.driver);
    let before = lastAtOrBefore(car.t, l.start);
    while (before >= 0 && frozen[before]) before--;
    if (before < 0) return null;
    const inside: number[] = [];
    let after = -1;
    for (let i = before + 1; i < car.t.length; i++) {
      if (frozen[i]) continue;
      if (car.t[i] >= l.end) {
        after = i;
        break;
      }
      inside.push(i);
    }
    if (after < 0 || !inside.length) return null;
    const vAt = (t: number, a: number, b: number) => car.speed[a] + ((t - car.t[a]) / (car.t[b] - car.t[a] || 1)) * (car.speed[b] - car.speed[a]);
    const t = [l.start, ...inside.map((i) => car.t[i]), l.end];
    const v = [vAt(l.start, before, inside[0]), ...inside.map((i) => car.speed[i]), vAt(l.end, inside.at(-1)!, after)];
    const gap = t.map((x, k) => k > 0 && x - t[k - 1] > GAP_MS);
    // Around the line the neighbouring samples count too.
    const edgeGaps = [inside[0], after].map((i, k) => car.t[i] - car.t[k === 0 ? before : inside.at(-1)!]);
    let gapTime = 0;
    for (let k = 1; k < t.length; k++) {
      const dt = t[k] - t[k - 1];
      if (dt > TRACE_MAX_GAP_MS) return null;
      if (gap[k]) gapTime += dt;
    }
    if (Math.max(...edgeGaps) > TRACE_MAX_GAP_MS || gapTime > MAX_GAP_SHARE * (l.end - l.start)) return null;
    const D = [0];
    for (let k = 1; k < t.length; k++) D.push(D[k - 1] + (((v[k - 1] + v[k]) / 2 / 3.6) * (t[k] - t[k - 1])) / 1000);
    return { t, v, gap, D };
  }

  /**
   * Distance per sample, pinned at the anchors (time, distance). Between two anchors the integrated
   * distance is scaled to fit; if data is missing there, the good samples keep their integrated
   * distance and the gaps get the rest (unless that's implausible: then everything is scaled).
   */
  function align(it: Integrated, anchors: [number, number][]): { t: number[]; v: number[]; d: number[] } {
    // Samples with the (sector) anchors inserted, so every increment lies between two anchors.
    const tt: number[] = [];
    const vv: number[] = [];
    const gg: boolean[] = [];
    let a = 1;
    for (let k = 0; k < it.t.length; k++) {
      while (a < anchors.length - 1 && anchors[a][0] < it.t[k]) {
        const ta = anchors[a][0];
        if (k > 0 && ta > it.t[k - 1]) {
          const f = (ta - it.t[k - 1]) / (it.t[k] - it.t[k - 1]);
          tt.push(ta);
          vv.push(it.v[k - 1] + f * (it.v[k] - it.v[k - 1]));
          gg.push(it.gap[k]);
        }
        a++;
      }
      tt.push(it.t[k]);
      vv.push(it.v[k]);
      gg.push(it.gap[k]);
    }
    const inc = tt.map((t, k) => (k === 0 ? 0 : (((vv[k - 1] + vv[k]) / 2 / 3.6) * (t - tt[k - 1])) / 1000));
    const anchorIdx = anchors.map(([ta]) => {
      let best = 0;
      for (let k = 0; k < tt.length; k++) if (Math.abs(tt[k] - ta) < Math.abs(tt[best] - ta)) best = k;
      return best;
    });
    const out = new Array<number>(tt.length).fill(0);
    for (let j = 0; j + 1 < anchors.length; j++) {
      const [from, to] = [anchorIdx[j], anchorIdx[j + 1]];
      const span = anchors[j + 1][1] - anchors[j][1];
      let good = 0;
      let missing = 0;
      for (let k = from + 1; k <= to; k++) (gg[k] ? (missing += inc[k]) : (good += inc[k]));
      let goodScale = good + missing > 0 ? span / (good + missing) : 0;
      let gapScale = goodScale;
      if (missing > 0 && good < span && (span - good) / missing >= 0.25 && (span - good) / missing <= 2.5) {
        goodScale = 1;
        gapScale = (span - good) / missing;
        filledGaps++;
      }
      out[from] = anchors[j][1];
      for (let k = from + 1; k <= to; k++) out[k] = out[k - 1] + inc[k] * (gg[k] ? gapScale : goodScale);
    }
    // The sector-line samples stay in the trace: they pin the distance where the times are exact.
    return { t: tt, v: vv, d: out };
  }

  const traceable = qualiLaps.filter((q) => q.kind === "push" || q.kind === "cool");
  const integrated = new Map<string, Integrated>();
  const lapByKey = new Map(meta.laps.map((l) => [`${l.driver}:${l.lap}`, l]));
  let dropouts = 0;
  let filledGaps = 0;
  for (const q of traceable) {
    const l = lapByKey.get(`${q.driver}:${q.lap}`)!;
    if (l.duration == null || l.end == null) continue;
    const it = integrate(l);
    if (it) integrated.set(`${q.driver}:${q.lap}`, it);
    else dropouts++;
  }
  const frozenSamples = [...frozenCache.values()].reduce((s, m) => s + m.reduce((a, b) => a + b, 0), 0);

  // Session constants from complete push laps: lap length and where the sector boundaries are.
  const lengths: number[] = [];
  const f1s: number[] = [];
  const f2s: number[] = [];
  const sectorTimes = (l: Lap): [number | null, number | null] => {
    const [s1, s2] = l.sectors;
    const a = s1 != null ? l.start + s1 * 1000 : null;
    const b = s1 != null && s2 != null ? l.start + (s1 + s2) * 1000 : null;
    return [a != null && a < l.end! ? a : null, b != null && b < l.end! ? b : null];
  };
  for (const [key, it] of integrated) {
    if (qlap.get(key)!.kind !== "push" || it.gap.some(Boolean)) continue;
    const l = lapByKey.get(key)!;
    const total = it.D.at(-1)!;
    lengths.push(total);
    const [a, b] = sectorTimes(l);
    if (a != null) f1s.push(lerpAt(it.t, it.D, a) / total);
    if (b != null) f2s.push(lerpAt(it.t, it.D, b) / total);
  }
  const lapLength = median(lengths);
  const sectorDistances: [number, number] = [median(f1s) * lapLength, median(f2s) * lapLength];
  if (!Number.isFinite(lapLength)) problems.push("no push laps to measure the lap length");

  const traces = new Map<number, DriverLapTraces>();
  const spread: number[] = []; // integrated lap distance / lap length - 1 (complete laps)
  for (const [key, it] of integrated) {
    if (!Number.isFinite(lapLength)) break;
    const l = lapByKey.get(key)!;
    const [a, b] = sectorTimes(l);
    const anchors: [number, number][] = [[l.start, 0]];
    if (a != null && Number.isFinite(sectorDistances[0])) anchors.push([a, sectorDistances[0]]);
    if (b != null && Number.isFinite(sectorDistances[1])) anchors.push([b, sectorDistances[1]]);
    anchors.push([l.end!, lapLength]);
    if (!it.gap.some(Boolean)) spread.push(it.D.at(-1)! / lapLength - 1);
    const { t: ts, v: vs, d } = align(it, anchors);
    d[d.length - 1] = lapLength;
    for (let k = 1; k < d.length; k++) d[k] = Math.max(d[k], d[k - 1]);

    const car = carOf(l.driver)!;
    const loc = locOf(l.driver);
    // Step channels (brake, gear) hold their last value; the line samples take the neighbour's.
    const step = (arr: number[], t: number) => arr[Math.max(0, lastAtOrBefore(car.t, t))];
    const trace: LapTrace = {
      lap: l.lap,
      t: encodeDeltas(ts.map((t) => Math.round(t - l.start))),
      d: encodeDeltas(d.map((x) => Math.round(x * 10))),
      speed: vs.map((v) => Math.round(v)),
      throttle: ts.map((t) => Math.round(lerpAt(car.t, car.throttle, t))),
      brake: ts.map((t) => step(car.brake, t)),
      gear: ts.map((t) => step(car.gear, t)),
      x: ts.map((t) => (loc && loc.t.length ? Math.round(lerpAt(loc.t, loc.x, t)) : 0)),
      y: ts.map((t) => (loc && loc.t.length ? Math.round(lerpAt(loc.t, loc.y, t)) : 0)),
    };
    if (!traces.has(l.driver)) traces.set(l.driver, { driver: l.driver, laps: [] });
    traces.get(l.driver)!.laps.push(trace);
    qlap.get(key)!.trace = true;
  }
  for (const tr of traces.values()) tr.laps.sort((a, b) => a.lap - b.lap);

  // Validation: GPS positions projected onto the outline vs the aligned distance.
  const { outline } = meta.track;
  const ox = [...outline.x, outline.x[0]];
  const oy = [...outline.y, outline.y[0]];
  const os = [0];
  for (let i = 1; i < ox.length; i++) os.push(os[i - 1] + Math.hypot(ox[i] - ox[i - 1], oy[i] - oy[i - 1]));
  const outlineLength = os.at(-1)! / 10; // m
  const scale = lapLength / outlineLength;
  function project(x: number, y: number, near: number): number {
    // Nearest outline point within ±400 m of where the aligned distance says the car is.
    let best = NaN;
    let bestD = Infinity;
    for (let i = 1; i < ox.length; i++) {
      const s = (os[i - 1] / 10) * scale;
      let ds = Math.abs(s - near);
      ds = Math.min(ds, lapLength - ds);
      if (ds > 400) continue;
      const dx = ox[i] - ox[i - 1];
      const dy = oy[i] - oy[i - 1];
      const f = Math.min(1, Math.max(0, ((x - ox[i - 1]) * dx + (y - oy[i - 1]) * dy) / (dx * dx + dy * dy || 1)));
      const dd = (ox[i - 1] + f * dx - x) ** 2 + (oy[i - 1] + f * dy - y) ** 2;
      if (dd < bestD) {
        bestD = dd;
        best = ((os[i - 1] + f * (os[i] - os[i - 1])) / 10) * scale;
      }
    }
    return best;
  }
  const rmsByLap: number[] = [];
  const offsets: number[] = [];
  for (const tr of traces.values()) {
    for (const lt of tr.laps) {
      let acc = 0;
      const d = lt.d.map((x) => (acc += x) / 10);
      const diffs: number[] = [];
      d.forEach((dist, k) => {
        const s = project(lt.x[k], lt.y[k], dist);
        if (Number.isNaN(s)) return;
        let diff = s - dist;
        if (diff > lapLength / 2) diff -= lapLength;
        if (diff < -lapLength / 2) diff += lapLength;
        diffs.push(diff);
      });
      if (diffs.length < 20) continue;
      const off = median(diffs);
      offsets.push(off);
      rmsByLap.push(Math.sqrt(diffs.reduce((s, x) => s + (x - off) ** 2, 0) / diffs.length));
    }
  }

  const traceCount = [...traces.values()].reduce((s, t) => s + t.laps.length, 0);
  lines.push(
    `segments: ${segments.map((s) => `${s.name} +${Math.round(s.start / 1000)}s..+${Math.round(s.end / 1000)}s${s.advance ? ` (top ${s.advance} through)` : ""}`).join(", ")}`,
  );
  lines.push(
    `laps: ${qualiLaps.length} (${qualiLaps.filter((q) => q.kind === "push").length} push, ${qualiLaps.filter((q) => q.kind === "cool").length} cool, ${qualiLaps.filter((q) => q.kind === "out").length} out, ${qualiLaps.filter((q) => q.kind === "in").length} in), ${deleted.size} deleted by race control`,
  );
  lines.push(
    `distance: lap ${lapLength.toFixed(1)} m (GPS outline ${outlineLength.toFixed(1)} m), sector boundaries at ${sectorDistances[0].toFixed(0)} / ${sectorDistances[1].toFixed(0)} m; ` +
      `speed-integrated laps within ${(quantile(spread, 0.05) * 100).toFixed(2)}%..+${(quantile(spread, 0.95) * 100).toFixed(2)}% (p5..p95) of it before alignment`,
  );
  lines.push(
    `traces: ${traceCount} laps for ${traces.size} drivers${dropouts ? ` (${dropouts} laps skipped: too much car data missing)` : ""}, ` +
      `${frozenSamples} frozen car-data samples in the session skipped (${filledGaps} gaps bridged from the sector length); ` +
      `aligned distance vs GPS projection: RMS median ${median(rmsByLap).toFixed(1)} m, p95 ${quantile(rmsByLap, 0.95).toFixed(1)} m (constant offset ${median(offsets).toFixed(1)} m)`,
  );
  const eliminatedIn = (k: number) => results.filter((r) => r.eliminated === k).length;
  if (segments.length === 3) {
    lines.push(`eliminated: ${eliminatedIn(1)} in ${prefix}1, ${eliminatedIn(2)} in ${prefix}2, ${results.filter((r) => r.eliminated == null).length} in ${prefix}3`);
  }

  const data: QualiData = { segments, laps: qualiLaps, results, lapLength: Math.round(lapLength * 10) / 10, sectorDistances: [Math.round(sectorDistances[0] * 10) / 10, Math.round(sectorDistances[1] * 10) / 10] };
  meta.quali = data;
  return { data, traces, report: { lines, problems } };
}
