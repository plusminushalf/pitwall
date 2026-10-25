// Pace order: every driver's best valid lap so far, ranked, with the tyre it was set on and the ideal lap (the
// driver's best valid sectors added up). In a race it also ranks by race pace: each driver's clean laps in clear air
// with fuel, tyre age and compound taken out (below), so one quick lap on new softs at the end doesn't put a car up
// the order, nor a late stop's fresh tyres. Pure: the widget feeds it the laps,
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
//
// A median lap mixes laps on new and old tyres, full and light: whoever stopped later had fresher tyres at the end and
// looks quicker. So race pace is fitted across the field: each lap time is the driver's pace, plus how much quicker
// the cars get each lap (fuel burning off, the track rubbering in), plus wear for each lap on the set and an offset for
// its compound. Only clean laps in clear air count. Before the stops, the laps and the sets' ages go up together and
// the data can't tell fuel from wear: both lean on a typical value (PRIOR) until it can.

/** Slower than this share of the driver's median valid lap isn't pace: traffic, a mistake, a car being lapped. */
export const SLOW = 1.07
/** Closer than this (s) behind another car at either end of a lap: its dirty air, a DRS train. Not clear air. */
export const CLEAR_AIR = 1

/** What a fit leans on (s per lap) until the laps can say: quicker each lap with fuel burning off, slower with wear. */
export const PRIOR = { fuel: -0.05, wear: 0.05 }
/** How hard (in squared s per lap, like a lap's): enough to hold before the stops, not against a race's worth. */
const WEIGHT = { fuel: 1000, wear: 1000, offset: 20 }

/** A line crossing: when (ms) and who. */
export interface Crossing {
    t: number
    driver: number
}

/** Every car's line crossings (the start and end of each lap but the first's start, the start), in time order. */
export function crossingsOf(
    all: Iterable<readonly [number, readonly PaceLap[]]>
): Crossing[] {
    const out: Crossing[] = []
    for (const [driver, laps] of all)
        for (const l of laps) {
            if (l.lap > 1) out.push({ t: l.start, driver })
            const end =
                l.end ??
                (l.duration != null ? l.start + l.duration * 1000 : null)
            if (end != null) out.push({ t: end, driver })
        }
    return out.sort((a, b) => a.t - b.t)
}

/** Seconds since another car crossed the line when `driver` did at t: the car ahead on the road, lapped or not. */
export function gapAhead(
    crossings: readonly Crossing[],
    driver: number,
    t: number
): number {
    let lo = 0
    let hi = crossings.length
    while (lo < hi) {
        const m = (lo + hi) >> 1
        if (crossings[m].t <= t) lo = m + 1
        else hi = m
    }
    for (let i = lo - 1; i >= 0; i--)
        if (crossings[i].driver !== driver) return (t - crossings[i].t) / 1000
    return Infinity
}

/** A lap that shows pace, for the fit. */
export interface FitLap {
    driver: number
    lap: number
    /** Seconds. */
    time: number
    compound: string
    /** Laps on the set before this one. */
    age: number
    /** When it ended (ms). */
    end: number
}

/**
 * A driver's laps that show pace: valid (as the best lap's), not lap 1, not slower than SLOW of the median valid lap,
 * and in clear air at both ends.
 */
export function fitLaps(
    driver: number,
    laps: readonly PaceLap[],
    stints: readonly PaceStint[],
    neutral: readonly NeutralPeriod[],
    deletedBy: number,
    crossings: readonly Crossing[]
): FitLap[] {
    const valid = validLaps(laps, stints, neutral, deletedBy).filter(
        (l) => l.lap > 1
    )
    const limit = median(valid.map((l) => l.duration ?? 0)) * SLOW
    return valid.flatMap((l) => {
        const time = l.duration ?? 0
        if (time > limit) return []
        const end = l.end ?? l.start + time * 1000
        const gap = Math.min(
            gapAhead(crossings, driver, l.start),
            gapAhead(crossings, driver, end)
        )
        if (gap < CLEAR_AIR) return []
        const tyre = tyreOf(stints, l.lap)
        return [
            {
                driver,
                lap: l.lap,
                time,
                compound: tyre?.compound ?? "UNKNOWN",
                age: tyre?.age ?? 0,
                end
            }
        ]
    })
}

/** The field's fit. */
export interface PaceFit {
    /** Seconds per lap of the race: fuel burning off and the track rubbering in (negative: quicker). */
    fuel: number
    /** Seconds per lap on the set, by compound. */
    wear: Record<string, number>
    /** Seconds on each compound against `base`'s (the one most laps are on: 0). */
    offset: Record<string, number>
    base: string
    /** Each driver's pace with those taken out (s): a model lap, to compare drivers by. */
    pace: Map<number, number>
}

/** Least squares with the priors: solves (A + W) x = b + W prior by elimination. Null when it can't. */
function solve(a: number[][], b: number[]): number[] | null {
    const n = b.length
    const m = a.map((row, i) => [...row, b[i]])
    for (let i = 0; i < n; i++) {
        let p = i
        for (let r = i + 1; r < n; r++)
            if (Math.abs(m[r][i]) > Math.abs(m[p][i])) p = r
        if (!(Math.abs(m[p][i]) > 1e-9)) return null
        ;[m[i], m[p]] = [m[p], m[i]]
        for (let r = 0; r < n; r++) {
            if (r === i || m[r][i] === 0) continue
            const f = m[r][i] / m[i][i]
            for (let c = i; c <= n; c++) m[r][c] -= f * m[i][c]
        }
    }
    return m.map((row, i) => row[n] / row[i])
}

/** The fit through every driver's laps; null without any. */
export function fitPace(laps: readonly FitLap[]): PaceFit | null {
    if (!laps.length) return null
    const drivers = [...new Set(laps.map((l) => l.driver))].sort(
        (a, b) => a - b
    )
    const count = new Map<string, number>()
    for (const l of laps)
        count.set(l.compound, (count.get(l.compound) ?? 0) + 1)
    const compounds = [...count.keys()].sort()
    const base = compounds.reduce((a, c) =>
        (count.get(c) ?? 0) > (count.get(a) ?? 0) ? c : a
    )
    const others = compounds.filter((c) => c !== base)
    // Columns: each driver's pace, each other compound's offset, each compound's wear, fuel.
    const di = new Map(drivers.map((d, i) => [d, i]))
    const oi = new Map(others.map((c, i) => [c, drivers.length + i]))
    const wi = new Map(
        compounds.map((c, i) => [c, drivers.length + others.length + i])
    )
    const fi = drivers.length + others.length + compounds.length
    const n = fi + 1
    const a = Array.from({ length: n }, () => new Array<number>(n).fill(0))
    const b = new Array<number>(n).fill(0)
    for (const l of laps) {
        const row: [number, number][] = [
            [di.get(l.driver) ?? 0, 1],
            [wi.get(l.compound) ?? 0, l.age],
            [fi, l.lap]
        ]
        const o = oi.get(l.compound)
        if (o != null) row.push([o, 1])
        for (const [i, x] of row) {
            b[i] += x * l.time
            for (const [j, y] of row) a[i][j] += x * y
        }
    }
    for (const i of oi.values()) a[i][i] += WEIGHT.offset
    for (const i of wi.values()) {
        a[i][i] += WEIGHT.wear
        b[i] += WEIGHT.wear * PRIOR.wear
    }
    a[fi][fi] += WEIGHT.fuel
    b[fi] += WEIGHT.fuel * PRIOR.fuel
    const x = solve(a, b)
    if (!x) return null
    return {
        fuel: x[fi],
        wear: Object.fromEntries(compounds.map((c) => [c, x[wi.get(c) ?? 0]])),
        offset: Object.fromEntries(
            compounds.map((c) => [c, c === base ? 0 : x[oi.get(c) ?? 0]])
        ),
        base,
        pace: new Map(drivers.map((d) => [d, x[di.get(d) ?? 0]]))
    }
}

/** A driver's race pace so far. */
export interface RacePace {
    driver: number
    /** Seconds: the fitted pace (only to compare: the gap between two drivers is what it says). */
    time: number
    /** Laps in the fit. */
    laps: number
    /** Seconds: the median of them, as they were. */
    median: number
    /** When the last of them ended (ms): equal times rank by it. */
    end: number
}

/** Every driver's race pace from their laps so far, and the fit (null without a lap to fit). */
export function racePaces(
    laps: ReadonlyMap<number, readonly PaceLap[]>,
    stints: ReadonlyMap<number, readonly PaceStint[]>,
    neutral: readonly NeutralPeriod[],
    deletedBy: number
): { paces: RacePace[]; fit: PaceFit | null } {
    const crossings = crossingsOf(laps)
    const own = [...laps].map(([n, l]) =>
        fitLaps(n, l, stints.get(n) ?? [], neutral, deletedBy, crossings)
    )
    const fit = fitPace(own.flat())
    if (!fit) return { paces: [], fit }
    const paces = own.flatMap((ls) => {
        const time = ls.length ? fit.pace.get(ls[0].driver) : undefined
        if (time == null) return []
        return [
            {
                driver: ls[0].driver,
                time,
                laps: ls.length,
                median: median(ls.map((l) => l.time)),
                end: Math.max(...ls.map((l) => l.end))
            }
        ]
    })
    return { paces, fit }
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
