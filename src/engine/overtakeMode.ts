// Overtake Mode (2026 on, in DRS's place): a car within a second of the car ahead at the detection point gets 0.5 MJ
// more to deploy on the next lap. OpenF1 has no channel for it (car_data's drs is null), so it's worked out here:
//
//   1. The detection point: the FIA's detection line for the circuit (data/overtakeDetection.ts), scaled onto the
//      session's lap length. A circuit not in there: the entry of its last corner, where it mostly is; without
//      corner marks, the line.
//   2. When each car got there: the lap's chained start (lapTrace.ts: OpenF1's date_start jitters by up to ~1 s, a
//      lap's official duration doesn't) plus the time its distance-aligned trace reached the point. Without a trace,
//      the point's share of the lap time.
//   3. The gap is to the car that got there just before (any car, a lapped one too; not one on its way into the pits),
//      while race control has it enabled ("OVERTAKE ENABLED" / "DISABLED").
//
// Cached on the session, by car and lap: a widget asks for every lap it lists, ten times a second.

import { OVERTAKE_DETECTION } from "../data/overtakeDetection"
import type { Session } from "../data/session"
import { timeAtDistance } from "./compare"
import { lapGeometryOf, lapTraceOf, lapWindowOf } from "./lapTrace"

/** Within this many seconds of the car ahead. */
export const OVERTAKE_GAP = 1
/** A circuit without the FIA's point: metres before its last corner's mark (near the apex) that count as its entry. */
const ENTRY_M = 50
/** Cars that reached the point this long before the car (ms) are looked at closely. */
const LOOK_BACK_MS = 3_000

export interface OvertakeMode {
    /** The car ahead at the detection point on the lap before. */
    ahead: number
    /** Seconds behind it there. */
    gap: number
}

/** "OVERTAKE ENABLED" is true, "OVERTAKE DISABLED" false, anything else null. */
export function overtakeSwitch(text: string): boolean | null {
    if (text === "OVERTAKE ENABLED") return true
    if (text === "OVERTAKE DISABLED") return false
    return null
}

/** Metres from the line to the detection point, along the session's measured lap. */
export function detectionDistance(session: Session): number {
    const { lapLength, corners } = lapGeometryOf(session)
    const fia = OVERTAKE_DETECTION[session.meta.circuit]
    if (fia) return (fia.at / fia.centreline) * lapLength
    const last = corners.at(-1)
    return last ? Math.max(0, last.d - ENTRY_M) : lapLength
}

interface Cache {
    d: number
    switches: { t: number; on: boolean }[]
    /** Car -> lap -> when it reached the detection point on that lap (ms), or null. */
    at: Map<number, Map<number, number | null>>
    modes: Map<string, OvertakeMode | null>
}

const caches = new WeakMap<Session, Cache>()

function cacheOf(session: Session): Cache {
    let c = caches.get(session)
    if (!c) {
        c = {
            d: detectionDistance(session),
            switches: session.meta.raceControl.flatMap((m) => {
                const on = overtakeSwitch(m.message)
                return on == null ? [] : [{ t: m.t, on }]
            }),
            at: new Map(),
            modes: new Map()
        }
        caches.set(session, c)
    }
    return c
}

/** When car n reached the detection point on lap `lapNo` (ms), or null without a lap time or a known lap length. */
function reached(session: Session, c: Cache, n: number, lapNo: number) {
    const byLap = c.at.get(n) ?? new Map<number, number | null>()
    c.at.set(n, byLap)
    const hit = byLap.get(lapNo)
    if (hit !== undefined) return hit
    let t: number | null = null
    const w = lapWindowOf(session, n, lapNo)
    const { lapLength } = lapGeometryOf(session)
    if (w && Number.isFinite(c.d) && lapLength > 0) {
        const trace = lapTraceOf(session, n, lapNo)
        t = trace
            ? w.start + timeAtDistance(trace, c.d)
            : w.start + (w.end - w.start) * Math.min(1, c.d / lapLength)
    }
    byLap.set(lapNo, t)
    return t
}

/**
 * Whether car n had Overtake Mode on lap `lapNo` (set at the detection point on the lap before): the car ahead
 * there and the gap, or null. The caller decides whether the lap may be shown (it's spoiler-free once it's over).
 */
export function overtakeModeOf(
    session: Session,
    n: number,
    lapNo: number
): OvertakeMode | null {
    const c = cacheOf(session)
    const key = `${n}:${lapNo}`
    const hit = c.modes.get(key)
    if (hit !== undefined) return hit
    const mode = work(session, c, n, lapNo)
    c.modes.set(key, mode)
    return mode
}

function work(
    session: Session,
    c: Cache,
    n: number,
    lapNo: number
): OvertakeMode | null {
    if (!c.switches.length || lapNo < 2) return null
    const laps = session.drivers.get(n)?.laps
    const lap = laps?.find((l) => l.lap === lapNo)
    // A pit-out lap: the car came through the pit lane, not the detection point.
    if (!lap || lap.pitOut) return null
    const t = reached(session, c, n, lapNo - 1)
    if (t == null) return null
    let on = false
    for (const s of c.switches) {
        if (s.t > t) break
        on = s.on
    }
    if (!on) return null
    let best: OvertakeMode | null = null
    for (const [other, d] of session.drivers) {
        if (other === n) continue
        // The lap the other car was on when this one got to the point, and the one before (it may have just
        // crossed the line).
        let i = -1
        while (i + 1 < d.laps.length && d.laps[i + 1].start <= t) i++
        for (const l of [d.laps[i], d.laps[i - 1]]) {
            if (!l || l.end == null || l.end < t - LOOK_BACK_MS) continue
            // On its way into the pits: it left the track before the line.
            if (d.laps.find((x) => x.lap === l.lap + 1)?.pitOut) continue
            const at = reached(session, c, other, l.lap)
            if (at == null || at >= t) continue
            const gap = (t - at) / 1000
            if (gap < (best?.gap ?? OVERTAKE_GAP)) best = { ahead: other, gap }
        }
    }
    return best
}
