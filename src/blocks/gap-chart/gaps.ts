// Gaps lap by lap from lap-line crossing times, the safety car laps, and the y scale. Pure.
// Everything here works on what the hooks give at t (completed laps, the SC/VSC periods so far), so the chart
// only ever shows the race up to now. No imports, so its test can live outside the block (src/engine).

export type GapMode = "leader" | "interval";

/** crossings[n] = when the car crossed the line to finish lap n (ms), or null; index 0 is unused. */
export type Crossings = readonly (number | null)[];

/** A driver's gap at the end of a lap: seconds, or why there's none ("leading": interval mode, nobody ahead). */
export type Gap = number | "leading" | "lapped" | null;

export interface GapSeries {
  driver: number;
  /** gaps[n] at the end of lap n; index 0 is unused. Ends with the driver's last completed lap. */
  gaps: Gap[];
}

/** A car's completed laps as crossing times (for useAllLaps' select: changes only when a lap is completed). */
export function crossingsOf(laps: readonly { lap: number; end: number | null }[]): (number | null)[] {
  const last = laps.reduce((m, l) => Math.max(m, l.lap), 0);
  const out: (number | null)[] = Array.from({ length: last + 1 }, () => null);
  for (const l of laps) out[l.lap] = l.end;
  return out;
}

/** first[n] = the first crossing at the end of lap n by anyone: the leader's. Ends with the last lap anyone completed. */
export function leaderCrossings(all: readonly Crossings[]): (number | null)[] {
  const first: (number | null)[] = [null];
  for (const c of all) {
    for (let n = 1; n < c.length; n++) {
      const t = c[n];
      if (t == null) continue;
      while (first.length <= n) first.push(null);
      const f = first[n];
      if (f == null || t < f) first[n] = t;
    }
  }
  return first;
}

/** Whether a car that finished lap n at t was lapped by then: the leader had already finished lap n + 1. */
const lappedAt = (leader: readonly (number | null)[], n: number, t: number) => {
  const next = leader[n + 1];
  return next != null && next < t;
};

/**
 * Each of `drivers`' gaps lap by lap, from `all` (every car's crossings, by car number).
 *   leader:   the car's crossing at lap n minus the first crossing at lap n. A lapped car has no gap
 *             ("lapped"): its line ends where it was caught, instead of running off a lap behind.
 *   interval: the car's crossing minus the crossing just before it at lap n (the car ahead in the order).
 * A lap the car didn't complete (retired, data missing) has no gap (null), so its line ends there.
 */
export function gapSeries(all: ReadonlyMap<number, Crossings>, drivers: readonly number[], mode: GapMode): GapSeries[] {
  const cars = [...all.values()];
  const leader = leaderCrossings(cars);
  // Every crossing at lap n, sorted, for the interval.
  const byLap: number[][] = leader.map((_, n) => {
    const ts: number[] = [];
    for (const c of cars) if (c[n] != null) ts.push(c[n]!);
    return ts.sort((a, b) => a - b);
  });
  return drivers.map((driver) => {
    const own = all.get(driver) ?? [];
    const gaps: Gap[] = own.map((t, n): Gap => {
      if (n === 0 || t == null) return null;
      if (mode === "leader") return lappedAt(leader, n, t) ? "lapped" : (t - leader[n]!) / 1000;
      const ts = byLap[n];
      const i = ts.indexOf(t);
      return i <= 0 ? "leading" : (t - ts[i - 1]) / 1000;
    });
    return { driver, gaps };
  });
}

/**
 * The order at the line: most laps completed first, then who crossed first. For the chart's drivers when
 * none are selected (it changes only when someone crosses the line, unlike the running order).
 */
export function orderAtLine(all: ReadonlyMap<number, Crossings>): number[] {
  const last = (c: Crossings) => {
    for (let n = c.length - 1; n > 0; n--) if (c[n] != null) return { lap: n, t: c[n]! };
    return null;
  };
  return [...all]
    .map(([driver, c]) => ({ driver, at: last(c) }))
    .filter((d) => d.at != null)
    .sort((a, b) => b.at!.lap - a.at!.lap || a.at!.t - b.at!.t)
    .map((d) => d.driver);
}

// ---------------------------------------------------------------- safety car laps

export type Neutralised = "SC" | "VSC";

/** A safety car, VSC or red flag period, as useNeutralPeriods gives it: `end` is null while it's still out. */
export interface NeutralPeriod {
  status: "SC" | "VSC" | "RED";
  start: number;
  end: number | null;
}

/**
 * laps[n]: whether the leader's lap n (from their crossing at lap n - 1, or lights out, to lap n) ran
 * partly under a safety car or VSC (SC wins; red flags aren't marked). One more entry than the leader's
 * completed laps: the lap in progress, which counts as running until now.
 */
export function neutralisedLaps(
  periods: readonly NeutralPeriod[],
  leader: readonly (number | null)[],
  lightsOut: number,
): (Neutralised | null)[] {
  const laps: (Neutralised | null)[] = [null];
  for (let n = 1; n <= leader.length; n++) {
    const from = n === 1 ? lightsOut : leader[n - 1];
    const to = leader[n] ?? Infinity;
    if (from == null) {
      laps.push(null);
      continue;
    }
    const kinds = periods.filter((p) => p.start < to && (p.end ?? Infinity) > from).map((p) => p.status);
    laps.push(kinds.includes("SC") ? "SC" : kinds.includes("VSC") ? "VSC" : null);
  }
  return laps;
}

// ---------------------------------------------------------------- y scale

/** In interval mode the scale stops here: what's further back is drawn on the bottom edge. */
export const INTERVAL_CAP = 10;
const STEPS = [0.5, 1, 2, 5, 10, 15, 20, 30, 60, 120];

/**
 * The y scale: 0 at the top (the leader, or the car ahead), down to `max`, in steps of `step`, with at
 * most `ticks` steps. Fitted to the largest gap shown (at least 1 s); in interval mode no further than
 * INTERVAL_CAP (`capped` when a gap is beyond it).
 */
export function gapScale(largest: number, mode: GapMode, ticks: number): { max: number; step: number; capped: boolean } {
  const capped = mode === "interval" && largest > INTERVAL_CAP;
  const fit = Math.max(capped ? INTERVAL_CAP : largest * 1.05, 1);
  const step = STEPS.find((s) => Math.ceil(fit / s - 1e-9) <= Math.max(ticks, 1)) ?? STEPS[STEPS.length - 1];
  return { max: capped ? INTERVAL_CAP : Math.ceil(fit / step - 1e-9) * step, step, capped };
}
