// describe/test/expect are bun test's globals: a widget folder may only import react, widget-kit and its own
// files (bun run lint), so not "bun:test".

import type { NeutralPeriod } from "widget-kit"
import {
    cleanLaps,
    quantile,
    type SpreadLap,
    spreadOf,
    spreads,
    ticks
} from "./spread"

/** Laps back to back from t = 0, numbered from 1; null untimed (100 s), "o" an out-lap. */
function lapsOf(specs: (number | "o" | null)[]): SpreadLap[] {
    let start = 0
    return specs.map((s, i) => {
        const duration = s === "o" ? 120 : s
        const lap = {
            lap: i + 1,
            start,
            end: start + (duration ?? 100) * 1000,
            duration,
            pitOut: s === "o"
        }
        start = lap.end
        return lap
    })
}

describe("cleanLaps", () => {
    test("leaves out lap 1, untimed laps, in-laps and out-laps", () => {
        const laps = lapsOf([110, 95, null, 96, 99, "o", 97])
        // Lap 5 is an in-lap: the next is an out-lap.
        expect(cleanLaps(laps, [{ lapStart: 1 }], [])).toEqual([95, 96, 97])
    })

    test("a later stint's first lap is an out-lap, the lap before it an in-lap", () => {
        const laps = lapsOf([110, 95, 96, 97, 98, 99])
        expect(cleanLaps(laps, [{ lapStart: 1 }, { lapStart: 5 }], [])).toEqual(
            [95, 96, 99]
        )
    })

    test("leaves out laps a neutral period touches, an open one too", () => {
        const laps = lapsOf([110, 95, 96, 97, 98])
        const sc: NeutralPeriod = { status: "SC", start: 210_000, end: 220_000 }
        const vsc: NeutralPeriod = { status: "VSC", start: 400_000, end: null }
        // Lap 3 runs 205..301 s, lap 5 398..496 s.
        expect(cleanLaps(laps, [{ lapStart: 1 }], [sc, vsc])).toEqual([95, 97])
    })

    test("leaves out laps over 107% of the driver's quickest", () => {
        const laps = lapsOf([110, 90, 96, 96.4, 91])
        expect(cleanLaps(laps, [{ lapStart: 1 }], [])).toEqual([90, 96, 91])
    })
})

describe("spreadOf", () => {
    test("quartiles interpolate between laps", () => {
        expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5)
        expect(quantile([1, 2, 3, 4, 5], 0.25)).toBe(2)
    })

    test("none under five laps", () => {
        expect(spreadOf(1, [90, 91, 92, 93])).toBeNull()
    })

    test("laps past 1.5 IQR are outliers, the whiskers stop at the last lap inside", () => {
        const s = spreadOf(1, [90, 90.2, 90.4, 90.6, 90.8, 93])
        expect(s).toMatchObject({
            laps: 6,
            median: 90.5,
            low: 90,
            high: 90.8,
            outliers: [93],
            best: 90
        })
    })
})

describe("spreads", () => {
    const quick = lapsOf([100, 90, 90.1, 90.2, 90.3, 90.4])
    const slow = lapsOf([100, 91, 91.1, 91.2, 91.3, 91.4])
    const few = lapsOf([100, 89, 89.1])
    const cars = [
        { driver: 2, team: "B", laps: slow, stints: [{ lapStart: 1 }] },
        { driver: 1, team: "A", laps: quick, stints: [{ lapStart: 1 }] },
        { driver: 3, team: "A", laps: few, stints: [{ lapStart: 1 }] }
    ]

    test("by driver, lowest median first, short cars counted", () => {
        const { rows, short } = spreads(cars, [], "drivers")
        expect(rows.map((r) => r.key)).toEqual([1, 2])
        expect(short).toBe(1)
    })

    test("by team, both cars' laps in one box", () => {
        const { rows } = spreads(cars, [], "teams")
        expect(rows.map((r) => [r.key, r.laps])).toEqual([
            ["A", 7],
            ["B", 5]
        ])
    })
})

test("ticks pick a step that fits", () => {
    expect(ticks(90.2, 91.9, 6)).toEqual([90.5, 91, 91.5])
    expect(ticks(90, 96, 4)).toEqual([90, 92, 94, 96])
})
