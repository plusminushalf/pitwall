import { useMemo } from "react"
import {
    type DriverInfo,
    defineWidget,
    Label,
    type Lap,
    type StintView,
    shortTeam,
    TAP_CLASS,
    teamColor,
    useAllLaps,
    useAllStints,
    useDrivers,
    useSelection,
    useSettings
} from "widget-kit"
import {
    axisStart,
    gapText,
    POINT_NAMES,
    type SpeedLap,
    type SpeedStint,
    type TopSpeed,
    type Trap,
    teamSpeeds,
    topSpeeds
} from "./speeds"

type By = "drivers" | "teams"
type Settings = { trap: Trap; by: By }

const ROW_H = 22
const HEADER_H = 30
/** Room after a bar for its value. */
const VALUE_W = 34

const TRAPS: readonly { value: Trap; label: string; title: string }[] = [
    {
        value: "st",
        label: "Trap",
        title: "The speed trap on the straight, as F1's top speeds are"
    },
    {
        value: "any",
        label: "Any",
        title: "The highest of the speed trap and the two intermediates"
    }
]

// What the chart reads of each hook: it re-renders when a lap or stint is added, not at 10 Hz.
const each =
    <T, R>(pick: (v: readonly T[]) => R[]) =>
    (all: ReadonlyMap<number, readonly T[]>) =>
        new Map([...all].map(([n, v]) => [n, pick(v)]))
const toLaps = each((laps: readonly Lap[]): SpeedLap[] =>
    laps.map(({ lap, start, end, speedTrap }) => ({
        lap,
        start,
        end,
        speedTrap
    }))
)
const toStints = each((stints: readonly StintView[]): SpeedStint[] =>
    stints.map(({ lapStart, compound, ageAtStart }) => ({
        lapStart,
        compound,
        ageAtStart
    }))
)

const tyreText = (s: TopSpeed) => {
    if (!s.compound) return ""
    const tyre = `${s.compound.toLowerCase()}s`
    if (s.age == null) return `, on ${tyre}`
    return `, on ${tyre} ${s.age === 0 ? "from new" : `${s.age} lap${s.age === 1 ? "" : "s"} old`}`
}

/** One bar: the row's name, a bar in team colour from the axis start with its value at the end, the gap to the fastest. */
function SpeedRow({
    label,
    speed,
    info,
    best,
    from,
    wide,
    onPick
}: {
    label: string
    speed: TopSpeed
    info: DriverInfo | undefined
    best: number
    from: number
    wide: boolean
    onPick: (n: number) => void
}) {
    const share = Math.max(
        0.02,
        Math.min(1, (speed.value - from) / Math.max(1, best - from))
    )
    const gap = gapText(best, speed.value)
    const fastest = gap === "Fastest"
    const who = info?.acronym ?? `#${speed.driver}`
    const title = `${wide ? `${label} (${who})` : who}: ${Math.round(speed.value)} km/h at ${POINT_NAMES[speed.point]} on lap ${speed.lap}${tyreText(speed)}. ${fastest ? "The fastest." : `${gap} off the fastest.`} Click to focus ${who}.`
    return (
        <li>
            <button
                type="button"
                onClick={() => onPick(speed.driver)}
                title={title}
                className={`grid w-full items-center gap-x-2 border-b border-zinc-800/70 px-3 text-left hover:bg-zinc-900 ${wide ? "grid-cols-[84px_minmax(0,1fr)_60px]" : "grid-cols-[36px_minmax(0,1fr)_60px]"}`}
                style={{ height: ROW_H }}
            >
                <span className="truncate text-xs font-bold tracking-wide text-zinc-100">
                    {label}
                </span>
                <span className="flex min-w-0 items-center gap-1.5">
                    <span
                        aria-hidden
                        className="h-3.5 shrink-0 rounded-r-sm"
                        style={{
                            width: `calc((100% - ${VALUE_W}px) * ${share.toFixed(4)})`,
                            background: info
                                ? teamColor(info.teamColour)
                                : "#52525c"
                        }}
                    />
                    <span className="text-xs font-semibold tabular-nums text-zinc-50">
                        {Math.round(speed.value)}
                    </span>
                </span>
                <span
                    className={`text-right text-[11px] tabular-nums ${fastest ? "font-semibold text-fuchsia-400" : "text-zinc-400"}`}
                >
                    {gap}
                </span>
            </button>
        </li>
    )
}

/** Every driver's (or team's) highest speed so far, fastest first, as bars from a little under the slowest. */
function TopSpeeds() {
    const drivers = useDrivers()
    const laps = useAllLaps(toLaps)
    const stints = useAllStints(toStints)
    const selected = useSelection((s) => s.selected)
    const focus = useSelection((s) => s.focus)
    const toggle = useSelection((s) => s.toggle)
    const [{ trap, by }, update] = useSettings<Settings>()
    const info = useMemo(
        () => new Map<number, DriverInfo>(drivers.map((d) => [d.number, d])),
        [drivers]
    )

    const speeds = useMemo(
        () =>
            topSpeeds(
                [...laps].map(([driver, l]) => ({
                    driver,
                    laps: l,
                    stints: stints.get(driver) ?? []
                })),
                trap
            ),
        [laps, stints, trap]
    )
    const rows = useMemo(
        () =>
            by === "teams"
                ? teamSpeeds(speeds, (n) => info.get(n)?.team).map((r) => ({
                      label: shortTeam(r.team),
                      speed: r.speed
                  }))
                : speeds.map((s) => ({
                      label: info.get(s.driver)?.acronym ?? `#${s.driver}`,
                      speed: s
                  })),
        [speeds, by, info]
    )
    const best = rows[0]?.speed.value ?? 0
    const from = axisStart(rows.map((r) => r.speed.value))

    // Focus the driver; with drivers selected, they join them. It doesn't seek to the lap: the chart would go back
    // with it and lose the readings set since.
    const onPick = (n: number) => {
        if (selected.length > 0 && !selected.includes(n)) toggle(n)
        focus(n)
    }

    return (
        <section className="flex h-full flex-col text-sm">
            <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-1.5">
                <Label as="h2" className="shrink-0 whitespace-nowrap">
                    Top speeds
                </Label>
                <span className="truncate text-[11px] text-zinc-400">
                    {trap === "st"
                        ? "Highest at the speed trap, km/h"
                        : "Highest at any speed point, km/h"}
                </span>
                <div
                    data-shot-control=""
                    className="ml-auto flex shrink-0 gap-1"
                >
                    <div className="flex rounded-md bg-zinc-900 p-0.5">
                        {TRAPS.map((o) => (
                            <button
                                type="button"
                                key={o.value}
                                onClick={() => update({ trap: o.value })}
                                aria-pressed={trap === o.value}
                                className={`${TAP_CLASS} rounded px-2 text-[11px] leading-5 ${trap === o.value ? "bg-zinc-700 text-zinc-50" : "text-zinc-300 hover:text-white"}`}
                                title={o.title}
                            >
                                {o.label}
                            </button>
                        ))}
                    </div>
                    <div className="flex rounded-md bg-zinc-900 p-0.5">
                        {(["drivers", "teams"] as const).map((v) => (
                            <button
                                type="button"
                                key={v}
                                onClick={() => update({ by: v })}
                                aria-pressed={by === v}
                                className={`${TAP_CLASS} rounded px-2 text-[11px] leading-5 ${by === v ? "bg-zinc-700 text-zinc-50" : "text-zinc-300 hover:text-white"}`}
                                title={
                                    v === "teams"
                                        ? "A row per team, its quicker car"
                                        : "A row per driver"
                                }
                            >
                                {v === "teams" ? "Teams" : "Drivers"}
                            </button>
                        ))}
                    </div>
                </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
                {rows.length === 0 ? (
                    <p className="px-3 py-6 text-center text-xs text-zinc-400">
                        No speeds recorded yet
                    </p>
                ) : (
                    <ol>
                        {rows.map((r) => (
                            <SpeedRow
                                key={r.label}
                                label={r.label}
                                speed={r.speed}
                                info={info.get(r.speed.driver)}
                                best={best}
                                from={from}
                                wide={by === "teams"}
                                onPick={onPick}
                            />
                        ))}
                    </ol>
                )}
            </div>
            {rows.length > 0 && (
                <p className="border-t border-zinc-800 px-3 py-1 text-[11px] leading-4 text-zinc-400">
                    Bars start at {from} km/h. From completed laps.
                </p>
            )}
        </section>
    )
}

export default defineWidget({
    id: "top-speeds",
    name: "Top speeds",
    group: "session",
    description:
        "Every driver's highest speed so far, at the speed trap or any speed point, as bars with the gap to the fastest. By driver or team.",
    version: "1.0.0",
    // The header and a few rows; fills its column and scrolls inside.
    height: { min: HEADER_H + 6 * ROW_H },
    width: { min: 20, default: 32, max: 60 },
    sessions: ["race", "practice", "qualifying"],
    settings: { trap: "st" as Trap, by: "drivers" as By },
    fields: {
        trap: {
            kind: "choice",
            label: "Speed point",
            options: [
                { value: "st", label: "Speed trap" },
                { value: "any", label: "Any" }
            ]
        },
        by: {
            kind: "choice",
            label: "Rows",
            options: [
                { value: "drivers", label: "Drivers" },
                { value: "teams", label: "Teams" }
            ]
        }
    },
    Component: TopSpeeds
})
