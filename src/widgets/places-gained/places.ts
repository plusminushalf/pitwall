// Places gained: each car's grid slot against where it is now (at the flag, where it finished), and against where it
// crossed the line at the end of lap 1. Pure: the widget feeds it what it has at t.
//
// A pit-lane starter has no grid slot; it starts behind the last car on the grid (two of them in car number order),
// so its gain counts from the back. A retired car keeps the place it had when it stopped, but its change isn't
// a result, so it sorts last.

/** The part of a car's state this needs. */
export interface CarIn {
    driver: number
    /** Grid slot; null: started from the pit lane. */
    grid: number | null
    /** Position now; null when not known. */
    position: number | null
    out: boolean
}

export interface PlaceRow {
    driver: number
    /** Grid slot as shown; null: the pit lane. */
    grid: number | null
    /** Where the car started from, pit-lane starters counted from the back. */
    start: number
    position: number | null
    out: boolean
    /** Places gained since the start (negative: lost); null without a position. */
    net: number | null
    /** Position at the end of lap 1; null until the car has crossed the line. */
    lap1: number | null
    /** Places gained on lap 1; null until the car has crossed the line. */
    lap1Net: number | null
}

/**
 * The order the cars finished lap 1 in, by the time each crossed the line: the first k to cross hold places 1..k
 * whoever is still to come, so a place is known as soon as the car is across.
 */
export function lap1Places(
    ends: ReadonlyMap<number, number>
): Map<number, number> {
    const order = [...ends].sort((a, b) => a[1] - b[1] || a[0] - b[0])
    return new Map(order.map(([driver], i) => [driver, i + 1]))
}

/** Every car's row: most places gained first, then by position; retired cars last, in the order they stood. */
export function placesGained(
    cars: readonly CarIn[],
    lap1: ReadonlyMap<number, number>
): PlaceRow[] {
    const back = Math.max(0, ...cars.map((c) => c.grid ?? 0))
    const pitStarters = cars
        .filter((c) => c.grid == null)
        .map((c) => c.driver)
        .sort((a, b) => a - b)
    const rows = cars.map((c): PlaceRow => {
        const start = c.grid ?? back + pitStarters.indexOf(c.driver) + 1
        const at1 = lap1.get(c.driver) ?? null
        return {
            driver: c.driver,
            grid: c.grid,
            start,
            position: c.position,
            out: c.out,
            net: c.position == null ? null : start - c.position,
            lap1: at1,
            lap1Net: at1 == null ? null : start - at1
        }
    })
    const pos = (r: PlaceRow) => r.position ?? Infinity
    return rows.sort(
        (a, b) =>
            Number(a.out) - Number(b.out) ||
            (a.out ? 0 : (b.net ?? -Infinity) - (a.net ?? -Infinity)) ||
            pos(a) - pos(b) ||
            a.start - b.start
    )
}
