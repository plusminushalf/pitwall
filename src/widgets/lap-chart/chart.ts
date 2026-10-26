// The lap chart's numbers: each car's position at the end of every lap from its lap-line crossings, the grid as lap 0,
// laps led, and which laps ran under a safety car, VSC or red flag. Pure, and only ever fed what the hooks give at t.

/** crossings[n] = when the car crossed the line to finish lap n (ms), or null; index 0 is unused. */
export type Crossings = readonly (number | null)[]

/** A car's completed laps as crossing times (for useAllLaps' select: changes only when a lap is completed). */
export function crossingsOf(
    laps: readonly { lap: number; end: number | null }[]
): (number | null)[] {
    const last = laps.reduce((m, l) => Math.max(m, l.lap), 0)
    const out: (number | null)[] = Array.from({ length: last + 1 }, () => null)
    for (const l of laps) out[l.lap] = l.end
    return out
}

/** A crossing that can be: after the car's own one a lap before (live timing sometimes has one mistimed for a moment). */
const valid = (c: Crossings, n: number): number | null => {
    const t = c[n]
    if (t == null) return null
    const before = c[n - 1]
    return before != null && t <= before ? null : t
}

export interface LapPositions {
    driver: number
    /**
     * positions[n]: the car's place at the end of lap n, by the order the cars crossed the line on lap n (a lapped car
     * crosses it later than everyone a lap up, so it's behind them); null for a lap it didn't complete. positions[0]
     * is the grid (null when it isn't known). Ends with the car's last completed lap.
     */
    positions: (number | null)[]
}

/**
 * Every car's position lap by lap, in `all`'s order. `grid` is each car's grid slot; a car with none (a pit lane start)
 * goes behind those with one, in car number order. Cars that retired drop out of the laps they didn't complete, so
 * the cars still running fill the places from 1. `finished`: the place of each car that has taken the flag, which its
 * last lap takes: lap ends are worked out from lap times, a few ms out, and a photo finish (Baku 2026, 0.196 s) can come
 * out the wrong way round.
 */
export function lapPositions(
    all: ReadonlyMap<number, Crossings>,
    grid: ReadonlyMap<number, number | null>,
    finished: ReadonlyMap<number, number> = new Map()
): LapPositions[] {
    const cars = [...all.keys()]
    const last = [...all.values()].reduce(
        (m, c) => Math.max(m, c.length - 1),
        0
    )
    const out = new Map<number, (number | null)[]>(cars.map((n) => [n, [null]]))
    const slotted = [...grid].filter(
        (g): g is [number, number] => g[1] != null && all.has(g[0])
    )
    if (slotted.length > 0) {
        const order = [
            ...slotted.sort((a, b) => a[1] - b[1]).map(([n]) => n),
            ...cars.filter((n) => grid.get(n) == null).sort((a, b) => a - b)
        ]
        order.forEach((n, i) => {
            const p = out.get(n)
            if (p) p[0] = i + 1
        })
    }
    for (let n = 1; n <= last; n++) {
        const crossed = cars
            .flatMap((car) => {
                const t = valid(all.get(car) ?? [], n)
                return t == null ? [] : [{ car, t }]
            })
            .sort((a, b) => a.t - b.t)
        crossed.forEach(({ car }, i) => {
            const p = out.get(car)
            if (p) p[n] = i + 1
        })
    }
    return cars.map((driver) => {
        const positions = out.get(driver) ?? [null]
        const own = all.get(driver)?.length ?? 1
        // Through the car's own last lap: the laps after it are the ones it hasn't done (yet).
        positions.length = Math.max(own, 1)
        for (let n = 1; n < positions.length; n++)
            positions[n] = positions[n] ?? null
        const place = finished.get(driver)
        if (place != null && positions.length > 1)
            positions[positions.length - 1] = place
        return { driver, positions }
    })
}

/** Laps led: laps a car was first across the line at the end of, most first (ties by car number); none at 0. */
export function lapsLed(
    series: readonly LapPositions[]
): { driver: number; laps: number }[] {
    return series
        .map(({ driver, positions }) => ({
            driver,
            laps: positions.filter((p, n) => n > 0 && p === 1).length
        }))
        .filter((l) => l.laps > 0)
        .sort((a, b) => b.laps - a.laps || a.driver - b.driver)
}

/**
 * first[n] = the first crossing at the end of lap n by anyone: the leader's. Ends with the last lap anyone completed.
 * A crossing that can't be (before the car's own lap before, or before anyone had finished the lap before) is left out.
 */
export function leaderCrossings(all: readonly Crossings[]): (number | null)[] {
    const last = all.reduce((m, c) => Math.max(m, c.length - 1), 0)
    const first: (number | null)[] = [null]
    for (let n = 1; n <= last; n++) {
        const before = first[n - 1] ?? null
        let f: number | null = null
        for (const c of all) {
            const t = valid(c, n)
            if (t == null || (before != null && t <= before)) continue
            if (f == null || t < f) f = t
        }
        first.push(f)
    }
    while (first.length > 1 && first[first.length - 1] == null) first.pop()
    return first
}

// ---------------------------------------------------------------- neutral laps

export type Neutral = "SC" | "VSC" | "RED"

/** A safety car, VSC or red flag period, as useNeutralPeriods gives it: `end` is null while it's still out. */
export interface NeutralPeriod {
    status: Neutral
    start: number
    end: number | null
}

/**
 * laps[n]: whether the leader's lap n (from their crossing at lap n - 1, or lights out, to lap n) ran partly under a
 * red flag, a safety car or a VSC (in that order, when it saw more than one). One more entry than the leader's
 * completed laps: the lap in progress, which counts as running until now.
 */
export function neutralLaps(
    periods: readonly NeutralPeriod[],
    leader: readonly (number | null)[],
    lightsOut: number
): (Neutral | null)[] {
    const laps: (Neutral | null)[] = [null]
    for (let n = 1; n <= leader.length; n++) {
        const from = n === 1 ? lightsOut : leader[n - 1]
        const to = leader[n] ?? Infinity
        if (from == null) {
            laps.push(null)
            continue
        }
        const kinds = periods
            .filter((p) => p.start < to && (p.end ?? Infinity) > from)
            .map((p) => p.status)
        laps.push(
            (["RED", "SC", "VSC"] as const).find((k) => kinds.includes(k)) ??
                null
        )
    }
    return laps
}

/**
 * The order down the right-hand edge at lap `upTo`: each car at the last lap it completed by then, most laps first,
 * then its place on that lap. A car that retired before `upTo` (in `out`, its laps ending early) isn't in it.
 */
export function orderAt(
    series: readonly LapPositions[],
    upTo: number,
    out: ReadonlySet<number>
): number[] {
    return series
        .flatMap(({ driver, positions }) => {
            let n = Math.min(upTo, positions.length - 1)
            while (n > 0 && positions[n] == null) n--
            const p = positions[n]
            if (p == null || (n < upTo && out.has(driver))) return []
            return [{ driver, n, p }]
        })
        .sort((a, b) => b.n - a.n || a.p - b.p)
        .map((c) => c.driver)
}
