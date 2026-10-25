// describe/test/expect are bun test's globals: a widget folder may only import react, widget-kit and its own
// files (bun run lint), so not "bun:test".

import type { NeutralPeriod } from "widget-kit"
import {
    type Best,
    bestLap,
    crossingsOf,
    type FitLap,
    fitLaps,
    fitPace,
    gapAhead,
    leftOf,
    type PaceLap,
    type PaceStint,
    paceRows,
    racePaces,
    raceRows,
    tyreOf,
    validLaps,
    watching,
    withPin
} from "./pace"

/** The value, or the test fails here. */
function must<T>(v: T | null | undefined): T {
    if (v == null) throw new Error("expected a value")
    return v
}

/** A lap's spec: its sectors (the duration is their sum), "o" an out-lap, null untimed. */
type Spec = [number, number, number] | "o" | null

/** Laps back to back from t = 0 (an untimed lap takes 100 s, an out-lap 120 s), numbered from 1. */
function lapsOf(
    specs: Spec[],
    extra: Partial<Record<number, Partial<PaceLap>>> = {}
): PaceLap[] {
    let start = 0
    return specs.map((s, i) => {
        const sectors = Array.isArray(s) ? s : ([null, null, null] as const)
        const duration = Array.isArray(s) ? s[0] + s[1] + s[2] : null
        const ms = (duration ?? (s === "o" ? 120 : 100)) * 1000
        const lap: PaceLap = {
            lap: i + 1,
            start,
            end: start + ms,
            duration,
            sectors,
            pitOut: s === "o",
            ...extra[i + 1]
        }
        start += ms
        return lap
    })
}

const soft: PaceStint[] = [{ lapStart: 1, compound: "SOFT", ageAtStart: 0 }]

describe("valid laps", () => {
    test("out-laps, in-laps and untimed laps don't count", () => {
        // Out, push, cool-down, push, in; out on a new set, push, (in-lap under way).
        const laps = lapsOf([
            "o",
            [30, 40, 20],
            [40, 50, 30],
            [29, 40, 21],
            null,
            "o",
            [30, 39, 20]
        ])
        const stints: PaceStint[] = [
            { lapStart: 1, compound: "SOFT", ageAtStart: 0 },
            { lapStart: 6, compound: "MEDIUM", ageAtStart: 2 }
        ]
        expect(validLaps(laps, stints, [], 0).map((l) => l.lap)).toEqual([
            2, 3, 4, 7
        ])
        // A timed in-lap: the lap before an out-lap, or before a new stint.
        const timed = lapsOf([
            "o",
            [30, 40, 20],
            [30, 40, 25],
            "o",
            [30, 40, 20],
            [31, 40, 20]
        ])
        const two: PaceStint[] = [
            { lapStart: 1, compound: "SOFT", ageAtStart: 0 },
            { lapStart: 6, compound: "SOFT", ageAtStart: 0 }
        ]
        expect(validLaps(timed, soft, [], 0).map((l) => l.lap)).toEqual([
            2, 5, 6
        ])
        expect(validLaps(timed, two, [], 0).map((l) => l.lap)).toEqual([2])
    })

    test("laps touched by a safety car, VSC or red flag don't count", () => {
        const laps = lapsOf(["o", [30, 40, 20], [30, 40, 20], [30, 40, 20]])
        // A red flag from the middle of lap 3 (120 + 90 + 45 s) to its end; an open VSC from late in lap 4.
        const neutral: NeutralPeriod[] = [
            { status: "RED", start: 255_000, end: 300_000 },
            { status: "VSC", start: 385_000, end: null }
        ]
        expect(validLaps(laps, soft, neutral, 0).map((l) => l.lap)).toEqual([2])
    })

    test("a deleted lap counts until it's deleted", () => {
        const laps = lapsOf(["o", [30, 40, 20], [29, 40, 20]], {
            3: { deleted: { t: 400_000 } }
        })
        expect(validLaps(laps, soft, [], 399_999).map((l) => l.lap)).toEqual([
            2, 3
        ])
        expect(validLaps(laps, soft, [], 400_000).map((l) => l.lap)).toEqual([
            2
        ])
    })
})

describe("best lap", () => {
    test("the quickest valid lap, its set and age, and the ideal lap from the best sectors", () => {
        const laps = lapsOf([
            "o",
            [30.1, 40.2, 20.3],
            [40, 50, 30],
            [29.9, 40.4, 20.1],
            null
        ])
        const stints: PaceStint[] = [
            { lapStart: 1, compound: "SOFT", ageAtStart: 3 }
        ]
        const b = must(bestLap(4, laps, stints, [], 0))
        expect(b).toMatchObject({
            driver: 4,
            lap: 4,
            compound: "SOFT",
            age: 6,
            start: (120 + 90.6 + 120) * 1000
        })
        expect(b.time).toBeCloseTo(90.4, 6)
        expect(b.ideal).toBeCloseTo(29.9 + 40.2 + 20.1, 6)
        expect(leftOf(b)).toBeCloseTo(0.2, 6)
    })

    test("sectors of laps that don't count aren't in the ideal lap; a missing sector leaves it unknown", () => {
        // The out-lap's and the deleted lap's quick sectors aren't used.
        const laps = lapsOf(["o", [30, 40, 20], [28, 39, 19]], {
            1: { sectors: [1, 1, 1] },
            3: { deleted: { t: 0 } }
        })
        expect(bestLap(4, laps, soft, [], 0)?.ideal).toBeCloseTo(90, 6)
        const gap = lapsOf(["o", [30, 40, 20]], {
            2: { sectors: [30, null, 20] }
        })
        const b = must(bestLap(4, gap, soft, [], 0))
        expect(b.ideal).toBeNull()
        expect(leftOf(b)).toBeNull()
    })

    test("none without a valid lap", () => {
        expect(bestLap(4, lapsOf(["o", null]), soft, [], 0)).toBeNull()
        expect(bestLap(4, [], [], [], 0)).toBeNull()
    })

    test("the set's age: laps since the stint started, on its age then (unknown: 0)", () => {
        const stints: PaceStint[] = [
            { lapStart: 1, compound: "SOFT", ageAtStart: 0 },
            { lapStart: 5, compound: "MEDIUM", ageAtStart: null }
        ]
        expect(tyreOf(stints, 3)).toEqual({ compound: "SOFT", age: 2 })
        expect(tyreOf(stints, 7)).toEqual({ compound: "MEDIUM", age: 2 })
        expect(tyreOf([], 1)).toBeNull()
    })
})

const best = (driver: number, time: number, end = 0): Best => ({
    driver,
    lap: 5,
    time,
    start: end - time * 1000,
    end,
    compound: "SOFT",
    age: 1,
    ideal: null
})

describe("pace rows", () => {
    test("quickest first, with the gap to it; equal times: the one set first", () => {
        const rows = paceRows([
            best(16, 91.2, 10),
            best(1, 90.5, 30),
            best(4, 90.5, 20)
        ])
        expect(
            rows.map((r) => [r.best.driver, r.rank, Math.round(r.gap * 1000)])
        ).toEqual([
            [4, 1, 0],
            [1, 2, 0],
            [16, 3, 700]
        ])
    })

    test("by team: each team's quicker driver", () => {
        const team = (n: number) =>
            n === 1 || n === 81 ? "McLaren" : "Ferrari"
        const rows = paceRows(
            [best(1, 90.5), best(81, 90.4), best(16, 90.9), best(44, 90.6)],
            team
        )
        expect(
            rows.map((r) => [r.best.driver, r.rank, Math.round(r.gap * 1000)])
        ).toEqual([
            [81, 1, 0],
            [44, 2, 200]
        ])
    })
})

describe("race pace", () => {
    test("the gap ahead: since another car last crossed the line, lapped or not", () => {
        const crossings = [
            { t: 1000, driver: 1 },
            { t: 1500, driver: 16 },
            { t: 2000, driver: 4 },
            { t: 2000, driver: 1 }
        ]
        expect(gapAhead(crossings, 4, 2000)).toBeCloseTo(0, 6)
        expect(gapAhead(crossings, 16, 1500)).toBeCloseTo(0.5, 6)
        expect(gapAhead(crossings, 1, 1000)).toBe(Infinity)
        // A car's own crossings don't count.
        expect(gapAhead(crossings, 1, 2000)).toBeCloseTo(0, 6)
        expect(gapAhead([{ t: 0, driver: 1 }], 1, 5000)).toBe(Infinity)
    })

    test("the laps that count: valid, not lap 1, not slow, in clear air", () => {
        // Lap 1 (98), laps 2-6, the in-lap (7), the out-lap (8), laps 9-10 and a slow lap (11: 99).
        const times = [98, 92, 91.5, 91.8, 92.2, 92, 110, 115, 91, 90.8, 99]
        const laps = lapsOf(times.map((t) => [30, 40, t - 70] as Spec))
        const stints: PaceStint[] = [
            { lapStart: 1, compound: "MEDIUM", ageAtStart: 0 },
            { lapStart: 8, compound: "HARD", ageAtStart: 0 }
        ]
        // Another car 0.5 s ahead at the end of lap 4 (so at the start of lap 5 too).
        const end4 = laps[3].end ?? 0
        const crossings = [
            ...crossingsOf([[4, laps]]),
            { t: end4 - 500, driver: 1 }
        ].sort((a, b) => a.t - b.t)
        const kept = fitLaps(4, laps, stints, [], 0, crossings)
        expect(kept.map((l) => l.lap)).toEqual([2, 3, 6, 9, 10])
        expect(kept.map((l) => [l.compound, l.age])).toEqual([
            ["MEDIUM", 1],
            ["MEDIUM", 2],
            ["MEDIUM", 5],
            ["HARD", 1],
            ["HARD", 2]
        ])
    })

    /** Laps from a known race: pace + fuel per lap + wear per lap on the set + the compound's offset. */
    const FUEL = -0.06
    const WEAR: Record<string, number> = { MEDIUM: 0.08, HARD: 0.05 }
    const OFFSET: Record<string, number> = { MEDIUM: 0, HARD: 0.3 }
    const driven = (
        driver: number,
        pace: number,
        stints: [string, number, number][]
    ): FitLap[] =>
        stints.flatMap(([compound, from, to]) =>
            Array.from({ length: to - from + 1 }, (_, k) => {
                const lap = from + k
                return {
                    driver,
                    lap,
                    time:
                        pace +
                        FUEL * lap +
                        WEAR[compound] * (lap - from) +
                        OFFSET[compound],
                    compound,
                    age: lap - from,
                    end: lap * 100_000
                }
            })
        )

    /** Six cars driving each plan (numbered n, n + 100...): a field's worth of laps, as a race has. */
    const field = (laps: FitLap[]) =>
        [0, 1, 2, 3, 4, 5].flatMap((k) =>
            laps.map((l) => ({ ...l, driver: l.driver + 100 * k }))
        )

    /** Within 0.01 s: what the prior's pull leaves on a field of laps. */
    const near = (x: number, y: number) =>
        expect(Math.abs(x - y)).toBeLessThan(0.01)

    test("the fit takes fuel, wear and compound out", () => {
        const laps = [
            ...driven(16, 100, [
                ["MEDIUM", 2, 15],
                ["HARD", 17, 50]
            ]),
            ...driven(12, 100.1, [
                ["MEDIUM", 2, 25],
                ["HARD", 27, 50]
            ]),
            ...driven(1, 100.3, [
                ["HARD", 2, 30],
                ["MEDIUM", 32, 50]
            ])
        ]
        const fit = must(fitPace(field(laps)))
        expect(fit.base).toBe("HARD")
        near(fit.fuel, FUEL)
        near(fit.wear.MEDIUM, 0.08)
        near(fit.wear.HARD, 0.05)
        // The offset takes up what the prior holds back of the wear (a stint's average age times it): looser.
        expect(Math.abs(fit.offset.MEDIUM + 0.3)).toBeLessThan(0.15)
        const gap = (n: number) =>
            (fit.pace.get(n) ?? 0) - (fit.pace.get(16) ?? 0)
        near(gap(12), 0.1)
        near(gap(1), 0.3)
    })

    test("fresher tyres from an extra stop don't make a car quicker", () => {
        // 16 is quicker and stops once; 1 stops twice, so it's on fresher tyres: by median lap, 1 looks quicker.
        const laps = [
            ...driven(16, 100, [
                ["MEDIUM", 2, 25],
                ["MEDIUM", 27, 50]
            ]),
            ...driven(1, 100.2, [
                ["MEDIUM", 2, 16],
                ["MEDIUM", 18, 33],
                ["MEDIUM", 35, 50]
            ])
        ]
        const median = (n: number) => {
            const t = laps
                .filter((l) => l.driver === n)
                .map((l) => l.time)
                .sort((a, b) => a - b)
            return t[t.length >> 1]
        }
        expect(median(1)).toBeLessThan(median(16))
        const fit = must(fitPace(field(laps)))
        near((fit.pace.get(1) ?? 0) - (fit.pace.get(16) ?? 0), 0.2)
    })

    test("before the stops, fuel and wear lean on the prior and the order still holds", () => {
        const laps = [
            ...driven(16, 100, [["MEDIUM", 2, 8]]),
            ...driven(1, 100.2, [["MEDIUM", 2, 8]])
        ]
        const fit = must(fitPace(laps))
        expect(Number.isFinite(fit.fuel)).toBe(true)
        expect((fit.pace.get(1) ?? 0) - (fit.pace.get(16) ?? 0)).toBeCloseTo(
            0.2,
            3
        )
        expect(fitPace([])).toBeNull()
    })

    test("every driver's race pace from their laps, the median as driven", () => {
        // Two cars far apart on the road: 16 a second a lap quicker.
        const at = (offset: number, times: number[]) =>
            lapsOf(times.map((t) => [30, 40, t - 70] as Spec)).map((l) => ({
                ...l,
                start: l.start + offset,
                end: (l.end ?? 0) + offset
            }))
        const laps = new Map([
            [16, at(0, [98, 92, 92.1, 92.2, 92.3])],
            [1, at(30_000, [99, 93, 93.1, 93.2, 93.3])]
        ])
        const stints = new Map<number, PaceStint[]>([
            [16, [{ lapStart: 1, compound: "MEDIUM", ageAtStart: 0 }]],
            [1, [{ lapStart: 1, compound: "MEDIUM", ageAtStart: 0 }]]
        ])
        const { paces } = racePaces(laps, stints, [], 0)
        const rows = raceRows(paces)
        expect(rows.map((r) => [r.pace.driver, r.pace.laps])).toEqual([
            [16, 4],
            [1, 4]
        ])
        expect(rows[1].gap).toBeCloseTo(1, 3)
        expect(rows[0].pace.median).toBeCloseTo(92.15, 6)
    })

    test("ranked by it, by team too", () => {
        const pace = (driver: number, time: number) => ({
            driver,
            time,
            laps: 20,
            median: time + 1,
            end: 0
        })
        const team = (n: number) =>
            n === 1 || n === 81 ? "McLaren" : "Ferrari"
        const paces = [pace(16, 92.3), pace(1, 92.1), pace(81, 91.9)]
        expect(
            raceRows(paces).map((r) => [
                r.pace.driver,
                r.rank,
                Math.round(r.gap * 1000)
            ])
        ).toEqual([
            [81, 1, 0],
            [1, 2, 200],
            [16, 3, 400]
        ])
        expect(raceRows(paces, team).map((r) => r.pace.driver)).toEqual([
            81, 16
        ])
    })
})

describe("the lap being watched", () => {
    const pinned = best(1, 90.5, 500_000)
    const pin = { best: pinned, sessionKey: 9 }

    test("is watched from a little before its start until it ends, in its session", () => {
        expect(watching(pin, pinned.start, 9)).toBe(true)
        expect(watching(pin, pinned.start - 30_000, 9)).toBe(true)
        expect(watching(pin, pinned.start - 30_001, 9)).toBe(false)
        expect(watching(pin, pinned.end, 9)).toBe(false)
        expect(watching(pin, pinned.start, 10)).toBe(false)
    })

    test("stands in for its driver's best so far", () => {
        const older = best(1, 91.0, 200_000)
        const rows = paceRows(withPin([older, best(16, 90.8)], pin))
        expect(rows.map((r) => [r.best.driver, r.best.time])).toEqual([
            [1, 90.5],
            [16, 90.8]
        ])
        expect(withPin([older], null)).toEqual([older])
    })
})
