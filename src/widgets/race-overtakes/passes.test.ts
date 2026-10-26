// Passes counted from made-up overtakes. describe/test/expect are bun test's globals: a widget folder may only
// import react, widget-kit and its own files (bun run lint), so not "bun:test".

import {
    countPasses,
    type PassInputs,
    PIT_MARGIN_MS,
    RETIRING_MS
} from "./passes"

const pass = (t: number, driver: number, passed: number) => ({
    t,
    driver,
    passed
})

const inputs = (more: Partial<PassInputs>): PassInputs => ({
    passes: [],
    pits: new Map(),
    retired: new Map(),
    drivers: [1, 16, 44],
    from: null,
    ...more
})

describe("countPasses", () => {
    test("counts passes made and lost, most made first", () => {
        const c = countPasses(
            inputs({
                passes: [
                    pass(100_000, 44, 16),
                    pass(200_000, 44, 1),
                    pass(300_000, 1, 44)
                ]
            })
        )
        expect(c.total).toBe(3)
        expect(c.rows).toEqual([
            { driver: 44, made: 2, lost: 1 },
            { driver: 1, made: 1, lost: 1 },
            { driver: 16, made: 0, lost: 1 }
        ])
    })

    test("every driver gets a row, passes or not", () => {
        const c = countPasses(inputs({}))
        expect(c.rows.map((r) => r.driver)).toEqual([1, 16, 44])
        expect(c.total).toBe(0)
    })

    test("leaves out swaps with either car in the pit lane, a few seconds either side", () => {
        const c = countPasses(
            inputs({
                passes: [
                    pass(100_000 - PIT_MARGIN_MS + 1, 44, 16), // 16 about to enter
                    pass(120_000, 16, 1), // 16 in the lane passing
                    pass(125_000 + PIT_MARGIN_MS + 1, 44, 1) // after the margin
                ],
                pits: new Map([[16, [{ entry: 100_000, exit: 125_000 }]]])
            })
        )
        expect(c.pits).toBe(2)
        expect(c.total).toBe(1)
    })

    test("leaves out passes on a car about to retire, and after", () => {
        const c = countPasses(
            inputs({
                passes: [
                    pass(500_000 - RETIRING_MS - 1, 44, 1),
                    pass(500_000 - 10_000, 16, 1),
                    pass(600_000, 44, 1)
                ],
                retired: new Map([[1, 500_000]])
            })
        )
        expect(c.retiring).toBe(2)
        expect(c.total).toBe(1)
        expect(c.rows[0]).toEqual({ driver: 44, made: 1, lost: 0 })
    })

    test("leaves out lap 1 when asked", () => {
        const passes = [pass(50_000, 44, 1), pass(150_000, 16, 1)]
        const c = countPasses(inputs({ passes, from: 100_000 }))
        expect(c.lap1).toBe(1)
        expect(c.total).toBe(1)
        expect(countPasses(inputs({ passes, from: Infinity })).total).toBe(0)
    })
})
