// Lap time spread: each driver's clean laps so far as a box plot, ranked by the median. Where Pace order's race pace
// takes fuel and tyres out to rank the cars, this shows the laps as they were driven: how quick a driver typically was
// and how much the laps varied (traffic, tyre wear, a moment). Pure: the widget feeds it the laps, stints and safety
// car, VSC and red flag periods it has so far (nothing past t).
//
// A lap counts when it's timed, isn't lap 1 (the standing start), an out-lap or an in-lap, isn't touched by a neutral
// period and is within 107% of the driver's own quickest counted lap (a slow zone or a spin isn't pace).

import type { NeutralPeriod } from "widget-kit"

/** The part of a completed lap this needs. */
export interface SpreadLap {
    lap: number
    start: number
    end: number | null
    duration: number | null
    pitOut: boolean
}

/** The part of a stint this needs. */
export interface SpreadStint {
    lapStart: number
}

/** Under this many counted laps a car gets no box: three laps don't have quartiles worth drawing. */
export const MIN_LAPS = 5
/** Laps slower than this times the driver's quickest counted lap are left out. */
export const CUTOFF = 1.07
/** Whiskers reach the furthest lap within this many interquartile ranges of the box; laps beyond are outliers. */
const WHISKER = 1.5

/** One row: a driver's (or a team's) counted laps in seconds, summed up. */
export interface Spread {
    /** Driver number, or the team's name. */
    key: number | string
    laps: number
    q1: number
    median: number
    q3: number
    /** The quickest and slowest laps within the whiskers' reach. */
    low: number
    high: number
    /** Laps beyond the whiskers, slower or quicker. */
    outliers: number[]
    best: number
}

/**
 * A driver's counted laps, in seconds: timed, not lap 1, not an out-lap or an in-lap, not touched by a neutral period,
 * and within CUTOFF of their quickest such lap.
 */
export function cleanLaps(
    laps: readonly SpreadLap[],
    stints: readonly SpreadStint[],
    neutral: readonly NeutralPeriod[]
): number[] {
    const sorted = [...laps].sort((a, b) => a.lap - b.lap)
    const starts = new Set(stints.slice(1).map((s) => s.lapStart))
    const times = sorted.flatMap((l, k) => {
        if (l.lap <= 1 || l.duration == null || !(l.duration > 0)) return []
        // Out-lap: flagged, or the first lap of a later stint. In-lap: the next lap is an out-lap, or a stint starts after it.
        if (l.pitOut || starts.has(l.lap)) return []
        if (sorted[k + 1]?.pitOut === true || starts.has(l.lap + 1)) return []
        const end = l.end ?? l.start + l.duration * 1000
        if (neutral.some((p) => p.start < end && l.start < (p.end ?? Infinity)))
            return []
        return [l.duration]
    })
    const quickest = Math.min(...times)
    return times.filter((s) => s <= quickest * CUTOFF)
}

/** The q-th quantile (0..1) of sorted values, interpolated between the two either side. */
export function quantile(sorted: readonly number[], q: number): number {
    const at = (sorted.length - 1) * q
    const lo = Math.floor(at)
    const hi = Math.ceil(at)
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo)
}

/** The box plot of some lap times; null under MIN_LAPS. */
export function spreadOf(
    key: number | string,
    times: readonly number[]
): Spread | null {
    if (times.length < MIN_LAPS) return null
    const sorted = [...times].sort((a, b) => a - b)
    const q1 = quantile(sorted, 0.25)
    const q3 = quantile(sorted, 0.75)
    const reach = (q3 - q1) * WHISKER
    const inside = sorted.filter((s) => s >= q1 - reach && s <= q3 + reach)
    return {
        key,
        laps: sorted.length,
        q1,
        median: quantile(sorted, 0.5),
        q3,
        low: inside[0],
        high: inside[inside.length - 1],
        outliers: sorted.filter((s) => s < q1 - reach || s > q3 + reach),
        best: sorted[0]
    }
}

export interface SpreadInput {
    driver: number
    team: string
    laps: readonly SpreadLap[]
    stints: readonly SpreadStint[]
}

/**
 * The rows, lowest median first (equal medians: the lower best lap). By team, both cars' laps go in one box. Cars
 * (teams) with too few counted laps are left out; `short` says how many.
 */
export function spreads(
    cars: readonly SpreadInput[],
    neutral: readonly NeutralPeriod[],
    by: "drivers" | "teams"
): { rows: Spread[]; short: number } {
    const groups = new Map<number | string, number[]>()
    for (const c of cars) {
        const key = by === "teams" ? c.team : c.driver
        const own = groups.get(key) ?? []
        own.push(...cleanLaps(c.laps, c.stints, neutral))
        groups.set(key, own)
    }
    const rows: Spread[] = []
    for (const [key, times] of groups) {
        const s = spreadOf(key, times)
        if (s) rows.push(s)
    }
    rows.sort((a, b) => a.median - b.median || a.best - b.best)
    return { rows, short: groups.size - rows.length }
}

/** Gridlines for a span of seconds: every 0.5 s, 1 s or 2 s, whichever gives at most `most` lines. */
export function ticks(lo: number, hi: number, most: number): number[] {
    const step = [0.5, 1, 2, 5].find((s) => (hi - lo) / s <= most) ?? 10
    const out: number[] = []
    for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step)
        out.push(Math.round(v * 10) / 10)
    return out
}
