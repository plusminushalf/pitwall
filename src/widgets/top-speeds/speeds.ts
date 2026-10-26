// Top speeds: every driver's highest reading so far, the chart posted after a race ("no driver recorded a higher top
// speed than Alonso"). From the timing's speed points on completed laps: the speed trap on the straight, or the
// highest of it and the two intermediates. Pure: the widget feeds it what it has at t (nothing past it).

import type { Lap, Stint } from "widget-kit"

/** The speed trap alone, or the highest of the trap and the intermediates. */
export type Trap = "st" | "any"
/** Where a reading was taken: intermediate 1 or 2, or the speed trap. */
export type Point = keyof Lap["speedTrap"]

/** The part of a completed lap this needs. */
export type SpeedLap = Pick<Lap, "lap" | "start" | "end" | "speedTrap">
/** The part of a stint this needs. */
export type SpeedStint = Pick<Stint, "lapStart" | "compound" | "ageAtStart">

export interface CarInput {
    driver: number
    laps: readonly SpeedLap[]
    stints: readonly SpeedStint[]
}

/** A driver's top speed (km/h), where and on which lap, and the tyres it was on. */
export interface TopSpeed {
    driver: number
    value: number
    point: Point
    lap: number
    /** When it was set (the lap's end, ms), for ties. */
    set: number
    compound: string | null
    /** Laps on the set before this lap; null when not known. */
    age: number | null
}

const POINTS: Record<Trap, readonly Point[]> = {
    st: ["st"],
    any: ["i1", "i2", "st"]
}

/** The tyres on `lap`: its stint is the last to start by it. */
function tyreOn(stints: readonly SpeedStint[], lap: number) {
    let s: SpeedStint | null = null
    for (const x of stints)
        if (x.lapStart <= lap && (!s || x.lapStart > s.lapStart)) s = x
    if (!s) return { compound: null, age: null }
    return {
        compound: s.compound,
        age: s.ageAtStart == null ? null : s.ageAtStart + lap - s.lapStart
    }
}

/** Faster first; a tie goes to whoever set it first, as in the timing. */
export const byFastest = (a: TopSpeed, b: TopSpeed) =>
    b.value - a.value || a.set - b.set

/** Each driver's top speed at `trap`, fastest first. Drivers with no reading there are left out. */
export function topSpeeds(cars: readonly CarInput[], trap: Trap): TopSpeed[] {
    const out: TopSpeed[] = []
    for (const car of cars) {
        let best: TopSpeed | null = null
        for (const l of car.laps) {
            if (l.end == null) continue
            for (const point of POINTS[trap]) {
                const v = l.speedTrap[point]
                if (v == null || v <= 0) continue
                if (
                    best &&
                    (v < best.value || (v === best.value && l.end >= best.set))
                )
                    continue
                best = {
                    driver: car.driver,
                    value: v,
                    point,
                    lap: l.lap,
                    set: l.end,
                    ...tyreOn(car.stints, l.lap)
                }
            }
        }
        if (best) out.push(best)
    }
    return out.sort(byFastest)
}

/** Each team's quicker car, fastest first: `speeds` (fastest first) with a team's slower car left out. */
export function teamSpeeds(
    speeds: readonly TopSpeed[],
    teamOf: (driver: number) => string | undefined
): { team: string; speed: TopSpeed }[] {
    const seen = new Set<string>()
    const out: { team: string; speed: TopSpeed }[] = []
    for (const s of speeds) {
        const team = teamOf(s.driver)
        if (team == null || seen.has(team)) continue
        seen.add(team)
        out.push({ team, speed: s })
    }
    return out
}

/** At most this many km/h across the bars: a car that only did a slow lap (out on lap 1) doesn't squash the rest. */
const MAX_SPAN = 40

/**
 * Where the bars start (km/h): a little under the slowest, on a round number, so the differences show (from zero,
 * 338 and 351 look the same). The slowest bar keeps about a fifth of the width.
 */
export function axisStart(values: readonly number[]): number {
    if (values.length === 0) return 0
    const max = Math.max(...values)
    const min = Math.max(Math.min(...values), max - MAX_SPAN)
    const pad = Math.max(2, (max - min) * 0.25)
    return Math.floor((min - pad) / 2) * 2
}

/** "Fastest" for the top speed (ties too), else "−3 km/h" behind it. */
export function gapText(best: number, v: number): string {
    const d = Math.round(best) - Math.round(v)
    return d <= 0 ? "Fastest" : `−${d} km/h`
}

export const POINT_NAMES: Record<Point, string> = {
    i1: "the first intermediate",
    i2: "the second intermediate",
    st: "the speed trap"
}
