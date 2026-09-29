/** Index of the last element of sorted `times` that is <= t, or -1. */
export function indexAtOrBefore(times: ArrayLike<number>, t: number): number {
  let lo = 0;
  let hi = times.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/** Last item at or before t (items and times are parallel). */
export function stepAt<T>(items: T[], times: ArrayLike<number>, t: number): T | null {
  const i = indexAtOrBefore(times, t);
  return i >= 0 ? items[i] : null;
}

/** Linear interpolation of a sampled series; null outside the sampled range. */
export function lerpAt(times: ArrayLike<number>, values: ArrayLike<number>, t: number): number | null {
  const i = indexAtOrBefore(times, t);
  if (i < 0) return null;
  if (i >= times.length - 1) return times[i] === t ? values[i] : null;
  const u = (t - times[i]) / (times[i + 1] - times[i]);
  return values[i] + u * (values[i + 1] - values[i]);
}

/** Uniform Catmull-Rom between p1 and p2 at u in [0, 1]. */
export function catmullRom(p0: number, p1: number, p2: number, p3: number, u: number): number {
  const u2 = u * u;
  const u3 = u2 * u;
  return 0.5 * (2 * p1 + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u2 + (-p0 + 3 * p1 - 3 * p2 + p3) * u3);
}
