// Live qualifying at t: the segment (Q1, Q2, Q3), its clock, and who's knocked out. The order itself is the timing
// screen's (meta.positions, scripts/lib/qualiLive.ts). Pure.

import type { Lap, LiveQualiSegment, Ms, SessionMeta } from "../types";

/** A lap started this long before a segment's green light belongs to it (scripts/lib/qualiLive.ts). */
export const SEGMENT_LEAD_MS = 2_000;

/**
 * After a segment's flag, the laps started before it still count: the cars below the cut are out once the last of
 * them could have finished (or the next segment starts).
 */
export const SETTLE_MS = 2 * 60_000;

export interface QualiPhase {
  /** The latest segment started by t; null before Q1. */
  segment: LiveQualiSegment | null;
  /** Between its green light and its flag. */
  running: boolean;
  /** Under a red flag: its clock is stopped. */
  red: boolean;
  /** Its clock: the running time left (ms). */
  left: Ms;
  /** Cars in it (the field, then those who went through). */
  field: number;
  /** Past its flag, and the laps started before it are done: the cars below the cut are out. */
  settled: boolean;
  /** The positions of the cars knocked out in earlier segments (from, to: inclusive), by segment. */
  out: { segment: LiveQualiSegment; from: number; to: number }[];
}

/** Running time of the segment by t: from its green light, less the time under red flags. */
function runningTime(s: LiveQualiSegment, t: Ms): Ms {
  const to = Math.min(t, s.end ?? t);
  let stopped = 0;
  for (const r of s.stopped) stopped += Math.max(0, Math.min(r.to ?? to, to) - r.from);
  return Math.max(0, to - s.start - stopped);
}

export function qualiPhaseAt(meta: Pick<SessionMeta, "qualiLive" | "drivers">, t: Ms): QualiPhase {
  const segments = meta.qualiLive?.segments ?? [];
  let field = meta.drivers.length;
  let segment: LiveQualiSegment | null = null;
  const out: QualiPhase["out"] = [];
  for (const s of segments) {
    if (s.start > t) break;
    if (segment) {
      const through = Math.min(field, segment.advance ?? field);
      if (through < field) out.push({ segment, from: through + 1, to: field });
      field = through;
    }
    segment = s;
  }
  if (!segment) return { segment: null, running: false, red: false, left: 0, field, settled: false, out };
  const next = segments.find((s) => s.number === segment.number + 1);
  const running = segment.end == null || t < segment.end;
  return {
    segment,
    running,
    red: running && segment.stopped.some((r) => r.from <= t && (r.to == null || t < r.to)),
    left: Math.max(0, segment.length - runningTime(segment, t)),
    field,
    settled: !running && (t >= segment.end! + SETTLE_MS || (next != null && next.start <= t)),
    out,
  };
}

/**
 * Where a car at `position` stands: knocked out in an earlier segment (its name) or in this one once it's settled,
 * in the drop zone below the cut while the segment can still change, or through (null).
 */
export type QualiStanding = { out: LiveQualiSegment } | { danger: true } | null;

export function standingOf(phase: QualiPhase | null, position: number | null): QualiStanding {
  const seg = phase?.segment;
  if (!phase || !seg || position == null) return null;
  const earlier = phase.out.find((o) => position >= o.from && position <= o.to);
  if (earlier) return { out: earlier.segment };
  if (seg.advance == null || position <= seg.advance || position > phase.field) return null;
  return phase.settled ? { out: seg } : { danger: true };
}

/** A lap counts in the segment running when it started (a lap started before the flag still counts). */
export const inSegment = (s: LiveQualiSegment, lap: Pick<Lap, "start">) => lap.start >= s.start - SEGMENT_LEAD_MS && (s.end == null || lap.start <= s.end);

/** The driver's best lap time in the segment that counts at t (completed, not deleted by then); null if none. */
export function segmentBest(laps: readonly Lap[], s: LiveQualiSegment, t: Ms): number | null {
  let best: number | null = null;
  for (const l of laps) {
    if (l.duration == null || l.end == null || l.end > t || l.pitOut || !inSegment(s, l)) continue;
    if (l.deleted && l.deleted.t <= t) continue;
    if (best == null || l.duration < best) best = l.duration;
  }
  return best;
}
