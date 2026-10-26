// describe/test/expect are bun test's globals: a widget folder may only import react, widget-kit and its own
// files (bun run lint), so not "bun:test".

import {
    axisStart,
    type CarInput,
    type CrewStop,
    crews,
    measuresIn,
    redCount
} from "./crews"

/** A stop on `lap`, entering at `entry` s. */
function stop(
    lap: number,
    entry: number,
    lane: number | null,
    stationary: number | null = null
): CrewStop {
    const ms = (lane ?? 20) * 1000
    return {
        lap,
        entry: entry * 1000,
        exit: entry * 1000 + ms,
        laneDuration: lane,
        stopDuration: stationary
    }
}

const NOR: CarInput = {
    driver: 4,
    team: "McLaren",
    pits: [stop(20, 2000, 20.6, 2.4), stop(40, 4000, 21.0, 2.1)]
}
const PIA: CarInput = {
    driver: 81,
    team: "McLaren",
    pits: [stop(22, 2200, 20.9, 3.0)]
}
const HAM: CarInput = {
    driver: 44,
    team: "Ferrari",
    pits: [stop(18, 1800, 20.2, null), stop(35, 3500, 24.0, 2.3)]
}

describe("crews", () => {
    test("each team's quickest stop, median and count, the quickest team first", () => {
        const table = crews([NOR, PIA, HAM], "stop", [])
        expect(
            table.map((c) => [c.team, c.best.driver, c.best.lap, c.best.value])
        ).toEqual([
            ["McLaren", 4, 40, 2.1],
            ["Ferrari", 44, 35, 2.3]
        ])
        expect(table[0]).toMatchObject({ median: 2.4, count: 3 })
        expect(table[1]).toMatchObject({ median: 2.3, count: 1 })
    })

    test("by pit lane time", () => {
        expect(
            crews([NOR, PIA, HAM], "lane", []).map((c) => [
                c.team,
                c.best.value,
                c.count
            ])
        ).toEqual([
            ["Ferrari", 20.2, 2],
            ["McLaren", 20.6, 3]
        ])
    })

    test("stops in the lane while a red flag was out don't count", () => {
        const reds = [{ start: 1_810_000, end: 2_500_000 }]
        const table = crews([NOR, PIA, HAM], "lane", reds)
        expect(table.map((c) => [c.team, c.best.value, c.count])).toEqual([
            ["McLaren", 21.0, 1],
            ["Ferrari", 24.0, 1]
        ])
        expect(redCount([NOR, PIA, HAM], reds)).toBe(3)
        // Still out: everything since it came out.
        expect(
            redCount([NOR, PIA, HAM], [{ start: 3_900_000, end: null }])
        ).toBe(1)
    })
})

describe("measuresIn", () => {
    test("which times the stops have", () => {
        expect(measuresIn([NOR])).toEqual({ stop: true, lane: true })
        expect(
            measuresIn([{ driver: 1, team: "X", pits: [stop(5, 500, 21)] }])
        ).toEqual({ stop: false, lane: true })
        expect(measuresIn([])).toEqual({ stop: false, lane: false })
    })
})

describe("axisStart", () => {
    test("a half second a little under the quickest", () => {
        expect(axisStart([2.1, 2.4, 3.5])).toBe(1.5)
        expect(axisStart([20.6, 23])).toBe(19.5)
    })
})
