// The race's strategies so far: each car's stints as bars along the laps, and the runs of laps behind a safety car, a
// VSC or a red flag to shade behind them. Pure, and only ever fed what the hooks give at t.

/** The part of a stint this needs (useAllStints' StintView). */
export interface StintIn {
    stint: number
    lapStart: number
    lapEnd: number
    compound: string
    ageAtStart: number | null
    open: boolean
}

/** A stint as drawn: from the end of lap `from` to the end of lap `to`. */
export interface Bar {
    stint: number
    compound: string
    /** The lap before its first (0: from the start). */
    from: number
    /** Its last lap; the one in progress, the car's last completed lap. */
    to: number
    /** Laps on the set before this stint (null: not known); a used set when above 0. */
    age: number | null
    /** Still on it: no stop after it yet. */
    open: boolean
}

/**
 * A car's stints as bars, `done` its laps completed. A closed stint runs to the lap before the next one starts; the
 * open one to the last lap completed (nothing past now), at least to its own start.
 */
export function stintBars(stints: readonly StintIn[], done: number): Bar[] {
    return stints.map((s, i) => {
        const next = stints[i + 1]
        const from = s.lapStart - 1
        const to = next
            ? Math.max(Math.min(s.lapEnd, next.lapStart - 1), from)
            : Math.max(s.open ? done : Math.min(s.lapEnd, done), from)
        return {
            stint: s.stint,
            compound: s.compound,
            from,
            to,
            age: s.ageAtStart,
            open: next == null && s.open
        }
    })
}

/** leader[n]: the first crossing of the line at the end of lap n by anyone (ms), from every car's completed laps. */
export function leaderEnds(
    all: Iterable<readonly { lap: number; end: number | null }[]>
): (number | null)[] {
    const out: (number | null)[] = [null]
    for (const laps of all)
        for (const l of laps) {
            if (l.end == null) continue
            while (out.length <= l.lap) out.push(null)
            const f = out[l.lap]
            if (f == null || l.end < f) out[l.lap] = l.end
        }
    return out
}

export type Neutral = "SC" | "VSC" | "RED"

/** A safety car, VSC or red flag period, as useNeutralPeriods gives it: `end` is null while it's still out. */
export interface NeutralPeriod {
    status: Neutral
    start: number
    end: number | null
}

/** A run of laps (from `from` to `to`, inclusive) that ran partly under one kind of neutralisation. */
export interface NeutralRun {
    kind: Neutral
    from: number
    to: number
}

/**
 * The runs of the leader's laps that ran partly under a red flag, a safety car or a VSC (in that order, when a lap saw
 * more than one). Lap n runs from the leader's crossing at lap n - 1 (lights out for lap 1) to their crossing at lap
 * n; the lap in progress counts as running until now.
 */
export function neutralRuns(
    periods: readonly NeutralPeriod[],
    leader: readonly (number | null)[],
    lightsOut: number
): NeutralRun[] {
    const runs: NeutralRun[] = []
    for (let n = 1; n <= leader.length; n++) {
        const from = n === 1 ? lightsOut : leader[n - 1]
        if (from == null) continue
        const to = leader[n] ?? Infinity
        const kinds = periods
            .filter((p) => p.start < to && (p.end ?? Infinity) > from)
            .map((p) => p.status)
        const kind = (["RED", "SC", "VSC"] as const).find((k) =>
            kinds.includes(k)
        )
        if (!kind) continue
        const last = runs.at(-1)
        if (last && last.kind === kind && last.to === n - 1) last.to = n
        else runs.push({ kind, from: n, to: n })
    }
    return runs
}
