// Overtake Mode from line crossings, on synthetic laps. describe/test/expect are bun test's globals: a widget folder
// may only import react, widget-kit and its own files (bun run lint), so not "bun:test".
import { type LapStart, overtakeModeLaps, overtakeSwitch } from "./overtakeMode"

const lap = (
    driver: number,
    n: number,
    start: number,
    pitOut = false
): LapStart => ({
    driver,
    lap: n,
    start,
    pitOut
})

describe("overtake mode", () => {
    const on = [{ t: 0, on: true }]

    test("within a second at the line before the lap", () => {
        const laps = [
            lap(1, 2, 100_000),
            lap(16, 2, 100_800),
            lap(12, 2, 102_500)
        ]
        const got = overtakeModeLaps(laps, on, [16, 12])
        expect(got.get(16)?.get(2)).toEqual({ ahead: 1, gap: 0.8 })
        expect(got.get(12)).toBeUndefined()
    })

    test("a lapped car ahead counts; lap 1 and pit lane crossings don't", () => {
        const laps = [
            lap(30, 7, 50_000),
            lap(16, 9, 50_500),
            lap(1, 1, 0),
            lap(16, 1, 300),
            lap(44, 4, 70_000, true),
            lap(12, 5, 70_400)
        ]
        const got = overtakeModeLaps(laps, on, [16, 12])
        expect(got.get(16)?.get(9)).toEqual({ ahead: 30, gap: 0.5 })
        expect(got.get(16)?.has(1)).toBe(false)
        expect(got.get(12)).toBeUndefined()
    })

    test("only while race control has it enabled", () => {
        const laps = [
            lap(1, 2, 10_000),
            lap(16, 2, 10_500),
            lap(1, 3, 30_000),
            lap(16, 3, 30_500)
        ]
        const switches = [
            { t: 0, on: false },
            { t: 20_000, on: true }
        ]
        const got = overtakeModeLaps(laps, switches, [16])
        expect([...(got.get(16)?.keys() ?? [])]).toEqual([3])
        // Before 2026 there are no switches: nothing.
        expect(overtakeModeLaps(laps, [], [16]).size).toBe(0)
    })

    test("race control's messages", () => {
        expect(overtakeSwitch("OVERTAKE ENABLED")).toBe(true)
        expect(overtakeSwitch("OVERTAKE DISABLED")).toBe(false)
        expect(
            overtakeSwitch("LAPPED CARS MAY NOW OVERTAKE THE SAFETY CAR: 55")
        ).toBe(null)
    })
})
