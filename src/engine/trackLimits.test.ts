// Track limits per driver from race control's messages: synthetic messages for each rule, then the real 2026 Azerbaijan GP.

import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import type { SessionMeta } from "../types"
import {
    type ControlMessage,
    type DriverLimits,
    localClockToT,
    stewardsLabel,
    trackLimits
} from "./trackLimits"

// t = 0 is 15:00:00 local time at a track 4 h ahead of UTC.
const T0 = Date.parse("2026-09-26T11:00:00Z")
const OFFSET = "04:00:00"
const msg = (
    t: number,
    text: string,
    extra: Partial<ControlMessage> = {}
): ControlMessage => ({ t, driver: null, flag: null, text, ...extra })

describe("trackLimits", () => {
    test("counts deleted lap times for track limits, with the lap, turn and when it happened", () => {
        const limits = trackLimits(
            [
                msg(
                    120_000,
                    "CAR 81 (PIA) TIME 1:58.595 DELETED - TRACK LIMITS AT TURN 1 LAP 40 15:01:30"
                ),
                msg(
                    300_000,
                    "CAR 81 (PIA) LAP DELETED - TRACK LIMITS AT TURN 15 LAP 42 15:04:10 (PIT)"
                )
            ],
            T0,
            OFFSET
        )
        const pia = limits.get(81)
        expect(pia?.count).toBe(2)
        expect(pia?.strikes).toEqual([
            {
                t: 120_000,
                at: 90_000,
                lap: 40,
                turn: 1,
                time: "1:58.595",
                reinstated: false
            },
            {
                t: 300_000,
                at: 250_000,
                lap: 42,
                turn: 15,
                time: null,
                reinstated: false
            }
        ])
    })

    test("leaves out lap times deleted for anything else", () => {
        const limits = trackLimits(
            [
                msg(
                    60_000,
                    "CAR 30 (LAW) TIME 2:00.207 DELETED - DOUBLE YELLOW AT TURN 7 LAP 3 15:00:45"
                )
            ],
            T0,
            OFFSET
        )
        expect(limits.size).toBe(0)
    })

    test("a reinstated time no longer counts: the one it names, else the latest", () => {
        const limits = trackLimits(
            [
                msg(
                    10_000,
                    "CAR 4 (NOR) TIME 1:30.100 DELETED - TRACK LIMITS AT TURN 4 LAP 2 15:00:05"
                ),
                msg(
                    20_000,
                    "CAR 4 (NOR) TIME 1:30.200 DELETED - TRACK LIMITS AT TURN 9 LAP 3 15:00:15"
                ),
                msg(30_000, "CAR 4 (NOR) TIME 1:30.100 REINSTATED"),
                msg(
                    40_000,
                    "CAR 16 (LEC) TIME 1:31.000 DELETED - TRACK LIMITS AT TURN 4 LAP 3 15:00:35"
                ),
                msg(50_000, "CAR 16 (LEC) LAP 3 REINSTATED")
            ],
            T0,
            OFFSET
        )
        expect(limits.get(4)?.count).toBe(1)
        expect(limits.get(4)?.strikes.map((s) => s.reinstated)).toEqual([
            true,
            false
        ])
        expect(limits.get(16)?.count).toBe(0)
    })

    test("the black and white flag and the stewards, for track limits only", () => {
        const limits = trackLimits(
            [
                msg(
                    10_000,
                    "BLACK AND WHITE FLAG FOR CAR 44 (HAM) - TRACK LIMITS",
                    {
                        driver: 44,
                        flag: "BLACK AND WHITE"
                    }
                ),
                msg(
                    20_000,
                    "BLACK AND WHITE FLAG FOR CAR 1 (VER) - UNSPORTING BEHAVIOUR",
                    { driver: 1, flag: "BLACK AND WHITE" }
                ),
                msg(
                    30_000,
                    "FIA STEWARDS: 5 SECOND TIME PENALTY FOR CAR 44 (HAM) - TRACK LIMITS",
                    { driver: 44 }
                ),
                msg(
                    40_000,
                    "FIA STEWARDS: TURN 1 INCIDENT INVOLVING CAR 1 (VER) NOTED - LEAVING THE TRACK"
                )
            ],
            T0,
            OFFSET
        )
        expect([...limits.keys()]).toEqual([44])
        expect(limits.get(44)?.blackWhite).toBe(10_000)
        expect(limits.get(44)?.stewards).toEqual([
            {
                t: 30_000,
                label: "5 s penalty",
                text: "FIA STEWARDS: 5 SECOND TIME PENALTY FOR CAR 44 (HAM) - TRACK LIMITS"
            }
        ])
    })
})

describe("stewardsLabel", () => {
    test.each([
        [
            "FIA STEWARDS: 10 SECOND TIME PENALTY FOR CAR 1 (VER) - TRACK LIMITS",
            "10 s penalty"
        ],
        [
            "FIA STEWARDS: DRIVE THROUGH PENALTY FOR CAR 1 (VER) - TRACK LIMITS",
            "Drive-through"
        ],
        [
            "FIA STEWARDS: TRACK LIMITS CAR 1 (VER) UNDER INVESTIGATION",
            "Investigating"
        ],
        [
            "FIA STEWARDS: TRACK LIMITS CAR 1 (VER) WILL BE INVESTIGATED AFTER THE RACE",
            "Investigated later"
        ],
        [
            "FIA STEWARDS: TRACK LIMITS CAR 1 (VER) REVIEWED NO FURTHER INVESTIGATION",
            "No action"
        ],
        [
            "FIA STEWARDS: 5 SECOND TIME PENALTY FOR CAR 1 (VER) SERVED",
            "5 s penalty"
        ]
    ])("%s", (text, label) => {
        expect(stewardsLabel(text)).toBe(label)
    })
})

describe("localClockToT", () => {
    test("a time just before midnight, issued just after it, is the day before", () => {
        // t0 at 23:59:30 local; issued 60 s later (00:00:30), about 23:59:50.
        const t0 = Date.parse("2026-09-26T19:59:30Z")
        expect(localClockToT(60_000, 23, 59, 50, OFFSET, t0)).toBe(20_000)
    })
})

const dir = new URL("../../data/sessions/11377/", import.meta.url).pathname
const available = existsSync(`${dir}meta.json`)

describe.skipIf(!available)("Baku 2026", () => {
    const meta: SessionMeta = available
        ? JSON.parse(readFileSync(`${dir}meta.json`, "utf8"))
        : (null as unknown as SessionMeta)
    const limits = available
        ? trackLimits(
              meta.raceControl.map((m) => ({
                  t: m.t,
                  driver: m.driver,
                  flag: m.flag,
                  text: m.message
              })),
              Date.parse(meta.t0),
              meta.gmtOffset
          )
        : new Map<number, DriverLimits>()

    test("every lap time deleted for track limits, by driver", () => {
        const counts = Object.fromEntries(
            [...limits.values()].map((d) => [d.driver, d.count])
        )
        // BOR three (turns 1, 16, 15), PIA and LAW two, the rest one each.
        expect(counts).toEqual({
            1: 1,
            81: 2,
            30: 2,
            43: 1,
            5: 3,
            41: 1,
            27: 1,
            55: 1,
            11: 1,
            31: 1,
            87: 1,
            44: 1
        })
        expect(limits.get(5)?.strikes.map((s) => s.turn)).toEqual([1, 16, 15])
    })

    test("each happened before race control deleted it, within half an hour (some come laps later)", () => {
        for (const d of limits.values())
            for (const s of d.strikes) {
                expect(s.at).toBeLessThanOrEqual(s.t)
                expect(s.t - s.at).toBeLessThan(1_800_000)
            }
    })
})
