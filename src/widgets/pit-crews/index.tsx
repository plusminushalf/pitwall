import { useMemo } from "react"
import {
    type DriverInfo,
    DriverTag,
    defineWidget,
    LABEL_CLASS,
    Label,
    type PitStop,
    shortTeam,
    TAP_CLASS,
    teamColor,
    useAllPitStops,
    useDrivers,
    useNeutralPeriods,
    useSelection,
    useSettings
} from "widget-kit"
import {
    axisStart,
    type Crew,
    type CrewStop,
    crews,
    type Measure,
    measuresIn,
    type RedFlag,
    redCount
} from "./crews"

type Settings = { measure: Measure }

const ROW_H = 24
const HEADER_H = 30
/** Room after a bar for its value. */
const VALUE_W = 34

/** Team, its quickest stop as a bar, who made it, the median and how many. */
const COLS =
    "grid grid-cols-[88px_minmax(0,1fr)_64px_40px_40px] items-center gap-x-2"

const MEASURES: Record<
    Measure,
    { label: string; subtitle: string; title: string }
> = {
    stop: {
        label: "Stationary",
        subtitle: "Stationary time, each team's quickest",
        title: "Time stopped in the box, as the teams' pit stop times are"
    },
    lane: {
        label: "Pit lane",
        subtitle: "Pit lane time, entry to exit",
        title: "Pit entry to pit exit: the stop and the drive through the lane"
    }
}

/** What the table reads of each stop: it re-renders when a stop is added, not at 10 Hz. */
const toStops = (all: ReadonlyMap<number, readonly PitStop[]>) =>
    new Map(
        [...all].map(([n, pits]) => [
            n,
            pits.map(
                ({
                    lap,
                    entry,
                    exit,
                    laneDuration,
                    stopDuration
                }): CrewStop => ({
                    lap,
                    entry,
                    exit,
                    laneDuration,
                    stopDuration
                })
            )
        ])
    )

const seconds = (v: number) => `${v.toFixed(1)} s`

function CrewRow({
    crew,
    info,
    colour,
    fastest,
    from,
    to,
    onPick
}: {
    crew: Crew
    info: DriverInfo | undefined
    colour: string | undefined
    fastest: boolean
    from: number
    to: number
    onPick: (n: number) => void
}) {
    const { best } = crew
    const share = Math.max(
        0.02,
        Math.min(1, (best.value - from) / Math.max(0.1, to - from))
    )
    const who = info?.acronym ?? `#${best.driver}`
    const title = `${shortTeam(crew.team)}: quickest ${seconds(best.value)} (${who}, lap ${best.lap})${fastest ? ", the quickest of all" : ""}. Median ${seconds(crew.median)} over ${crew.count} stop${crew.count === 1 ? "" : "s"}. Click to focus ${who}.`
    return (
        <li>
            <button
                type="button"
                onClick={() => onPick(best.driver)}
                title={title}
                className={`${COLS} w-full border-b border-zinc-800/70 px-3 text-left hover:bg-zinc-900`}
                style={{ height: ROW_H }}
            >
                <span className="flex min-w-0 items-center gap-1.5">
                    <span
                        aria-hidden
                        className="h-3.5 w-1 shrink-0 rounded-sm"
                        style={{
                            background: colour ? teamColor(colour) : "#52525c"
                        }}
                    />
                    <span className="truncate text-xs font-semibold text-zinc-100">
                        {shortTeam(crew.team)}
                    </span>
                </span>
                <span className="flex min-w-0 items-center gap-1.5">
                    <span
                        aria-hidden
                        className="h-3.5 shrink-0 rounded-r-sm"
                        style={{
                            width: `calc((100% - ${VALUE_W}px) * ${share.toFixed(4)})`,
                            background: colour ? teamColor(colour) : "#52525c"
                        }}
                    />
                    <span
                        className={`text-xs font-semibold tabular-nums ${fastest ? "text-fuchsia-400" : "text-zinc-50"}`}
                    >
                        {best.value.toFixed(1)}
                    </span>
                </span>
                <span className="flex min-w-0 items-center gap-1">
                    <DriverTag driver={info} number={best.driver} />
                    <span className="text-[11px] tabular-nums text-zinc-400">
                        L{best.lap}
                    </span>
                </span>
                <span className="text-right text-xs tabular-nums text-zinc-300">
                    {crew.median.toFixed(1)}
                </span>
                <span className="text-right text-xs tabular-nums text-zinc-400">
                    {crew.count}
                </span>
            </button>
        </li>
    )
}

/** Each team's pit stops so far, ranked by its quickest: the stop, who made it, the median and how many. */
function PitCrews() {
    const drivers = useDrivers()
    const pits = useAllPitStops(toStops)
    const reds = useNeutralPeriods((ps) =>
        ps.flatMap((p): RedFlag[] =>
            p.status === "RED" ? [{ start: p.start, end: p.end }] : []
        )
    )
    const selected = useSelection((s) => s.selected)
    const focus = useSelection((s) => s.focus)
    const toggle = useSelection((s) => s.toggle)
    const [{ measure: picked }, update] = useSettings<Settings>()
    const info = useMemo(
        () => new Map<number, DriverInfo>(drivers.map((d) => [d.number, d])),
        [drivers]
    )

    const cars = useMemo(
        () =>
            [...pits].map(([driver, p]) => ({
                driver,
                team: info.get(driver)?.team ?? `#${driver}`,
                pits: p
            })),
        [pits, info]
    )
    const has = useMemo(() => measuresIn(cars), [cars])
    // The one picked if the stops have it, else the other: OpenF1 often has no stationary times.
    const measure: Measure = has[picked]
        ? picked
        : has.stop
          ? "stop"
          : has.lane
            ? "lane"
            : picked
    const table = useMemo(
        () => crews(cars, measure, reds),
        [cars, measure, reds]
    )
    const left = useMemo(() => redCount(cars, reds), [cars, reds])
    const values = table.map((c) => c.best.value)
    const from = axisStart(values)
    const to = Math.max(...values, from + 0.1)
    const colourOf = (team: string) =>
        drivers.find((d) => d.team === team)?.teamColour

    const onPick = (n: number) => {
        if (selected.length > 0 && !selected.includes(n)) toggle(n)
        focus(n)
    }

    return (
        <section className="flex h-full flex-col text-sm">
            <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-1.5">
                <Label as="h2" className="shrink-0 whitespace-nowrap">
                    Pit crews
                </Label>
                <span
                    className="truncate text-[11px] text-zinc-400"
                    title={MEASURES[measure].title}
                >
                    {MEASURES[measure].subtitle}
                </span>
                {has.stop && has.lane && (
                    <div
                        data-shot-control=""
                        className="ml-auto flex shrink-0 rounded-md bg-zinc-900 p-0.5"
                    >
                        {(["stop", "lane"] as const).map((m) => (
                            <button
                                type="button"
                                key={m}
                                onClick={() => update({ measure: m })}
                                aria-pressed={measure === m}
                                className={`${TAP_CLASS} rounded px-2 text-[11px] leading-5 ${measure === m ? "bg-zinc-700 text-zinc-50" : "text-zinc-300 hover:text-white"}`}
                                title={MEASURES[m].title}
                            >
                                {MEASURES[m].label}
                            </button>
                        ))}
                    </div>
                )}
            </div>
            <div
                className={`${COLS} border-b border-zinc-800 px-3 py-1 ${LABEL_CLASS}`}
            >
                <span>Team</span>
                <span
                    className="truncate"
                    title="The team's quickest stop, in seconds"
                >
                    Quickest
                </span>
                <span>By</span>
                <span
                    className="text-right"
                    title="The median of the team's stops, in seconds"
                >
                    Med
                </span>
                <span className="text-right" title="Stops timed">
                    Stops
                </span>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
                {table.length === 0 ? (
                    <p className="px-3 py-6 text-center text-xs text-zinc-400">
                        No pit stops yet
                    </p>
                ) : (
                    <ol>
                        {table.map((c, k) => (
                            <CrewRow
                                key={c.team}
                                crew={c}
                                info={info.get(c.best.driver)}
                                colour={colourOf(c.team)}
                                fastest={k === 0}
                                from={from}
                                to={to}
                                onPick={onPick}
                            />
                        ))}
                    </ol>
                )}
            </div>
            {left > 0 && (
                <p className="border-t border-zinc-800 px-3 py-1 text-[11px] leading-4 text-zinc-400">
                    {left} stop{left === 1 ? "" : "s"} under the red flag left
                    out: the cars wait in the lane.
                </p>
            )}
        </section>
    )
}

export default defineWidget({
    id: "pit-crews",
    name: "Pit crews",
    group: "session",
    description:
        "Each team's pit stops ranked by its quickest: the stop, who made it, the median and how many. Stationary time when OpenF1 has it, else pit lane time.",
    version: "1.0.0",
    // The header, column labels and a few teams; fills its column and scrolls inside.
    height: { min: HEADER_H + 22 + 4 * ROW_H },
    width: { min: 20, default: 30, max: 50 },
    sessions: ["race"],
    settings: { measure: "stop" as Measure },
    fields: {
        measure: {
            kind: "choice",
            label: "Time",
            options: [
                { value: "stop", label: "Stationary" },
                { value: "lane", label: "Pit lane" }
            ]
        }
    },
    Component: PitCrews
})
