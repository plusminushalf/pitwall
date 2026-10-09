// Live qualifying on top of normalize(), which times it like free practice (practice.ts): from the green light, with
// no lap time for the laps either side of a garage visit. Here: the Q1/Q2/Q3 segments from race control as they
// happen, and the timing screen's order through them. A finished qualifying session is ingested by quali.ts instead
// (lap traces, the official classification). Pure: no file or network I/O.

import { inSegment } from "../../src/engine/qualiPhase";
import type { IntervalEvent, Lap, LiveQualiSegment, Ms, PositionEvent, RaceControlMsg } from "../../src/types";

const MIN = 60_000;

/** Scheduled running time of each segment: 18, 15 and 12 minutes (13 from 2026); sprint qualifying 12, 10 and 8. */
function lengthsOf(sprint: boolean, year: number): Ms[] {
  return (sprint ? [12, 10, 8] : [18, 15, year >= 2026 ? 13 : 12]).map((m) => m * MIN);
}

/**
 * The segments started by the last message, from race control: one starts with SESSION STARTED, and ends with its
 * chequered flag (or SESSION FINISHED). A red flag (or the session aborted) stops its clock until it restarts.
 * `entries`: cars in the session (Q1's field), for how many go through: 15 of 20, 16 of 22, then 10.
 */
export function liveSegments(
  raceControl: readonly Pick<RaceControlMsg, "t" | "category" | "flag" | "scope" | "message">[],
  opts: { sprint: boolean; year: number; entries: number },
): LiveQualiSegment[] {
  const lengths = lengthsOf(opts.sprint, opts.year);
  const prefix = opts.sprint ? "SQ" : "Q";
  const advances = [10 + Math.ceil(Math.max(0, opts.entries - 10) / 2), 10, null];
  const segments: LiveQualiSegment[] = [];
  let open: LiveQualiSegment | null = null;
  for (const m of [...raceControl].sort((a, b) => a.t - b.t)) {
    const msg = m.message.toUpperCase();
    const status = m.category === "SessionStatus";
    const started = status && /STARTED|RESUMED/.test(msg);
    if (!open) {
      if (!started || !/STARTED/.test(msg) || segments.length >= 3) continue;
      const i = segments.length;
      open = { number: i + 1, name: `${prefix}${i + 1}`, start: m.t, end: null, advance: advances[i], length: lengths[i], stopped: [] };
      segments.push(open);
      continue;
    }
    const red = open.stopped.at(-1)?.to === null ? open.stopped.at(-1)! : null;
    if ((status && /FINISHED/.test(msg)) || (m.flag === "CHEQUERED" && m.scope === "Track")) {
      open.end = m.t;
      if (red) red.to = m.t;
      open = null;
    } else if (m.flag === "RED" || (status && /ABORTED|SUSPENDED/.test(msg))) {
      if (!red) open.stopped.push({ from: m.t, to: null });
    } else if (red && (started || (m.flag === "GREEN" && m.scope === "Track"))) {
      red.to = m.t;
    }
  }
  return segments;
}

/** The segment a lap counts in: the one running when it started (a lap started before the flag still counts). */
export const segmentOfLap = (segments: readonly LiveQualiSegment[], start: Ms): LiveQualiSegment | null =>
  segments.find((s) => inSegment(s, { start })) ?? null;

/**
 * The timing screen at every change: each car's position and its gaps (seconds) to the fastest and to the car ahead.
 * The cars in the segment running are ordered by their best lap in it (a lap counts from its end until race control
 * deletes it); those without one follow in the previous segment's order (Q1: car number). Below them, the cars
 * knocked out, as the segment they went out in left them, with their gaps in it. Before Q1, car number order.
 */
export function qualiStandings(
  laps: readonly Lap[],
  drivers: readonly number[],
  segments: readonly LiveQualiSegment[],
): { positions: PositionEvent[]; intervals: IntervalEvent[] } {
  type Time = { time: number; set: Ms; segment: number; until: Ms };
  const times = new Map<number, Time[]>(drivers.map((n) => [n, []]));
  const changes = new Set<Ms>([0, ...segments.map((s) => s.start)]);
  for (const l of laps) {
    if (l.duration == null || l.end == null || l.pitOut) continue;
    const seg = segmentOfLap(segments, l.start);
    const own = times.get(l.driver);
    if (!seg || !own) continue;
    const until = l.deleted ? Math.max(l.deleted.t, l.end) : Infinity;
    own.push({ time: l.duration, set: l.end, segment: seg.number, until });
    changes.add(l.end);
    if (until !== Infinity) changes.add(until);
  }
  const round = (s: number) => Math.round(s * 1000) / 1000;

  /** Each car's best lap in `segment` that counts at t. Ties: the one set first. */
  const bestAt = (n: number, segment: number, t: Ms): Time | null => {
    let best: Time | null = null;
    for (const x of times.get(n)!) {
      if (x.segment !== segment || x.set > t || x.until <= t) continue;
      if (!best || x.time < best.time || (x.time === best.time && x.set < best.set)) best = x;
    }
    return best;
  };

  type Row = { position: number; gap: number | null; interval: number | null };
  const classify = (t: Ms): Map<number, Row> => {
    const rows = new Map<number, Row>();
    const started = segments.filter((s) => s.start <= t);
    let field = [...drivers].sort((a, b) => a - b);
    for (const [i, seg] of started.entries()) {
      const bests = new Map(field.map((n) => [n, bestAt(n, seg.number, t)]));
      // (`field` is in the previous segment's order, so a stable sort keeps it for the cars without a time.)
      const ranked = [...field].sort((a, b) => {
        const ba = bests.get(a);
        const bb = bests.get(b);
        if (!ba || !bb) return !ba && !bb ? 0 : !ba ? 1 : -1;
        return ba.time - bb.time || ba.set - bb.set || a - b;
      });
      const fastest = bests.get(ranked[0])?.time ?? null;
      const last = i === started.length - 1;
      const through = last ? ranked.length : Math.min(seg.advance ?? ranked.length, ranked.length);
      ranked.forEach((n, k) => {
        if (k < through && !last) return;
        const own = bests.get(n)?.time ?? null;
        const ahead = k > 0 ? (bests.get(ranked[k - 1])?.time ?? null) : null;
        rows.set(n, {
          position: k + 1,
          gap: own != null && fastest != null && k > 0 ? round(own - fastest) : null,
          interval: own != null && ahead != null ? round(own - ahead) : null,
        });
      });
      field = ranked.slice(0, through);
    }
    if (!started.length) field.forEach((n, k) => rows.set(n, { position: k + 1, gap: null, interval: null }));
    return rows;
  };

  const positions: PositionEvent[] = [];
  const intervals: IntervalEvent[] = [];
  const prev = new Map<number, Row>();
  for (const t of [...changes].sort((a, b) => a - b)) {
    for (const [n, next] of classify(t)) {
      const p = prev.get(n);
      if (!p || p.position !== next.position) positions.push({ t, driver: n, position: next.position });
      if (!p || p.gap !== next.gap || p.interval !== next.interval) intervals.push({ t, driver: n, gapToLeader: next.gap, interval: next.interval });
      prev.set(n, next);
    }
  }
  return { positions, intervals };
}
