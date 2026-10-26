import { type CSSProperties, useMemo } from "react"
import {
    COMPOUND,
    type DriverInfo,
    DriverTag,
    defineWidget,
    Label,
    type Lap,
    TAP_CLASS,
    useAllDrivers,
    useAllLaps,
    useAllStints,
    useDrivers,
    useLapWindow,
    useNeutralPeriods,
    useRunningOrder,
    useSelection,
    useSessionInfo,
    useTotalLaps
} from "widget-kit"
import {
    type Bar,
    leaderEnds,
    type Neutral,
    type NeutralRun,
    neutralRuns,
    stintBars
} from "./strategy"

const ROW =
    "grid grid-cols-[1.75rem_2.75rem_minmax(0,1fr)_1.25rem] items-center gap-x-2"
/** A row's least height: under it the rows scroll. */
const ROW_MIN = 18
const HEADER_H = 30

/** Neutral laps behind the bars, in the circuit widgets' vocabulary: amber for a safety car, lighter hatched amber for a VSC, red for a red flag. */
const NEUTRAL: Record<Neutral, { style: CSSProperties; title: string }> = {
    SC: {
        style: { background: "rgba(252, 211, 77, 0.25)" },
        title: "Safety car"
    },
    VSC: {
        style: {
            background:
                "repeating-linear-gradient(135deg, rgba(252, 211, 77, 0.22) 0 2px, rgba(252, 211, 77, 0.08) 2px 5px)"
        },
        title: "Virtual safety car"
    },
    RED: {
        style: { background: "rgba(231, 0, 11, 0.3)" },
        title: "Red flag"
    }
}

/** Each car's last completed lap: changes only when someone completes a lap. */
const lastLaps = (
    all: ReadonlyMap<number, readonly Lap[]>
): ReadonlyMap<number, number> =>
    new Map([...all].map(([n, laps]) => [n, laps.at(-1)?.lap ?? 0]))

/** Every car's lap ends, for the leader's: the neutral laps are the leader's. */
const lapEnds = (all: ReadonlyMap<number, readonly Lap[]>) =>
    [...all.values()].map((laps) => laps.map(({ lap, end }) => ({ lap, end })))

const compoundName = (c: string) => c.charAt(0) + c.slice(1).toLowerCase()

/** "Medium, laps 1–20, new" / "Hard, laps 21–33 so far, used (3 laps old)". */
function barTitle(b: Bar): string {
    const laps =
        b.to > b.from
            ? `lap${b.to > b.from + 1 ? "s" : ""} ${b.from + 1}${b.to > b.from + 1 ? `–${b.to}` : ""}`
            : `from lap ${b.from + 1}`
    const set =
        b.age == null
            ? ""
            : b.age > 0
              ? `, used (${b.age} ${b.age === 1 ? "lap" : "laps"} old)`
              : ", new"
    return `${compoundName(b.compound)}, ${laps}${b.open && b.to > b.from ? " so far" : ""}${set}`
}

function Row({
    n,
    info,
    place,
    out,
    bars,
    runs,
    from,
    to
}: {
    n: number
    info: DriverInfo | undefined
    place: number | null
    out: boolean
    bars: Bar[]
    runs: readonly NeutralRun[]
    /** The window: the lap before its first, and its last. */
    from: number
    to: number
}) {
    const focus = useSelection((s) => s.focus)
    const span = Math.max(to - from, 1)
    const pct = (lap: number) => `${((lap - from) / span) * 100}%`
    const name = info?.acronym ?? `#${n}`
    return (
        <li
            className={`${ROW} flex-1 border-b border-zinc-800/70 px-3`}
            style={{ minHeight: ROW_MIN }}
        >
            <span
                className={`text-right tabular-nums ${out ? "text-[11px] text-zinc-400" : "text-zinc-300"}`}
            >
                {out ? "OUT" : (place ?? "–")}
            </span>
            <button
                type="button"
                onClick={() => focus(n)}
                className={`${TAP_CLASS} flex rounded-sm`}
                title={`Focus ${name}`}
            >
                <DriverTag
                    driver={info}
                    number={n}
                    className="w-full text-center"
                />
            </button>
            <div
                className="relative h-3.5 overflow-hidden rounded-sm bg-zinc-900"
                title={`${name}: ${bars.map(barTitle).join("; ")}`}
            >
                {runs.map((r) => {
                    const left = Math.max(r.from - 1, from)
                    const right = Math.min(r.to, to)
                    if (right <= left) return null
                    return (
                        <div
                            key={`${r.kind}${r.from}`}
                            className="absolute inset-y-0"
                            style={{
                                ...NEUTRAL[r.kind].style,
                                left: pct(left),
                                width: `${((right - left) / span) * 100}%`
                            }}
                        />
                    )
                })}
                {bars.map((b) => {
                    const left = Math.max(b.from, from)
                    const right = Math.min(b.to, to)
                    if (right <= left) return null
                    const c = COMPOUND[b.compound] ?? COMPOUND.UNKNOWN
                    // A stop after it: a gap before the next stint, if it's in the window.
                    const gap = !b.open && b.to <= to
                    const used = b.age != null && b.age > 0
                    return (
                        <div
                            key={b.stint}
                            className="absolute inset-y-[3px] flex items-center justify-center overflow-hidden rounded-[2px] text-[9px] font-bold leading-none text-black/75"
                            style={{
                                left: pct(left),
                                width: `calc(${((right - left) / span) * 100}%${gap ? " - 2px" : ""})`,
                                background: c.color,
                                opacity: used ? 0.55 : 1
                            }}
                            title={barTitle(b)}
                        >
                            {(right - left) / span >= 0.06 ? c.letter : null}
                        </div>
                    )
                })}
            </div>
            <span
                className="text-right tabular-nums text-zinc-400"
                title="Stops"
            >
                {Math.max(bars.length - 1, 0)}
            </span>
        </li>
    )
}

/** This race's tyre stints so far, a row per car in the running order, the neutral laps shaded behind them. */
function RaceStrategy() {
    const order = useRunningOrder()
    const states = useAllDrivers((ds) =>
        ds.map((d) => ({
            driver: d.driver,
            position: d.position,
            out: d.status === "OUT"
        }))
    )
    const stints = useAllStints()
    const done = useAllLaps(lastLaps)
    const ends = useAllLaps(lapEnds)
    const drivers = useDrivers()
    const periods = useNeutralPeriods()
    const lightsOut = useSessionInfo((i) => i.lightsOut)
    const totalLaps = useTotalLaps()
    const totalLapsEstimated = useSessionInfo((i) => i.totalLapsEstimated)

    const info = useMemo(
        () => new Map<number, DriverInfo>(drivers.map((d) => [d.number, d])),
        [drivers]
    )
    const state = useMemo(
        () => new Map(states.map((s) => [s.driver, s])),
        [states]
    )
    const leader = useMemo(() => leaderEnds(ends), [ends])
    const runs = useMemo(
        () => neutralRuns(periods, leader, lightsOut),
        [periods, leader, lightsOut]
    )
    const rows = useMemo(
        () =>
            order.map((n) => ({
                n,
                bars: stintBars(stints.get(n) ?? [], done.get(n) ?? 0)
            })),
        [order, stints, done]
    )
    const completed = leader.length - 1
    const total = Math.max(totalLaps, completed, 1)
    const win = useLapWindow(total)
    const used = rows.some((r) =>
        r.bars.some((b) => b.age != null && b.age > 0)
    )

    return (
        <section className="flex h-full flex-col text-xs">
            <div
                className="flex shrink-0 items-center gap-2 border-b border-zinc-800 px-3"
                style={{ height: HEADER_H }}
            >
                <Label as="h2" className="shrink-0 whitespace-nowrap">
                    Strategy
                </Label>
                <span className="shrink-0 text-[11px] tabular-nums text-zinc-400">
                    {win.zoomed
                        ? `laps ${win.from}–${win.to}`
                        : `${totalLapsEstimated ? "~" : ""}${total} laps`}
                </span>
                <span className="ml-auto truncate text-[11px] text-zinc-400">
                    {[
                        used && "faded: used set",
                        runs.length > 0 &&
                            `shaded: ${[...new Set(runs.map((r) => NEUTRAL[r.kind].title.toLowerCase()))].join(", ")}`
                    ]
                        .filter(Boolean)
                        .join(" · ")}
                </span>
            </div>
            {completed === 0 && rows.every((r) => r.bars.length === 0) ? (
                <p className="px-3 py-6 text-center text-zinc-400">
                    Stints show once the race starts.
                </p>
            ) : (
                // Drawn to its height (the rows share it), so a share card lays it out wide like the other lap charts.
                <ol
                    data-shot-fill=""
                    className="flex min-h-0 flex-1 flex-col overflow-y-auto"
                >
                    {rows.map(({ n, bars }) => (
                        <Row
                            key={n}
                            n={n}
                            info={info.get(n)}
                            place={state.get(n)?.position ?? null}
                            out={state.get(n)?.out ?? false}
                            bars={bars}
                            runs={runs}
                            from={win.from - 1}
                            to={win.to}
                        />
                    ))}
                </ol>
            )}
        </section>
    )
}

export default defineWidget({
    id: "race-strategy",
    name: "Strategy",
    group: "analysis",
    description:
        "This race's tyre stints so far for every car, in the running order: compounds, new or used sets, stops, and the laps behind a safety car, VSC or red flag.",
    version: "1.0.0",
    // Fills its column: the rows share its height, and scroll under ROW_MIN each.
    height: { min: HEADER_H + 10 * ROW_MIN },
    width: { min: 24, default: 42, max: 100 },
    sessions: ["race"],
    settings: {},
    Component: RaceStrategy
})
