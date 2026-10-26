// describe/test/expect are bun test's globals: a widget folder may only import react, widget-kit and its own
// files (bun run lint), so not "bun:test".

import {
    type Crossings,
    crossingsOf,
    lapPositions,
    lapsLed,
    leaderCrossings,
    neutralLaps,
    orderAt
} from "./chart"

// Crossings in seconds from lights out at t = 0 (index = lap), as ms.
const at = (...s: (number | null)[]): Crossings => [
    null,
    ...s.map((v) => (v == null ? null : v * 1000))
]

// Car 1 leads to lap 3, car 2 passes it on lap 4. Car 3 retires after lap 2. Car 4 is lapped by car 2 on lap 3
// (car 2 finishes lap 4 at 360 s, before car 4 finishes lap 3 at 365 s).
const all = new Map<number, Crossings>([
    [1, at(90, 180, 270, 361)],
    [2, at(91, 181, 270.5, 360)],
    [3, at(95, 186)],
    [4, at(110, 230, 365)]
])
const grid = new Map<number, number | null>([
    [1, 2],
    [2, 1],
    [3, 3],
    [4, 4]
])
const byCar = (g = grid) =>
    Object.fromEntries(lapPositions(all, g).map((s) => [s.driver, s.positions]))

describe("crossingsOf", () => {
    test("each lap's end at its number, gaps for laps not there", () => {
        expect(
            crossingsOf([
                { lap: 1, end: 100 },
                { lap: 3, end: 300 }
            ])
        ).toEqual([null, 100, null, 300])
    })
})

describe("lapPositions", () => {
    test("the grid, then the order across the line on each lap", () => {
        expect(byCar()).toEqual({
            1: [2, 1, 1, 1, 2],
            2: [1, 2, 2, 2, 1],
            3: [3, 3, 3],
            4: [4, 4, 4, 3]
        })
    })

    test("a lapped car is behind the cars a lap up, the retired car's laps aren't counted", () => {
        // Lap 3: car 4 crosses at 365 s, after cars 1 and 2 (car 3 is out): third.
        expect(byCar()[4][3]).toBe(3)
    })

    test("a car with no grid slot starts behind those with one; no grid at all, no lap 0", () => {
        const g = new Map<number, number | null>([
            [1, 1],
            [2, 2],
            [3, null],
            [4, 3]
        ])
        expect(byCar(g)[3][0]).toBe(4)
        expect(byCar(g)[4][0]).toBe(3)
        expect(byCar(new Map())[1][0]).toBeNull()
    })

    test("a car that has taken the flag takes its place on its last lap", () => {
        const flag = new Map<number, Crossings>([
            [1, at(90, 180.002)],
            [2, at(91, 180)]
        ])
        const s = lapPositions(
            flag,
            new Map(),
            new Map([
                [1, 1],
                [2, 2]
            ])
        )
        expect(s.map((c) => c.positions)).toEqual([
            [null, 1, 1],
            [null, 2, 2]
        ])
    })

    test("a crossing before the car's own lap before is left out", () => {
        const odd = new Map<number, Crossings>([
            [1, at(90, 80)],
            [2, at(91, 181)]
        ])
        const s = lapPositions(odd, new Map())
        expect(s[0].positions).toEqual([null, 1, null])
        expect(s[1].positions).toEqual([null, 2, 1])
    })
})

describe("lapsLed", () => {
    test("laps first across the line, most first", () => {
        expect(lapsLed(lapPositions(all, grid))).toEqual([
            { driver: 1, laps: 3 },
            { driver: 2, laps: 1 }
        ])
    })
})

describe("leaderCrossings", () => {
    test("the first crossing on each lap", () => {
        expect(leaderCrossings([...all.values()])).toEqual([
            null,
            90_000,
            180_000,
            270_000,
            360_000
        ])
    })
})

describe("neutralLaps", () => {
    const leader = [null, 90_000, 180_000, 270_000]
    test("a red flag wins over a safety car, a safety car over a VSC; the lap in progress counts to now", () => {
        expect(
            neutralLaps(
                [
                    { status: "VSC", start: 100_000, end: 120_000 },
                    { status: "SC", start: 150_000, end: 200_000 },
                    { status: "RED", start: 280_000, end: null }
                ],
                leader,
                0
            )
        ).toEqual([null, null, "SC", "SC", "RED"])
    })
})

describe("orderAt", () => {
    const series = lapPositions(all, grid)
    test("by laps, then place; a car out before the lap isn't in it", () => {
        expect(orderAt(series, 4, new Set([3]))).toEqual([2, 1, 4])
        expect(orderAt(series, 2, new Set([3]))).toEqual([1, 2, 3, 4])
    })
    test("lap 0: the grid", () => {
        expect(orderAt(series, 0, new Set())).toEqual([2, 1, 3, 4])
    })
})
