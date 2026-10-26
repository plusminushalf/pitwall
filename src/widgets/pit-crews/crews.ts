// Pit crews: each team's stops ranked by its quickest, the table posted after a race ("fastest pit stop: McLaren
// 2.1 s"). Timed by the stationary time when OpenF1 has it, else by the pit lane time (entry to exit, which also
// counts the drive through the lane). Pure: the widget feeds it what it has at t (nothing past it).

import { median, type PitStop } from "widget-kit"

/** Stationary time, or the time from pit entry to pit exit. */
export type Measure = "stop" | "lane"

/** The part of a pit stop this needs. */
export type CrewStop = Pick<
    PitStop,
    "lap" | "entry" | "exit" | "laneDuration" | "stopDuration"
>

export interface CarInput {
    driver: number
    team: string
    pits: readonly CrewStop[]
}

/** A time a stop gives (s) and who made it on which lap. */
export interface Timed {
    driver: number
    lap: number
    value: number
    /** When it was made (pit exit, ms), for ties. */
    set: number
}

/** A team's stops: the quickest, the median and how many. */
export interface Crew {
    team: string
    best: Timed
    median: number
    count: number
}

/** A red flag period: from `start` to `end` (null: still out). */
export interface RedFlag {
    start: number
    end: number | null
}

const timeOf = (p: CrewStop, m: Measure) =>
    m === "stop" ? p.stopDuration : p.laneDuration

/** Which times the stops have: OpenF1 doesn't report stationary times at every race. */
export function measuresIn(
    cars: readonly CarInput[]
): Record<Measure, boolean> {
    const has = { stop: false, lane: false }
    for (const c of cars)
        for (const p of c.pits)
            for (const m of ["stop", "lane"] as const) {
                const v = timeOf(p, m)
                if (v != null && v > 0) has[m] = true
            }
    return has
}

/** In the lane while the red flag was out: the cars wait there, so the time says nothing about the crew. */
export const underRed = (p: CrewStop, reds: readonly RedFlag[]) =>
    reds.some((r) => p.entry < (r.end ?? Infinity) && p.exit > r.start)

/** Each team's timed stops, the quickest team first (a tie goes to whoever stopped first). Stops under a red flag are left out. */
export function crews(
    cars: readonly CarInput[],
    measure: Measure,
    reds: readonly RedFlag[]
): Crew[] {
    const byTeam = new Map<string, Timed[]>()
    for (const c of cars)
        for (const p of c.pits) {
            const v = timeOf(p, measure)
            if (v == null || v <= 0 || underRed(p, reds)) continue
            const own = byTeam.get(c.team) ?? []
            own.push({ driver: c.driver, lap: p.lap, value: v, set: p.exit })
            byTeam.set(c.team, own)
        }
    return [...byTeam]
        .map(([team, stops]) => ({
            team,
            best: stops.reduce((a, b) =>
                b.value < a.value || (b.value === a.value && b.set < a.set)
                    ? b
                    : a
            ),
            median: median(stops.map((s) => s.value)),
            count: stops.length
        }))
        .sort((a, b) => a.best.value - b.best.value || a.best.set - b.best.set)
}

/** How many finished stops a red flag left out. */
export const redCount = (
    cars: readonly CarInput[],
    reds: readonly RedFlag[]
) =>
    reds.length === 0
        ? 0
        : cars.reduce(
              (n, c) => n + c.pits.filter((p) => underRed(p, reds)).length,
              0
          )

/** Where the bars start (s): a little under the quickest, so the differences show. The slowest keeps the full width. */
export function axisStart(values: readonly number[]): number {
    if (values.length === 0) return 0
    const min = Math.min(...values)
    const max = Math.max(...values)
    const pad = Math.max(min * 0.05, (max - min) * 0.25)
    return Math.max(0, Math.floor((min - pad) * 2) / 2)
}
