// The lap window: the laps the lap charts (gaps, stint pace, tyres) show, picked once on the timeline's zoom rail
// (components/LapZoom.tsx) for every chart at once. Kept in the store as [first, last] lap; null is the whole race.

/** The laps a lap chart shows: first and last (whole laps, inclusive), and whether that's less than the whole race. */
export interface LapWindow {
  from: number;
  to: number;
  zoomed: boolean;
}

/** A picked window (null: none) fitted to laps 1 to `totalLaps`, at least two laps wide. */
export function lapWindowIn(picked: readonly [number, number] | null, totalLaps: number): LapWindow {
  const total = Math.max(1, Math.round(totalLaps));
  if (!picked) return { from: 1, to: total, zoomed: false };
  const from = Math.min(Math.max(1, picked[0]), Math.max(1, total - 1));
  const to = Math.min(Math.max(from + 1, picked[1]), total);
  return { from, to, zoomed: from > 1 || to < total };
}

/** No lap timed yet: a typical lap, to place the laps to come. */
const FALLBACK_LAP_MS = 95_000;

/**
 * Where the lap boundaries are on the timeline (ms): edges[0] the start of lap 1, edges[n] the end of lap n. Laps
 * not run yet, or not watched yet (`shownTo`, no spoilers), are placed at the average lap so far.
 */
export function lapEdges(lapStartTimes: readonly (number | undefined)[], totalLaps: number, start: number, finish: number | null, shownTo: number): number[] {
  const first = lapStartTimes[1];
  const edges = [first !== undefined && first <= shownTo ? first : start];
  for (let n = 1; n <= totalLaps; n++) {
    const t = n < totalLaps ? lapStartTimes[n + 1] : finish;
    if (t == null || t > shownTo || t < edges[n - 1]) break;
    edges.push(t);
  }
  const known = edges.length - 1;
  const lap = known > 0 ? (edges[known] - edges[0]) / known : FALLBACK_LAP_MS;
  for (let n = known + 1; n <= totalLaps; n++) edges.push(edges[known] + (n - known) * lap);
  return edges;
}

/** The edge nearest time `t`. */
export function nearestEdge(edges: readonly number[], t: number): number {
  let best = 0;
  for (let i = 1; i < edges.length; i++) if (Math.abs(edges[i] - t) < Math.abs(edges[best] - t)) best = i;
  return best;
}
