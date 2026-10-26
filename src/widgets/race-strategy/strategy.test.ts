// describe/test/expect are bun test's globals: a widget folder may only import react, widget-kit and its own
// files (bun run lint), so not "bun:test".

import { leaderEnds, neutralRuns, type StintIn, stintBars } from "./strategy"

const stint = (
    stint: number,
    lapStart: number,
    lapEnd: number,
    compound: string,
    open = false,
    ageAtStart: number | null = 0
): StintIn => ({ stint, lapStart, lapEnd, compound, ageAtStart, open })

describe("stintBars", () => {
    test("a closed stint runs to the lap before the next, the open one to the last lap completed", () => {
        expect(
            stintBars(
                [stint(1, 1, 20, "MEDIUM"), stint(2, 21, 33, "HARD", true, 3)],
                32
            )
        ).toEqual([
            {
                stint: 1,
                compound: "MEDIUM",
                from: 0,
                to: 20,
                age: 0,
                open: false
            },
            { stint: 2, compound: "HARD", from: 20, to: 32, age: 3, open: true }
        ])
    })

    test("a stint just started is empty, not backwards", () => {
        const bars = stintBars(
            [stint(1, 1, 20, "SOFT"), stint(2, 21, 21, "HARD", true)],
            20
        )
        expect(bars[1]).toMatchObject({ from: 20, to: 20 })
    })

    test("a stint the next one overlaps ends where the next starts", () => {
        const bars = stintBars(
            [stint(1, 1, 22, "SOFT"), stint(2, 21, 40, "HARD", true)],
            40
        )
        expect(bars[0].to).toBe(20)
    })
})

describe("leaderEnds", () => {
    test("the first crossing of each lap by anyone", () => {
        expect(
            leaderEnds([
                [
                    { lap: 1, end: 90 },
                    { lap: 2, end: 181 }
                ],
                [
                    { lap: 1, end: 91 },
                    { lap: 2, end: 180 },
                    { lap: 3, end: null }
                ]
            ])
        ).toEqual([null, 90, 180])
    })
})

describe("neutralRuns", () => {
    const leader = [null, 90_000, 180_000, 270_000, 360_000]
    test("runs of laps by kind; a red flag wins over a safety car, a safety car over a VSC", () => {
        expect(
            neutralRuns(
                [
                    { status: "VSC", start: 20_000, end: 30_000 },
                    { status: "SC", start: 150_000, end: 250_000 },
                    { status: "RED", start: 255_000, end: 300_000 }
                ],
                leader,
                0
            )
        ).toEqual([
            { kind: "VSC", from: 1, to: 1 },
            { kind: "SC", from: 2, to: 2 },
            { kind: "RED", from: 3, to: 4 }
        ])
    })

    test("the lap in progress counts to now", () => {
        expect(
            neutralRuns(
                [{ status: "SC", start: 400_000, end: null }],
                leader,
                0
            )
        ).toEqual([{ kind: "SC", from: 5, to: 5 }])
    })
})
