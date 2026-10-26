// describe/test/expect are bun test's globals: a widget folder may only import react, widget-kit and its own
// files (bun run lint), so not "bun:test".

import {
    axisStart,
    type CarInput,
    gapText,
    type SpeedLap,
    teamSpeeds,
    topSpeeds
} from "./speeds"

/** A lap ending at t = n * 100 s with its speed points. */
function lap(
    n: number,
    st: number | null,
    i1: number | null = null,
    i2: number | null = null
): SpeedLap {
    return {
        lap: n,
        start: (n - 1) * 100_000,
        end: n * 100_000,
        speedTrap: { i1, i2, st }
    }
}

const ALO: CarInput = {
    driver: 14,
    laps: [lap(1, 340), lap(2, 351, 300, 310), lap(3, 349)],
    stints: [
        { lapStart: 1, compound: "MEDIUM", ageAtStart: 2 },
        { lapStart: 3, compound: "HARD", ageAtStart: 0 }
    ]
}
const RUS: CarInput = {
    driver: 63,
    laps: [lap(1, 345), lap(2, 349), lap(3, 351, 355)],
    stints: [{ lapStart: 1, compound: "SOFT", ageAtStart: 0 }]
}
const GAS: CarInput = {
    driver: 10,
    laps: [lap(1, null, 330, null)],
    stints: []
}

describe("topSpeeds", () => {
    test("each driver's highest speed trap, fastest first; a tie goes to whoever set it first", () => {
        const speeds = topSpeeds([RUS, ALO, GAS], "st")
        expect(speeds.map((s) => [s.driver, s.value, s.lap])).toEqual([
            [14, 351, 2],
            [63, 351, 3]
        ])
        expect(speeds[0]).toMatchObject({
            point: "st",
            compound: "MEDIUM",
            age: 3
        })
    })

    test("any: the highest of the trap and the intermediates, saying where", () => {
        const speeds = topSpeeds([RUS, ALO, GAS], "any")
        expect(speeds.map((s) => [s.driver, s.value, s.point])).toEqual([
            [63, 355, "i1"],
            [14, 351, "st"],
            [10, 330, "i1"]
        ])
    })

    test("leaves out laps not finished and readings of zero", () => {
        const car: CarInput = {
            driver: 1,
            laps: [lap(1, 0), { ...lap(2, 360), end: null }],
            stints: []
        }
        expect(topSpeeds([car], "st")).toEqual([])
    })
})

describe("teamSpeeds", () => {
    test("each team's quicker car", () => {
        const speeds = topSpeeds([RUS, ALO, GAS], "any")
        const team = new Map([
            [63, "Mercedes"],
            [14, "Aston Martin"],
            [10, "Mercedes"]
        ])
        expect(
            teamSpeeds(speeds, (n) => team.get(n)).map((r) => [
                r.team,
                r.speed.driver
            ])
        ).toEqual([
            ["Mercedes", 63],
            ["Aston Martin", 14]
        ])
    })
})

describe("axisStart", () => {
    test("a round number a little under the slowest", () => {
        expect(axisStart([351, 349, 338])).toBe(334)
        expect(axisStart([300, 300])).toBe(298)
    })

    test("a far slower car doesn't squash the others", () => {
        expect(axisStart([351, 349, 200])).toBe(300)
    })
})

describe("gapText", () => {
    test("the fastest and ties say so; the rest show km/h behind", () => {
        expect(gapText(351, 351)).toBe("Fastest")
        expect(gapText(351, 348)).toBe("−3 km/h")
    })
})
