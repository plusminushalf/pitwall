// describe/test/expect are bun test's globals: a widget folder may only import react, widget-kit and its own
// files (bun run lint), so not "bun:test".

import type { Lap, LiveQualiSegment } from "widget-kit"
import { gridOf, nameParts } from "./grid"

const seg = (number: number, start: number): LiveQualiSegment => ({
    number,
    name: `Q${number}`,
    start,
    end: start + 600_000,
    advance: number === 1 ? 3 : number === 2 ? 2 : null,
    length: 600_000,
    stopped: []
})
const Q1 = seg(1, 0)
const Q2 = seg(2, 1_000_000)

const lap = (driver: number, start: number, duration: number | null): Lap => ({
    driver,
    lap: 1,
    start,
    end: duration == null ? null : start + duration * 1000,
    duration,
    sectors: [null, null, null],
    segments: [[], [], []],
    speedTrap: { i1: null, i2: null, st: null },
    pitOut: false
})

describe("gridOf", () => {
    test("in Q2: the cars in it by their Q2 time, then the car out in Q1 with its Q1 time", () => {
        const laps = new Map([
            [1, [lap(1, 100_000, 80), lap(1, 1_100_000, 79.5)]],
            [2, [lap(2, 100_000, 80.2), lap(2, 1_100_000, 79.1)]],
            [3, [lap(3, 100_000, 79), lap(3, 1_100_000, 79.8)]],
            [4, [lap(4, 100_000, 81)]]
        ])
        // The timing screen's order: car 4 knocked out in Q1, in P4.
        const grid = gridOf(
            [1, 2, 3, 4],
            laps,
            Q2,
            [{ segment: Q1, from: 4, to: 4 }],
            Infinity
        )
        expect(
            grid.map((s) => [s.driver, s.position, s.time, s.segment])
        ).toEqual([
            [2, 1, 79.1, "Q2"],
            [1, 2, 79.5, "Q2"],
            [3, 3, 79.8, "Q2"],
            [4, 4, 81, "Q1"]
        ])
    })

    test("a car without a time goes after those with one, and a lap deleted by then doesn't count", () => {
        const laps = new Map([
            [1, [lap(1, 100_000, 80)]],
            [
                2,
                [
                    {
                        ...lap(2, 100_000, 79),
                        deleted: { t: 200_000, reason: "TRACK LIMITS" }
                    }
                ]
            ],
            [3, [lap(3, 100_000, 80.5)]]
        ])
        const grid = gridOf([2, 1, 3], laps, Q1, [], 300_000)
        expect(grid.map((s) => [s.driver, s.time])).toEqual([
            [1, 80],
            [3, 80.5],
            [2, null]
        ])
    })
})

describe("nameParts", () => {
    test("the surname is the words in capitals", () => {
        expect(nameParts("Lewis HAMILTON", "HAM")).toEqual({
            first: "Lewis",
            last: "HAMILTON"
        })
        expect(nameParts("Andrea Kimi ANTONELLI", "ANT")).toEqual({
            first: "Andrea Kimi",
            last: "ANTONELLI"
        })
        expect(nameParts("ZHOU Guanyu", "ZHO")).toEqual({
            first: "",
            last: "ZHOU Guanyu"
        })
        expect(nameParts("", "XYZ")).toEqual({ first: "", last: "XYZ" })
    })
})
