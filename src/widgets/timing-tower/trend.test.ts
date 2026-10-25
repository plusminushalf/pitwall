// describe/test/expect are bun test's globals: a widget folder may only import react, widget-kit and its own
// files (bun run lint), so not "bun:test".

import { type Crossings, intervalTrend } from "./trend"

const NONE = new Map()

// Car 1 leads, car 2 runs behind it: 2.0 s at the end of lap 1, 1.6 s at lap 2, 1.9 s at lap 3.
const all = new Map<number, Crossings>([
    [1, [null, 100_000, 190_000, 280_000]],
    [2, [null, 102_000, 191_600, 281_900]]
])

describe("intervalTrend", () => {
    test("closing on the car ahead is negative, over the last completed lap", () => {
        const two = new Map(all)
        two.set(2, [null, 102_000, 191_600])
        expect(intervalTrend(two, 2, NONE, [])?.delta).toBeCloseTo(-0.4)
        expect(intervalTrend(two, 2, NONE, [])?.ahead).toBe(1)
    })

    test("losing time is positive", () => {
        const t = intervalTrend(all, 2, NONE, [])
        expect(t?.delta).toBeCloseTo(0.3)
        expect(t?.lap).toBe(3)
    })

    test("the leader and the first lap have none", () => {
        expect(intervalTrend(all, 1, NONE, [])).toBeNull()
        const one = new Map<number, Crossings>([
            [1, [null, 100_000]],
            [2, [null, 102_000]]
        ])
        expect(intervalTrend(one, 2, NONE, [])).toBeNull()
    })

    test("a different car ahead at the two lines (a pass) has none", () => {
        const passed = new Map<number, Crossings>([
            [1, [null, 100_000, 190_000, 280_000]],
            [2, [null, 102_000, 191_600, 281_900]],
            [3, [null, 101_000, 192_000, 281_000]]
        ])
        // Car 2 was behind 1 at the end of lap 2, then 3 passed it: behind 3 at lap 3.
        expect(intervalTrend(passed, 2, NONE, [])).toBeNull()
        // Car 3 was behind 2 at lap 2 and is behind 1 at lap 3: none either.
        expect(intervalTrend(passed, 3, NONE, [])).toBeNull()
    })

    test("not the car ahead now: none", () => {
        expect(intervalTrend(all, 2, NONE, [], 44)).toBeNull()
        expect(intervalTrend(all, 2, NONE, [], 1)?.delta).toBeCloseTo(0.3)
    })

    test("a pit stop by either car or a safety car over the lap: none", () => {
        const stop = [{ start: 260_000, end: 262_000 }]
        expect(intervalTrend(all, 2, new Map([[2, stop]]), [])).toBeNull()
        expect(intervalTrend(all, 2, new Map([[1, stop]]), [])).toBeNull()
        expect(
            intervalTrend(all, 2, NONE, [{ start: 250_000, end: null }])
        ).toBeNull()
        // A stop before the lap doesn't count.
        const earlier = [{ start: 150_000, end: 170_000 }]
        expect(
            intervalTrend(all, 2, new Map([[2, earlier]]), [])
        ).not.toBeNull()
    })
})
