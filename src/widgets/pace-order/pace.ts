// Pace order: every driver's best valid lap so far, ranked, with the tyre it was set on and the ideal lap (the
// driver's best valid sectors added up). In a race it also ranks by race pace: the median of each driver's clean
// laps, so one quick lap on new softs at the end doesn't put a car up the order. Pure: the widget feeds it the laps,
// stints and safety car, VSC and red flag periods it has so far (nothing past t).
//
// A lap is valid when it's timed, isn't an out-lap or an in-lap, isn't touched by a neutral period and hasn't been
// deleted by race control by then (a deleted lap counts until it's deleted, as on the timing screens).

import { median, type NeutralPeriod } from "widget-kit"

/** The part of a completed lap this needs. */
export interface PaceLap {
    lap: number
    start: number
    end: number | null
    duration: number | null
    sectors: readonly [number | null, number | null, number | null]
    pitOut: boolean
    deleted?: { t: number }
}

/** The part of a stint this needs. */
export interface PaceStint {
    lapStart: number
    compound: string
    ageAtStart: number | null
}

/** A driver's best valid lap so far. */
export interface Best {
    driver: number
    lap: number
    /** Seconds. */
    time: number
    /** When the lap started (ms), to seek to, and ended. */
    start: number
    end: number
    compound: string
    /** Laps on the set when the lap started (a new set's first lap is 0). */
    age: number
    /** Seconds: the driver's best valid sectors added up; null until each sector has a valid time. */
    ideal: number | null
}

/** A lap's set: the stint that holds it, its compound and the set's age on that lap. */
export function tyreOf(
    stints: readonly PaceStint[],
    lap: number
): { compound: string; age: number } | null {
    const s = stints.filter((x) => x.lapStart <= lap).at(-1)
    if (!s) return null
    return { compound: s.compound, age: (s.ageAtStart ?? 0) + lap - s.lapStart }
}

/**
 * A driver's valid laps (in order): timed, not an out-lap or in-lap, not touched by a neutral period, not deleted
 * by `deletedBy` (the replay time, or the last deletion up to it: the same thing here).
 */
export function validLaps(
    laps: readonly PaceLap[],
    stints: readonly PaceStint[],
    neutral: readonly NeutralPeriod[],
    deletedBy: number
): PaceLap[] {
    const sorted = [...laps].sort((a, b) => a.lap - b.lap)
    const starts = new Set(stints.slice(1).map((s) => s.lapStart))
    return sorted.filter((l, k) => {
        if (l.duration == null || !(l.duration > 0)) return false
        // Out-lap: flagged, or the first lap of a later stint. In-lap: the next lap is an out-lap, or a stint starts after it.
        if (l.pitOut || starts.has(l.lap)) return false
        if (sorted[k + 1]?.pitOut === true || starts.has(l.lap + 1))
            return false
        if (l.deleted && deletedBy >= l.deleted.t) return false
        const end = l.end ?? l.start + l.duration * 1000
        return !neutral.some(
            (p) => p.start < end && l.start < (p.end ?? Infinity)
        )
    })
}

/** A driver's best valid lap so far, with its tyre and the ideal lap; null without one. */
export function bestLap(
    driver: number,
    laps: readonly PaceLap[],
    stints: readonly PaceStint[],
    neutral: readonly NeutralPeriod[],
    deletedBy: number
): Best | null {
    const valid = validLaps(laps, stints, neutral, deletedBy)
    // The first of equal times: it was set first.
    let best: PaceLap | null = null
    let time = Infinity
    for (const l of valid) {
        if (l.duration != null && l.duration < time) {
            best = l
            time = l.duration
        }
    }
    if (!best) return null
    const sectors = [0, 1, 2].map((i) =>
        Math.min(
            ...valid.map((l) => {
                const s = l.sectors[i] ?? 0
                return s > 0 ? s : Infinity
            })
        )
    )
    const ideal = sectors.every(Number.isFinite)
        ? sectors.reduce((a, b) => a + b, 0)
        : null
    const tyre = tyreOf(stints, best.lap)
    return {
        driver,
        lap: best.lap,
        time,
        start: best.start,
        end: best.end ?? best.start + time * 1000,
        compound: tyre?.compound ?? "UNKNOWN",
        age: tyre?.age ?? 0,
        ideal
    }
}

/** Time left on the table: best minus ideal (never below 0: sector times are rounded). Null without an ideal lap. */
export const leftOf = (b: Best) =>
    b.ideal == null ? null : Math.max(0, b.time - b.ideal)

/** Something to rank: a time (s), and when it was set for equal times (ms). */
interface Timed {
    driver: number
    time: number
    end: number
}

/** Ranked quickest first (equal times: the one set first). With `teamOf`, one per team: its quicker driver's. */
function ranked<T extends Timed>(
    items: readonly T[],
    teamOf?: (driver: number) => string
): { item: T; rank: number; gap: number }[] {
    let list = [...items].sort((a, b) => a.time - b.time || a.end - b.end)
    if (teamOf) {
        const seen = new Set<string>()
        list = list.filter((b) => {
            const team = teamOf(b.driver)
            if (seen.has(team)) return false
            seen.add(team)
            return true
        })
    }
    return list.map((item, i) => ({
        item,
        rank: i + 1,
        gap: item.time - list[0].time
    }))
}

export interface PaceRow {
    best: Best
    rank: number
    /** Seconds behind the first row (0: the first). */
    gap: number
}

/**
 * The bests ranked, quickest first (equal times: the one set first). With `teamOf`, one row per team: its quicker
 * driver's.
 */
export const paceRows = (
    bests: readonly Best[],
    teamOf?: (driver: number) => string
): PaceRow[] =>
    ranked(bests, teamOf).map(({ item, rank, gap }) => ({
        best: item,
        rank,
        gap
    }))

// ---------------------------------------------------------------- race pace

/** Slower than this share of the driver's median valid lap isn't pace: traffic, a mistake, a car being lapped. */
export const SLOW = 1.07

/** A driver's race pace so far: the median of their clean laps. */
export interface RacePace {
    driver: number
    /** Seconds: the median clean lap. */
    time: number
    /** Clean laps in it. */
    laps: number
    /** Seconds: the quickest of them. */
    best: number
    /** When the last of them ended (ms): equal times rank by it. */
    end: number
}

/**
 * A driver's race pace: the median of their clean laps, the valid laps (as the best lap's: no out-, in- or deleted
 * laps, none touched by a neutral period) but lap 1, and none slower than SLOW of the median of the rest (as the
 * stint pace and the circuit history count them). Null without one.
 */
export function racePace(
    driver: number,
    laps: readonly PaceLap[],
    stints: readonly PaceStint[],
    neutral: readonly NeutralPeriod[],
    deletedBy: number
): RacePace | null {
    const valid = validLaps(laps, stints, neutral, deletedBy).filter(
        (l) => l.lap > 1
    )
    const limit = median(valid.map((l) => l.duration ?? 0)) * SLOW
    const clean = valid.filter((l) => (l.duration ?? 0) <= limit)
    if (!clean.length) return null
    const times = clean.map((l) => l.duration ?? 0)
    const last = clean[clean.length - 1]
    return {
        driver,
        time: median(times),
        laps: clean.length,
        best: Math.min(...times),
        end: last.end ?? last.start + (last.duration ?? 0) * 1000
    }
}

export interface RaceRow {
    pace: RacePace
    rank: number
    /** Seconds behind the first row (0: the first). */
    gap: number
}

/** The race paces ranked, quickest first. With `teamOf`, one row per team: its quicker driver's. */
export const raceRows = (
    paces: readonly RacePace[],
    teamOf?: (driver: number) => string
): RaceRow[] =>
    ranked(paces, teamOf).map(({ item, rank, gap }) => ({
        pace: item,
        rank,
        gap
    }))

// ---------------------------------------------------------------- the lap being watched
//
// Clicking a row seeks to the start of that lap, and the lap isn't done by then: the driver's row would drop back to
// an older best. So the clicked best is pinned: it stays the driver's best (it was on screen: no spoiler) until the
// lap ends, when the list has it again.

export interface PinnedBest {
    best: Best
    sessionKey: number
}

/** Seeking up to this far before a pinned lap still watches it (its out-lap, a few seconds back). */
export const PIN_LEAD_MS = 30_000

/** Whether a pinned lap is still being watched at t: same session, from a little before its start until it ends. */
export const watching = (pin: PinnedBest, t: number, sessionKey: number) =>
    sessionKey === pin.sessionKey &&
    t >= pin.best.start - PIN_LEAD_MS &&
    t < pin.best.end

/** The bests at t with the pinned one in place of its driver's (while it's watched). */
export const withPin = (
    bests: readonly Best[],
    pin: PinnedBest | null
): Best[] =>
    pin
        ? [...bests.filter((b) => b.driver !== pin.best.driver), pin.best]
        : [...bests]
