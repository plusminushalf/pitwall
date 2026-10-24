import { useMemo } from "react"
import {
    type DriverInfo,
    type DriverLimits,
    DriverTag,
    defineWidget,
    Label,
    type LimitStrike,
    raceClock,
    TAP_CLASS,
    useDrivers,
    usePlayback,
    useSelection,
    useSessionInfo,
    useTrackLimits
} from "widget-kit"

/** Seek this long before a car ran wide, to watch it happen. */
const LEAD_MS = 3_000
const ROW_H = 28
const HEADER_H = 30
/** Races: the black and white flag comes after this many, the stewards after one more. */
const FLAG_AT = 3

/** Most strikes first; among equals, the latest. Drivers with every time given back go last. */
const order = (a: DriverLimits, b: DriverLimits) =>
    b.count - a.count || (b.strikes.at(-1)?.t ?? 0) - (a.strikes.at(-1)?.t ?? 0)

/** "Lewis HAMILTON" -> "Hamilton", "Nyck DE VRIES" -> "De Vries": the words in capitals, else the last. */
function surname(fullName: string): string {
    const words = fullName.split(" ")
    const caps = words.filter((w) => w.length > 1 && w === w.toUpperCase())
    return (caps.length ? caps : words.slice(-1))
        .map((w) => w.charAt(0) + w.slice(1).toLowerCase())
        .join(" ")
}

/** "L51 T15", or what of it race control gave. */
const strikeText = (s: LimitStrike) =>
    [s.lap != null && `L${s.lap}`, s.turn != null && `T${s.turn}`]
        .filter(Boolean)
        .join(" ") || "Lap"

function strikeTitle(s: LimitStrike, lightsOut: number): string {
    const where = [
        s.lap != null && `Lap ${s.lap}`,
        s.turn != null && `turn ${s.turn}`
    ]
        .filter(Boolean)
        .join(", ")
    const what = s.time ? `${s.time} deleted` : "lap deleted"
    return `${where || "Track limits"}: ${what} at ${raceClock(s.t - lightsOut)}${s.reinstated ? ", then reinstated" : ""}. Click to watch it.`
}

function DriverRow({
    d,
    info,
    race,
    lightsOut,
    onStrike
}: {
    d: DriverLimits
    info: DriverInfo | undefined
    race: boolean
    lightsOut: number
    onStrike: (n: number, s: LimitStrike) => void
}) {
    const focus = useSelection((s) => s.focus)
    const flagged = race && d.blackWhite == null && d.count >= FLAG_AT
    const latest = d.stewards.at(-1)
    return (
        <li className="grid grid-cols-[minmax(0,104px)_20px_minmax(0,1fr)] items-start gap-x-2 border-b border-zinc-800/70 px-3 py-1">
            <button
                type="button"
                onClick={() => focus(d.driver)}
                className="flex h-5 min-w-0 items-center gap-1.5 rounded-sm text-left"
                title={`Focus ${info?.acronym ?? `#${d.driver}`}`}
            >
                <DriverTag driver={info} number={d.driver} />
                <span className="truncate text-xs text-zinc-200">
                    {info ? surname(info.fullName) : ""}
                </span>
            </button>
            <span
                className={`text-right text-xs font-bold leading-5 tabular-nums ${flagged ? "text-amber-400" : d.count === 0 ? "text-zinc-400" : "text-zinc-50"}`}
                title={`${d.count} lap ${d.count === 1 ? "time" : "times"} deleted for track limits`}
            >
                {d.count}
            </span>
            <span className="flex min-w-0 flex-wrap items-center gap-1">
                {d.strikes.map((s) => (
                    <button
                        type="button"
                        key={s.t}
                        onClick={() => onStrike(d.driver, s)}
                        title={strikeTitle(s, lightsOut)}
                        className={`${TAP_CLASS} rounded bg-zinc-900 px-1 text-[11px] leading-5 tabular-nums hover:bg-zinc-800 hover:text-white ${s.reinstated ? "text-zinc-500 line-through" : "text-zinc-300"}`}
                    >
                        {strikeText(s)}
                    </button>
                ))}
                {d.blackWhite != null && (
                    <span
                        className="rounded bg-zinc-200 px-1 text-[11px] font-bold uppercase leading-4 text-black"
                        title={`Black and white flag for track limits at ${raceClock(d.blackWhite - lightsOut)}`}
                    >
                        Black/white
                    </span>
                )}
                {latest && (
                    <span
                        className="rounded bg-blue-600 px-1 text-[11px] font-bold uppercase leading-4 text-white"
                        title={d.stewards
                            .map(
                                (n) => `${raceClock(n.t - lightsOut)} ${n.text}`
                            )
                            .join("\n")}
                    >
                        {latest.label}
                    </span>
                )}
            </span>
        </li>
    )
}

/** Each driver's lap times deleted for track limits so far, where and when, with the black and white flag and the stewards. */
function TrackLimits() {
    const limits = useTrackLimits()
    const drivers = useDrivers()
    const race = useSessionInfo((i) => i.kind === "race")
    const lightsOut = useSessionInfo((i) => i.lightsOut)
    const seek = usePlayback((p) => p.seek)
    const selected = useSelection((s) => s.selected)
    const toggle = useSelection((s) => s.toggle)
    const focus = useSelection((s) => s.focus)
    const info = useMemo(
        () => new Map<number, DriverInfo>(drivers.map((d) => [d.number, d])),
        [drivers]
    )
    const rows = useMemo(() => [...limits.values()].sort(order), [limits])
    const total = rows.reduce((sum, d) => sum + d.count, 0)

    // Watch it happen, the driver focused; with drivers selected, it joins them.
    const onStrike = (n: number, s: LimitStrike) => {
        seek(s.at - LEAD_MS)
        if (selected.length > 0 && !selected.includes(n)) toggle(n)
        focus(n)
    }

    return (
        <section className="flex h-full flex-col text-sm">
            <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-1.5">
                <Label as="h2" className="shrink-0 whitespace-nowrap">
                    Track limits
                </Label>
                <span
                    className="truncate text-[11px] text-zinc-400"
                    title={
                        race
                            ? `A black and white flag after ${FLAG_AT} deleted lap times, the stewards after ${FLAG_AT + 1}`
                            : "Lap times deleted for track limits don't count"
                    }
                >
                    {race
                        ? `Black and white flag after ${FLAG_AT}`
                        : "Deleted lap times don't count"}
                </span>
                <span className="ml-auto shrink-0 text-[11px] tabular-nums text-zinc-300">
                    {total} deleted
                </span>
            </div>
            <ol className="min-h-0 flex-1 overflow-y-auto">
                {rows.length === 0 && (
                    <li className="px-3 py-6 text-center text-xs text-zinc-400">
                        No lap times deleted for track limits yet
                    </li>
                )}
                {rows.map((d) => (
                    <DriverRow
                        key={d.driver}
                        d={d}
                        info={info.get(d.driver)}
                        race={race}
                        lightsOut={lightsOut}
                        onStrike={onStrike}
                    />
                ))}
            </ol>
        </section>
    )
}

export default defineWidget({
    id: "track-limits",
    name: "Track limits",
    group: "session",
    description:
        "Each driver's lap times deleted for track limits so far, by lap and turn, with the black and white flag and the stewards' decisions. Click one to watch it.",
    version: "1.0.0",
    // The header and three drivers; more scroll.
    height: { min: HEADER_H + 3 * ROW_H },
    width: { min: 15, default: 21, max: 40 },
    sessions: ["race", "practice", "qualifying"],
    settings: {},
    Component: TrackLimits
})
