// Track limits per driver, from race control's messages: the lap times it deleted for them (and any it gave back), the
// black and white flag, and what the stewards made of it. Every session kind, live and replay. Pure.

import type { Ms } from "../types"

/** A race control message as the feed has it. */
export interface ControlMessage {
    t: Ms
    driver: number | null
    flag?: string | null
    text: string
}

export interface LimitStrike {
    /** When race control deleted the lap time. */
    t: Ms
    /** When the car ran wide: the message's local time of day at the track; `t` when it has none. */
    at: Ms
    lap: number | null
    turn: number | null
    /** The lap time deleted, as race control wrote it ("1:48.323"); null for "LAP DELETED". */
    time: string | null
    /** Race control gave the time back. */
    reinstated: boolean
}

export interface StewardsNote {
    t: Ms
    /** A short label: "5 s penalty", "Investigating", "No action"... */
    label: string
    text: string
}

export interface DriverLimits {
    driver: number
    /** Oldest first. */
    strikes: LimitStrike[]
    /** Strikes that stand (not reinstated). */
    count: number
    /** When race control showed the black and white flag for track limits; null if it hasn't. */
    blackWhite: Ms | null
    /** The stewards' messages about the driver's track limits, oldest first. */
    stewards: StewardsNote[]
}

// "CAR 30 (LAW) TIME 2:00.207 DELETED - TRACK LIMITS AT TURN 7 LAP 3 16:07:45"
// "CAR 18 (STR) LAP DELETED - TRACK LIMITS AT TURN 7 LAP 3 16:07:34 (PIT)"
const DELETED =
    /^CAR (\d+)\b.*?\b(?:TIME (\d+:\d{2}\.\d{3}) DELETED|LAP DELETED) - (.+?)(?: LAP (\d+))?(?: (\d{1,2}):(\d{2}):(\d{2}))?(?: \(PIT\))?$/
const REINSTATED = /^CAR (\d+)\b.*?\bREINSTATED/
const TIME = /\b(\d+:\d{2}\.\d{3})\b/
const TURN = /\bTURN (\d+)\b/
const CAR = /\bCARS? (\d+)\b/

/**
 * A local time of day at the track (h:m:s, at UTC offset `gmtOffset` like "04:00:00" or "-05:00:00") as ms since t0
 * (absolute ms `t0`), on the day that puts it just before `issued` (ms since t0): race control writes an incident's
 * time after it.
 */
export function localClockToT(
    issued: Ms,
    h: number,
    m: number,
    s: number,
    gmtOffset: string,
    t0: number
): Ms {
    const [oh, om] = gmtOffset.replace("-", "").split(":").map(Number)
    const offsetMs =
        (gmtOffset.startsWith("-") ? -1 : 1) *
        ((oh || 0) * 60 + (om || 0)) *
        60_000
    const local = new Date(t0 + issued + offsetMs)
    const day = Date.UTC(
        local.getUTCFullYear(),
        local.getUTCMonth(),
        local.getUTCDate()
    )
    let t = day + ((h * 60 + m) * 60 + s) * 1000 - offsetMs - t0
    if (t > issued + 60_000) t -= 86_400_000
    return t
}

/** What the stewards decided or did, in a word or two. */
export function stewardsLabel(text: string): string {
    const msg = text.toUpperCase()
    const seconds = msg.match(/(\d+) SECOND TIME PENALTY/)
    if (seconds) return `${seconds[1]} s penalty`
    if (/DRIVE[ -]THROUGH/.test(msg)) return "Drive-through"
    if (/STOP[ /-]?(AND[ -])?GO/.test(msg)) return "Stop and go"
    if (/PENALTY SERVED/.test(msg)) return "Served"
    if (/REPRIMAND/.test(msg)) return "Reprimand"
    if (/NO FURTHER (ACTION|INVESTIGATION)/.test(msg)) return "No action"
    if (/AFTER THE (RACE|SESSION)/.test(msg)) return "Investigated later"
    if (/UNDER INVESTIGATION/.test(msg)) return "Investigating"
    if (/NOTED/.test(msg)) return "Noted"
    if (/WARNING/.test(msg)) return "Warning"
    return "Stewards"
}

/**
 * Each driver's track limits in the messages given (oldest first), by driver in the order they first had one. Lap
 * times deleted for another reason (a yellow flag) don't count.
 */
export function trackLimits(
    messages: readonly ControlMessage[],
    t0: number,
    gmtOffset: string
): Map<number, DriverLimits> {
    const out = new Map<number, DriverLimits>()
    const of = (n: number): DriverLimits => {
        let d = out.get(n)
        if (!d) {
            d = {
                driver: n,
                strikes: [],
                count: 0,
                blackWhite: null,
                stewards: []
            }
            out.set(n, d)
        }
        return d
    }
    for (const m of messages) {
        const msg = m.text.toUpperCase().trim()
        const limits = msg.includes("TRACK LIMIT")
        if (msg.startsWith("FIA STEWARDS")) {
            if (!limits) continue
            const n = m.driver ?? Number(msg.match(CAR)?.[1] ?? Number.NaN)
            if (Number.isFinite(n))
                of(n).stewards.push({
                    t: m.t,
                    label: stewardsLabel(msg),
                    text: m.text
                })
            continue
        }
        if (m.flag === "BLACK AND WHITE") {
            if (!limits) continue
            const n = m.driver ?? Number(msg.match(CAR)?.[1] ?? Number.NaN)
            if (Number.isFinite(n)) {
                const d = of(n)
                d.blackWhite ??= m.t
            }
            continue
        }
        const del = msg.match(DELETED)
        if (del) {
            if (!del[3].includes("TRACK LIMIT")) continue
            const turn = del[3].match(TURN)
            of(Number(del[1])).strikes.push({
                t: m.t,
                at:
                    del[5] != null
                        ? localClockToT(
                              m.t,
                              Number(del[5]),
                              Number(del[6]),
                              Number(del[7]),
                              gmtOffset,
                              t0
                          )
                        : m.t,
                lap: del[4] != null ? Number(del[4]) : null,
                turn: turn ? Number(turn[1]) : null,
                time: del[2] ?? null,
                reinstated: false
            })
            continue
        }
        const back = msg.match(REINSTATED)
        if (back) {
            const d = out.get(Number(back[1]))
            if (!d) continue
            const time = msg.match(TIME)?.[1] ?? null
            // A time names the lap; without one, the latest still standing.
            const strike = d.strikes
                .filter(
                    (s) => !s.reinstated && (time == null || s.time === time)
                )
                .at(-1)
            if (strike) strike.reinstated = true
        }
    }
    for (const d of out.values())
        d.count = d.strikes.filter((s) => !s.reinstated).length
    return out
}
