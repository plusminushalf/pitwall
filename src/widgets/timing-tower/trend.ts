// Whether each car gained or lost on the car ahead over its last lap, from lap-line crossing times. Pure, no
// imports, so its test needs no widget-kit.

/** crossings[n] = when the car crossed the line to finish lap n (ms), or null; index 0 is unused. */
export type Crossings = readonly (number | null)[]

/** A span the interval says nothing about pace in: a pit stop (entry to exit), a safety car, VSC or red flag. */
export interface Span {
    start: number
    end: number | null
}

/** Less than this (seconds) over a lap is holding station: no trend. */
export const TREND_MIN = 0.1

/** How a car's interval changed over its last lap: negative is closing on the car ahead. */
export interface Trend {
    /** The car ahead, the same at both lines. */
    ahead: number
    /** The lap the change is over. */
    lap: number
    /** Seconds: the interval at the end of `lap` minus at the end of the lap before. */
    delta: number
}

/** The car that crossed at lap n just before `t` (the car ahead in the order at that line), or null. */
function aheadAt(
    all: ReadonlyMap<number, Crossings>,
    n: number,
    t: number
): { driver: number; t: number } | null {
    let best: { driver: number; t: number } | null = null
    for (const [driver, c] of all) {
        const at = c[n]
        if (at != null && at < t && (best == null || at > best.t))
            best = { driver, t: at }
    }
    return best
}

const overlaps = (spans: readonly Span[], from: number, to: number) =>
    spans.some((s) => s.start < to && (s.end ?? Infinity) > from)

/**
 * The trend of `driver`'s interval over its last completed lap: its gap to the car that crossed just before it
 * at that line, against the same gap a lap earlier. None (null) on the first lap, when the car ahead at the two
 * lines differs (a pass, a stop) or isn't `ahead` (the car ahead now, when given), when either car stopped in
 * the pits over that lap (`pits` by driver), or when a neutral period (`neutral`) ran during it.
 */
export function intervalTrend(
    all: ReadonlyMap<number, Crossings>,
    driver: number,
    pits: ReadonlyMap<number, readonly Span[]>,
    neutral: readonly Span[],
    ahead?: number | null
): Trend | null {
    const own = all.get(driver)
    if (!own) return null
    let n = own.length - 1
    while (n > 0 && own[n] == null) n--
    const now = own[n]
    const before = own[n - 1]
    if (n < 2 || now == null || before == null) return null
    const a = aheadAt(all, n, now)
    const b = aheadAt(all, n - 1, before)
    if (!a || !b || a.driver !== b.driver) return null
    if (ahead != null && a.driver !== ahead) return null
    // From the first of the two lines at the lap before to this car's line now.
    const from = b.t
    if (
        overlaps(neutral, from, now) ||
        overlaps(pits.get(driver) ?? [], from, now) ||
        overlaps(pits.get(a.driver) ?? [], from, now)
    )
        return null
    const delta = (now - a.t - (before - b.t)) / 1000
    return { ahead: a.driver, lap: n, delta }
}
