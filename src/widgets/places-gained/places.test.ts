// Places gained on made-up grids. describe/test/expect are bun test's globals: a widget folder may only import
// react, widget-kit and its own files (bun run lint), so not "bun:test".

import { type CarIn, lap1Places, placesGained } from "./places"

const car = (
    driver: number,
    grid: number | null,
    position: number | null,
    out = false
): CarIn => ({ driver, grid, position, out })

describe("lap1Places", () => {
    test("ranks the cars by when they crossed the line", () => {
        const places = lap1Places(
            new Map([
                [44, 92_000],
                [1, 90_000],
                [16, 91_000]
            ])
        )
        expect([...places]).toEqual([
            [1, 1],
            [16, 2],
            [44, 3]
        ])
    })

    test("a car still on lap 1 has no place yet", () => {
        expect(lap1Places(new Map([[1, 90_000]])).get(44)).toBeUndefined()
    })
})

describe("placesGained", () => {
    test("most places gained first, then by position", () => {
        const rows = placesGained(
            [car(1, 1, 3), car(16, 2, 1), car(44, 5, 2), car(4, 3, 4)],
            new Map()
        )
        expect(rows.map((r) => [r.driver, r.net])).toEqual([
            [44, 3],
            [16, 1],
            [4, -1],
            [1, -2]
        ])
    })

    test("pit-lane starters count from behind the last grid slot, in car number order", () => {
        const rows = placesGained(
            [car(1, 1, 1), car(16, 2, 3), car(44, null, 2), car(4, null, 4)],
            new Map()
        )
        const of = (n: number) => rows.find((r) => r.driver === n)
        expect(of(4)).toMatchObject({ grid: null, start: 3, net: -1 })
        expect(of(44)).toMatchObject({ grid: null, start: 4, net: 2 })
    })

    test("retired cars go last, in the order they stood", () => {
        const rows = placesGained(
            [car(1, 1, 3, true), car(16, 2, 1), car(44, 3, 2, true)],
            new Map()
        )
        expect(rows.map((r) => r.driver)).toEqual([16, 44, 1])
    })

    test("lap 1 gains from the order across the line", () => {
        const rows = placesGained(
            [car(1, 1, 1), car(16, 2, 2), car(44, 3, 3)],
            new Map([
                [44, 1],
                [1, 2]
            ])
        )
        const of = (n: number) => rows.find((r) => r.driver === n)
        expect(of(44)).toMatchObject({ lap1: 1, lap1Net: 2 })
        expect(of(1)).toMatchObject({ lap1: 2, lap1Net: -1 })
        expect(of(16)).toMatchObject({ lap1: null, lap1Net: null })
    })

    test("no position yet: no change", () => {
        const [row] = placesGained([car(1, 4, null)], new Map())
        expect(row.net).toBeNull()
    })
})
