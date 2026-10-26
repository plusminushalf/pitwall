// Overtake Mode (2026 on, in DRS's place): a car within a second of the car ahead at the detection point gets 0.5 MJ
// more to deploy on the next lap. OpenF1 has no channel for it (car_data's drs is null), so it's worked out from
// timing: each lap's start is a line crossing, and the gap at the line before a lap is to the car that crossed just
// before (any car, a lapped one too), while race control has it enabled ("OVERTAKE ENABLED" / "DISABLED"). The
// detection point is near the line (usually the last corner), so a gap close to a second can come out either way.

/** Within this many seconds of the car ahead. */
export const OVERTAKE_GAP = 1

export interface OvertakeMode {
    /** The car ahead at the line before the lap. */
    ahead: number
    /** Seconds behind it there. */
    gap: number
}

export interface LapStart {
    driver: number
    lap: number
    start: number
    pitOut: boolean
}

/** Race control's switches, `on` for "OVERTAKE ENABLED", in time order. */
export interface Switch {
    t: number
    on: boolean
}

export function overtakeSwitch(text: string): boolean | null {
    if (text === "OVERTAKE ENABLED") return true
    if (text === "OVERTAKE DISABLED") return false
    return null
}

/** The laps of `drivers` with Overtake Mode, by driver and lap number; `laps` is every car's (the car ahead can be any). */
export function overtakeModeLaps(
    laps: Iterable<LapStart>,
    switches: readonly Switch[],
    drivers: readonly number[]
): Map<number, Map<number, OvertakeMode>> {
    const out = new Map<number, Map<number, OvertakeMode>>()
    if (!switches.length) return out
    // Lap 1 starts on the grid, and a pit-out lap starts in the pit lane: neither is a crossing on track.
    const crossings = [...laps]
        .filter((l) => l.lap > 1 && !l.pitOut)
        .sort((a, b) => a.start - b.start)
    let s = -1
    for (let i = 1; i < crossings.length; i++) {
        const c = crossings[i]
        while (s + 1 < switches.length && switches[s + 1].t <= c.start) s++
        if (s < 0 || !switches[s].on || !drivers.includes(c.driver)) continue
        const prev = crossings[i - 1]
        const gap = (c.start - prev.start) / 1000
        if (prev.driver === c.driver || gap >= OVERTAKE_GAP) continue
        const mine = out.get(c.driver) ?? new Map<number, OvertakeMode>()
        out.set(c.driver, mine)
        mine.set(c.lap, { ahead: prev.driver, gap })
    }
    return out
}
