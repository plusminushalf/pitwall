// The qualifying order as a starting grid: who's where, and the time that put them there. Pure.

import { inSegment, type Lap, type LiveQualiSegment } from "widget-kit"

export interface Slot {
    driver: number
    /** 1 = pole. */
    position: number
    /** The lap time that counts for the place (seconds): the best in the segment the car was classified in. */
    time: number | null
    /** The segment that time is from (Q1..Q3); null outside qualifying's segments. */
    segment: string | null
}

/** The latest deletion by t: validity only changes then, so the order isn't worked out 10 times a second. */
export function lastDeletion(
    all: ReadonlyMap<number, readonly Lap[]>,
    t: number
) {
    let last = -Infinity
    for (const laps of all.values())
        for (const l of laps)
            if (l.deleted && l.deleted.t <= t && l.deleted.t > last)
                last = l.deleted.t
    return last
}

/**
 * A driver's best lap time (seconds): timed, not an out-lap, not deleted by `deletedBy`. In Q2 and Q3 only the
 * segment's laps count; in Q1 every lap does (as the timing screen, live-timing).
 */
export function bestOf(
    laps: readonly Lap[],
    segment: LiveQualiSegment | null,
    deletedBy: number
): number | null {
    let best: number | null = null
    for (const l of laps) {
        if (l.duration == null || l.pitOut) continue
        if (l.deleted && l.deleted.t <= deletedBy) continue
        if (segment && segment.number > 1 && !inSegment(segment, l)) continue
        if (best == null || l.duration < best) best = l.duration
    }
    return best
}

/**
 * The grid as qualifying has it at the moment: the cars still in the segment running fastest first (those without a
 * time after them, in running order), then the cars knocked out in earlier segments as the running order has them.
 * `order` is the timing screen's; `out` the positions knocked out in each earlier segment.
 */
export function gridOf(
    order: readonly number[],
    laps: ReadonlyMap<number, readonly Lap[]>,
    segment: LiveQualiSegment | null,
    out: readonly { segment: LiveQualiSegment; from: number; to: number }[],
    deletedBy: number
): Slot[] {
    const entries = order.map((driver, i) => {
        const was =
            out.find((o) => i + 1 >= o.from && i + 1 <= o.to)?.segment ?? null
        const seg = was ?? segment
        return {
            driver,
            i,
            out: was != null,
            segment: seg?.name ?? null,
            time: bestOf(laps.get(driver) ?? [], seg, deletedBy)
        }
    })
    const racing = entries
        .filter((e) => !e.out)
        .sort((a, b) =>
            a.time != null && b.time != null
                ? a.time - b.time || a.i - b.i
                : a.time != null
                  ? -1
                  : b.time != null
                    ? 1
                    : a.i - b.i
        )
    return [...racing, ...entries.filter((e) => e.out)].map((e, k) => ({
        driver: e.driver,
        position: k + 1,
        time: e.time,
        segment: e.segment
    }))
}

/** "Lewis HAMILTON" -> first name "Lewis", surname "HAMILTON" (the words in capitals); the acronym if there are none. */
export function nameParts(
    fullName: string,
    acronym: string
): { first: string; last: string } {
    const words = fullName.trim().split(/\s+/)
    const k = words.findIndex((w) => /\p{Lu}/u.test(w) && w === w.toUpperCase())
    if (k <= 0) return { first: "", last: k === 0 ? fullName : acronym }
    return {
        first: words.slice(0, k).join(" "),
        last: words.slice(k).join(" ")
    }
}
