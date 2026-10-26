// Overtakes: each driver's passes made and lost so far, on track. Pure: the widget feeds it what it has at t.
//
// OpenF1's overtakes are changes of place between two cars, so they also count places that change hands in the
// pits and around a car that's stopping. At Baku 2026, 10 of the 160 involved a car in the pit lane (the pit entry is
// worked out from the exit and the lane time, so a few seconds either side) and 32 a car within a minute of retiring:
// a car crawling back to the pits is passed by the field, and a parked one keeps being "passed" as the order settles.
// Neither is a pass, so both are left out. A retirement is only known once it's happened, so passes on a car that's
// slowing count until it stops.

/** The part of an overtake in the feed this needs. */
export interface PassIn {
    t: number
    /** The car passing. */
    driver: number
    /** The car passed. */
    passed: number
}

/** A car's time in the pit lane. */
export interface LaneIn {
    entry: number
    exit: number
}

/** Either side of the pit lane, ms: the entry is worked out, and the order catches up a moment later. */
export const PIT_MARGIN_MS = 5_000
/** Before a retirement, ms: the car slows for most of a lap before it's seen to stop. */
export const RETIRING_MS = 60_000

export interface PassRow {
    driver: number
    made: number
    lost: number
}

export interface PassCount {
    /** Drivers with a pass made or lost: most made first, then fewest lost. */
    rows: PassRow[]
    /** Passes counted. */
    total: number
    /** Left out: a car in the pit lane, a car retiring, or on lap 1 when that's asked for. */
    pits: number
    retiring: number
    lap1: number
}

export interface PassInputs {
    passes: readonly PassIn[]
    pits: ReadonlyMap<number, readonly LaneIn[]>
    /** When each retired car stopped, as far as known at t. */
    retired: ReadonlyMap<number, number>
    /** Every car's driver number, so drivers with no passes get a row of zeros. */
    drivers: readonly number[]
    /** Leave out passes before this (the leader's lap 1 end; Infinity while lap 1 is still being run); null: keep them. */
    from: number | null
}

const inLane = (lanes: readonly LaneIn[] | undefined, t: number) =>
    lanes?.some(
        (l) => l.entry - PIT_MARGIN_MS <= t && t <= l.exit + PIT_MARGIN_MS
    ) ?? false

export function countPasses({
    passes,
    pits,
    retired,
    drivers,
    from
}: PassInputs): PassCount {
    const byDriver = new Map<number, PassRow>(
        drivers.map((n) => [n, { driver: n, made: 0, lost: 0 }])
    )
    const row = (n: number) => {
        let r = byDriver.get(n)
        if (!r) {
            r = { driver: n, made: 0, lost: 0 }
            byDriver.set(n, r)
        }
        return r
    }
    let total = 0
    let pitCount = 0
    let retiring = 0
    let lap1 = 0
    for (const p of passes) {
        if (from != null && p.t < from) {
            lap1++
            continue
        }
        if (
            inLane(pits.get(p.driver), p.t) ||
            inLane(pits.get(p.passed), p.t)
        ) {
            pitCount++
            continue
        }
        const stop = retired.get(p.passed)
        if (stop != null && p.t >= stop - RETIRING_MS) {
            retiring++
            continue
        }
        row(p.driver).made++
        row(p.passed).lost++
        total++
    }
    const rows = [...byDriver.values()].sort(
        (a, b) => b.made - a.made || a.lost - b.lost || a.driver - b.driver
    )
    return { rows, total, pits: pitCount, retiring, lap1 }
}
