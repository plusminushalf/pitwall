import { useMemo } from "react"
import {
    type DriverInfo,
    DriverTag,
    defineWidget,
    type FeedEntry,
    LABEL_CLASS,
    Label,
    type Lap,
    type PitStop,
    TAP_CLASS,
    teamColor,
    useAllLaps,
    useAllPitStops,
    useDrivers,
    useFeed,
    useSelection,
    useSessionInfo,
    useSettings,
    useTime,
    useWidgetSize
} from "widget-kit"
import { countPasses, type LaneIn, type PassIn, type PassRow } from "./passes"

/** `lap1`: count the passes made on lap 1. */
type Settings = { lap1: boolean }

const ROW_H = 24
const HEADER_H = 30
/** Under this many px the bars go: the numbers say the same. */
const NARROW = 320

const COLS =
    "grid grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)_28px_28px_32px] items-center gap-x-2"
const NARROW_COLS =
    "grid grid-cols-[minmax(0,1fr)_28px_28px_32px] items-center gap-x-2"

// What the widget reads of each hook: it re-renders when a pass, a stop or a lap 1 finish is added, not at 10 Hz.
const toPasses = (feed: readonly FeedEntry[]): PassIn[] =>
    feed.flatMap((e) =>
        e.kind === "overtake" && e.driver != null && e.passed != null
            ? [{ t: e.t, driver: e.driver, passed: e.passed }]
            : []
    )
const toRetired = (feed: readonly FeedEntry[]) =>
    new Map(
        feed.flatMap((e) =>
            e.kind === "retired" && e.driver != null
                ? [[e.driver, e.t] as const]
                : []
        )
    )
const toLanes = (all: ReadonlyMap<number, readonly PitStop[]>) =>
    new Map(
        [...all].map(([n, pits]): [number, LaneIn[]] => [
            n,
            pits.map(({ entry, exit }) => ({ entry, exit }))
        ])
    )
/** When the leader finished lap 1: the first car across the line at its end. Null until then. */
const toLap1End = (all: ReadonlyMap<number, readonly Lap[]>) => {
    let first: number | null = null
    for (const laps of all.values()) {
        const end = laps.find((l) => l.lap === 1)?.end
        if (end != null && (first == null || end < first)) first = end
    }
    return first
}

/** "Lewis HAMILTON" -> "Hamilton", "Nyck DE VRIES" -> "De Vries": the words in capitals, else the last. */
function surname(fullName: string): string {
    const words = fullName.split(" ")
    const caps = words.filter((w) => w.length > 1 && w === w.toUpperCase())
    return (caps.length ? caps : words.slice(-1))
        .map((w) => w.charAt(0) + w.slice(1).toLowerCase())
        .join(" ")
}

/** Passes lost to the left of the line in grey, made to the right in the team's colour. */
function Bars({
    row,
    scale,
    colour
}: {
    row: PassRow
    scale: number
    colour: string
}) {
    const pct = (n: number) => `${(n / scale) * 50}%`
    return (
        <span className="relative h-3" aria-hidden>
            <span className="absolute inset-y-0 left-1/2 w-px bg-zinc-700" />
            {row.lost > 0 && (
                <span
                    className="absolute inset-y-0.5 right-1/2 rounded-l-sm bg-zinc-600"
                    style={{ width: pct(row.lost) }}
                />
            )}
            {row.made > 0 && (
                <span
                    className="absolute inset-y-0.5 left-1/2 ml-px rounded-r-sm"
                    style={{ width: pct(row.made), background: colour }}
                />
            )}
        </span>
    )
}

function Row({
    row,
    info,
    scale,
    wide,
    focused
}: {
    row: PassRow
    info: DriverInfo | undefined
    scale: number
    wide: boolean
    focused: boolean
}) {
    const focus = useSelection((s) => s.focus)
    const net = row.made - row.lost
    return (
        <li>
            <button
                type="button"
                onClick={() => focus(row.driver)}
                title={`${info?.fullName ?? `#${row.driver}`}: ${row.made} ${row.made === 1 ? "pass" : "passes"} made, passed ${row.lost} ${row.lost === 1 ? "time" : "times"}. Click to focus.`}
                className={`${wide ? COLS : NARROW_COLS} h-6 w-full border-b border-zinc-800/70 px-3 text-left text-xs tabular-nums hover:bg-zinc-900 ${focused ? "bg-zinc-900" : ""}`}
            >
                <span className="flex min-w-0 items-center gap-1.5">
                    <DriverTag driver={info} number={row.driver} />
                    <span className="truncate text-zinc-200">
                        {info ? surname(info.fullName) : ""}
                    </span>
                </span>
                {wide && (
                    <Bars
                        row={row}
                        scale={scale}
                        colour={info ? teamColor(info.teamColour) : "#71717b"}
                    />
                )}
                <span
                    className={`text-right font-semibold ${row.made ? "text-zinc-50" : "text-zinc-400"}`}
                >
                    {row.made}
                </span>
                <span className="text-right text-zinc-400">{row.lost}</span>
                <span
                    className={`text-right font-bold ${net > 0 ? "text-emerald-400" : net < 0 ? "text-red-400" : "text-zinc-400"}`}
                >
                    {net > 0 ? "+" : net < 0 ? "−" : ""}
                    {Math.abs(net)}
                </span>
            </button>
        </li>
    )
}

/** Each driver's passes made and lost so far, on track: swaps in the pits and around a car retiring left out. */
function RaceOvertakes() {
    const passes = useFeed(toPasses)
    const retired = useFeed(toRetired)
    const pits = useAllPitStops(toLanes)
    const lap1End = useAllLaps(toLap1End)
    const drivers = useDrivers()
    const lightsOut = useSessionInfo((i) => i.lightsOut)
    const started = useTime((t) => t >= lightsOut)
    const focused = useSelection((s) => s.focused)
    const [{ lap1 }, update] = useSettings<Settings>()
    const { width } = useWidgetSize()
    const wide = width >= NARROW
    const info = useMemo(
        () => new Map<number, DriverInfo>(drivers.map((d) => [d.number, d])),
        [drivers]
    )
    const count = useMemo(
        () =>
            countPasses({
                passes,
                pits,
                retired,
                drivers: drivers.map((d) => d.number),
                from: lap1 ? null : (lap1End ?? Infinity)
            }),
        [passes, pits, retired, drivers, lap1, lap1End]
    )
    const scale = Math.max(
        1,
        ...count.rows.map((r) => Math.max(r.made, r.lost))
    )
    const left = [
        count.pits > 0 && `${count.pits} with a car in the pit lane`,
        count.retiring > 0 && `${count.retiring} on a car retiring`,
        count.lap1 > 0 && `${count.lap1} on lap 1`
    ].filter(Boolean)

    return (
        <section className="flex h-full flex-col text-sm">
            <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-1.5">
                <Label as="h2" className="shrink-0 whitespace-nowrap">
                    Overtakes
                </Label>
                <span
                    className="truncate text-[11px] text-zinc-400"
                    title={`Places changed on track between two cars, from OpenF1's overtakes.${left.length ? ` Left out: ${left.join(", ")}.` : ""}`}
                >
                    {lap1 ? "On-track passes" : "On-track passes from lap 2"}
                </span>
                <span className="ml-auto shrink-0 text-[11px] tabular-nums text-zinc-300">
                    {count.total} {count.total === 1 ? "pass" : "passes"}
                </span>
                <button
                    type="button"
                    data-shot-control=""
                    onClick={() => update({ lap1: !lap1 })}
                    aria-pressed={lap1}
                    title={
                        lap1
                            ? "Counting lap 1's passes: click to leave them out"
                            : "Leaving out lap 1's passes: click to count them"
                    }
                    className={`${TAP_CLASS} shrink-0 rounded-md px-2 text-[11px] leading-5 ${lap1 ? "bg-zinc-700 text-zinc-50" : "bg-zinc-900 text-zinc-300 hover:text-white"}`}
                >
                    Lap 1
                </button>
            </div>
            {!started || count.total === 0 ? (
                <p className="px-3 py-6 text-center text-xs text-zinc-400">
                    {started
                        ? "No passes yet"
                        : "Overtakes show from lights out"}
                </p>
            ) : (
                <>
                    <div
                        className={`${wide ? COLS : NARROW_COLS} border-b border-zinc-800 px-3 py-1 ${LABEL_CLASS}`}
                    >
                        <span>Driver</span>
                        {wide && (
                            <span className="flex justify-between">
                                <span>Lost</span>
                                <span>Made</span>
                            </span>
                        )}
                        <span className="text-right" title="Passes made">
                            Made
                        </span>
                        <span className="text-right" title="Times passed">
                            Lost
                        </span>
                        <span className="text-right" title="Made − lost">
                            Net
                        </span>
                    </div>
                    <ol className="min-h-0 flex-1 overflow-y-auto">
                        {count.rows.map((r) => (
                            <Row
                                key={r.driver}
                                row={r}
                                info={info.get(r.driver)}
                                scale={scale}
                                wide={wide}
                                focused={focused === r.driver}
                            />
                        ))}
                    </ol>
                </>
            )}
        </section>
    )
}

export default defineWidget({
    id: "race-overtakes",
    name: "Overtakes",
    group: "session",
    description:
        "This race's passes so far: how many each driver made and lost on track, places swapped in the pits and around a car retiring left out. Click one to focus them.",
    version: "1.0.0",
    // The header, column labels and six drivers; fills its column and scrolls inside.
    height: { min: HEADER_H + 25 + 6 * ROW_H },
    width: { min: 18, default: 28, max: 50 },
    sessions: ["race"],
    settings: { lap1: true },
    fields: {
        lap1: { kind: "toggle", label: "Count lap 1" }
    },
    Component: RaceOvertakes
})
