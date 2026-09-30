// The one per-frame scheduler behind useFrame(). The replay loop calls runFrames() in its rAF tick,
// right after advancing the clock, so canvas blocks draw the same frame's time with no lag.

import type { Session } from "../data/session";
import { clock, useReplay } from "../store";
import { carAt, type CarPosition } from "./select";

/** What useFrame's draw gets every animation frame. */
export interface Frame {
  /** Exact replay time (ms since the session window start), not the 10 Hz one. */
  t: number;
  /** Car n on the map at t, or null when it isn't shown (no data yet, or retired a while ago). */
  car(n: number): CarPosition | null;
}

export type DrawFn = (frame: Frame) => void;

/**
 * A block whose draws typically take longer than this skips the next frame(s) in proportion (10 ms: two
 * frames), so a slow block drops its own frames and the others keep theirs. Half the 8 ms whole-screen
 * budget (H3.6). Typically: the median of its last DRAW_SAMPLES draws, so one slow draw (a GC pause, a
 * first-time font load) skips nothing, while a block that is slow draw after draw is throttled.
 */
export const FRAME_BUDGET_MS = 4;
/** How many recent draws the skip looks at. */
const DRAW_SAMPLES = 5;
/** A slow block still draws at least a few times a second. */
const MAX_SKIP = 20;
/** A draw that throws is retried about once a second. */
const ERROR_SKIP = 60;

interface Entry {
  draw: { readonly current: DrawFn };
  visible: () => boolean;
  skip: number;
  /** The last DRAW_SAMPLES draw durations in ms, a ring starting at zeros (a new block isn't slow yet). */
  times: Float64Array;
  next: number;
}

const entries = new Set<Entry>();

/** Registers a draw callback (read through the ref, so re-renders don't re-subscribe). Returns the unsubscribe. */
export function addFrameCallback(draw: { readonly current: DrawFn }, visible: () => boolean = () => true): () => void {
  const entry: Entry = { draw, visible, skip: 0, times: new Float64Array(DRAW_SAMPLES), next: 0 };
  entries.add(entry);
  return () => entries.delete(entry);
}

const sorted = new Float64Array(DRAW_SAMPLES);
/** Median of an entry's recent draw times, without allocating. */
function typicalDraw(e: Entry): number {
  sorted.set(e.times);
  sorted.sort();
  return sorted[DRAW_SAMPLES >> 1];
}

function makeFrame(session: Session, t: number): Frame {
  // Shared by every block this frame: two maps don't compute the same car twice.
  const cars = new Map<number, CarPosition | null>();
  return {
    t,
    car(n) {
      let p = cars.get(n);
      if (p === undefined) {
        const d = session.drivers.get(n);
        p = d ? carAt(d, t) : null;
        cars.set(n, p);
      }
      return p;
    },
  };
}

/** Calls every visible block's draw with the current clock. */
export function runFrames(): void {
  if (entries.size === 0) return;
  const { session } = useReplay.getState();
  if (!session) return;
  const frame = makeFrame(session, clock.t);
  for (const e of entries) {
    if (!e.visible()) continue;
    if (e.skip > 0) {
      e.skip--;
      continue;
    }
    const start = performance.now();
    try {
      e.draw.current(frame);
      e.times[e.next] = performance.now() - start;
      e.next = (e.next + 1) % DRAW_SAMPLES;
      e.skip = Math.min(Math.floor(typicalDraw(e) / FRAME_BUDGET_MS), MAX_SKIP);
    } catch (err) {
      console.error("Block draw failed", err);
      e.skip = ERROR_SKIP;
    }
  }
}
