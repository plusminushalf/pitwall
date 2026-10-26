import { useMemo } from "react"
import {
    type DriverInfo,
    type DriverState,
    DriverTag,
    defineWidget,
    LABEL_CLASS,
    Label,
    type Lap,
    teamColor,
    useAllDrivers,
    useAllLaps,
    useDrivers,
    useSelection,
    useSessionInfo,
    useTime,
    useWidgetSize
} from "widget-kit"
import { type CarIn, lap1Places, type PlaceRow, placesGained } from "./places"

const ROW_H = 24
const HEADER_H = 30
/** Under this many px the grid-to-now track goes: the numbers say the same. */
const NARROW = 340

const COLS =
    "grid grid-cols-[minmax(0,1fr)_28px_28px_minmax(0,1.4fr)_36px_36px] items-center gap-x-2"
const NARROW_COLS =
    "grid grid-cols-[minmax(0,1fr)_28px_28px_36px_36px] items-center gap-x-2"

// What the widget reads of each hook: it re-renders when a place changes, not at 10 Hz.
const toCars = (all: readonly DriverState[]): CarIn[] =>
    all.map((d) => ({
        driver: d.driver,
        grid: d.gridPosition,
        position: d.position,
        out: d.status === "OUT"
    }))
/** When each car crossed the line at the end of lap 1. */
const toLap1Ends = (all: ReadonlyMap<number, readonly Lap[]>) =>
    new Map(
        [...all].flatMap(([n, laps]) => {
            const end = laps.find((l) => l.lap === 1)?.end
            return end == null ? [] : [[n, end] as const]
        })
    )

/** "Lewis HAMILTON" -> "Hamilton", "Nyck DE VRIES" -> "De Vries": the words in capitals, else the last. */
function surname(fullName: string): string {
    const words = fullName.split(" ")
    const caps = words.filter((w) => w.length > 1 && w === w.toUpperCase())
    return (caps.length ? caps : words.slice(-1))
        .map((w) => w.charAt(0) + w.slice(1).toLowerCase())
        .join(" ")
}

/** +3 in emerald, -2 in red as the timing tower has them, 0 as a dash; a retired car's in grey. */
function Change({ v, out }: { v: number | null; out: boolean }) {
    if (v == null) return <span className="text-zinc-500">–</span>
    if (v === 0) return <span className="text-zinc-400">0</span>
    const colour = out
        ? "text-zinc-400"
        : v > 0
          ? "text-emerald-400"
          : "text-red-400"
    return (
        <span className={colour}>
            {v > 0 ? "+" : "−"}
            {Math.abs(v)}
        </span>
    )
}

/** Grid slot to position now on a P1..Pn track: a hollow dot where the car started, its colour where it is. */
function Track({
    row,
    field,
    colour
}: {
    row: PlaceRow
    field: number
    colour: string
}) {
    const x = (p: number) =>
        `${((Math.min(p, field) - 1) / Math.max(1, field - 1)) * 100}%`
    const from = x(row.start)
    const to = row.position == null ? from : x(row.position)
    const net = row.net ?? 0
    const line = row.out
        ? "bg-zinc-600"
        : net > 0
          ? "bg-emerald-400/70"
          : net < 0
            ? "bg-red-400/70"
            : "bg-zinc-600"
    const left = net > 0 ? to : from
    const right = net > 0 ? from : to
    return (
        <span className="relative mx-1.5 h-3" aria-hidden>
            <span className="absolute inset-x-0 top-1/2 h-px bg-zinc-800" />
            <span
                className={`absolute top-1/2 h-0.5 -translate-y-1/2 ${line}`}
                style={{ left, width: `calc(${right} - ${left})` }}
            />
            <span
                className="absolute top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-zinc-400 bg-zinc-950"
                style={{ left: from }}
            />
            {row.position != null && (
                <span
                    className={`absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full ${row.out ? "opacity-40" : ""}`}
                    style={{ left: to, background: colour }}
                />
            )}
        </span>
    )
}

function Row({
    row,
    info,
    field,
    wide,
    focused
}: {
    row: PlaceRow
    info: DriverInfo | undefined
    field: number
    wide: boolean
    focused: boolean
}) {
    const focus = useSelection((s) => s.focus)
    const started =
        row.grid == null ? "the pit lane" : `P${row.grid} on the grid`
    const now = row.out
        ? `retired from P${row.position ?? "?"}`
        : row.position == null
          ? "no position yet"
          : `P${row.position} now`
    return (
        <li>
            <button
                type="button"
                onClick={() => focus(row.driver)}
                title={`${info?.fullName ?? `#${row.driver}`}: from ${started}, ${now}${row.lap1 != null ? `; P${row.lap1} after lap 1` : ""}. Click to focus.`}
                className={`${wide ? COLS : NARROW_COLS} h-6 w-full border-b border-zinc-800/70 px-3 text-left text-xs tabular-nums hover:bg-zinc-900 ${focused ? "bg-zinc-900" : ""}`}
            >
                <span
                    className={`flex min-w-0 items-center gap-1.5 ${row.out ? "opacity-60" : ""}`}
                >
                    <DriverTag driver={info} number={row.driver} />
                    <span className="truncate text-zinc-200">
                        {info ? surname(info.fullName) : ""}
                    </span>
                </span>
                <span className="text-right text-zinc-400">
                    {row.grid ?? "Pit"}
                </span>
                <span className="text-right font-semibold text-zinc-50">
                    {row.out ? (
                        <span className="text-[11px] font-semibold text-zinc-400">
                            DNF
                        </span>
                    ) : (
                        (row.position ?? "–")
                    )}
                </span>
                {wide && (
                    <Track
                        row={row}
                        field={field}
                        colour={info ? teamColor(info.teamColour) : "#71717b"}
                    />
                )}
                <span className="text-right font-bold">
                    <Change v={row.net} out={row.out} />
                </span>
                <span className="text-right">
                    <Change v={row.lap1Net} out={false} />
                </span>
            </button>
        </li>
    )
}

/** Every car's grid slot against its position now, and on lap 1: the places gained, most first. */
function PlacesGained() {
    const cars = useAllDrivers(toCars)
    const lap1Ends = useAllLaps(toLap1Ends)
    const drivers = useDrivers()
    const lightsOut = useSessionInfo((i) => i.lightsOut)
    const started = useTime((t) => t >= lightsOut)
    const focused = useSelection((s) => s.focused)
    const { width } = useWidgetSize()
    const wide = width >= NARROW
    const info = useMemo(
        () => new Map<number, DriverInfo>(drivers.map((d) => [d.number, d])),
        [drivers]
    )
    const rows = useMemo(
        () => placesGained(cars, lap1Places(lap1Ends)),
        [cars, lap1Ends]
    )
    const field = Math.max(cars.length, ...rows.map((r) => r.start))

    return (
        <section className="flex h-full flex-col text-sm">
            <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-1.5">
                <Label as="h2" className="shrink-0 whitespace-nowrap">
                    Places gained
                </Label>
                <span className="truncate text-[11px] text-zinc-400">
                    From the grid, and on lap 1
                </span>
            </div>
            {!started ? (
                <p className="px-3 py-6 text-center text-xs text-zinc-400">
                    Places gained show from lights out
                </p>
            ) : (
                <>
                    <div
                        className={`${wide ? COLS : NARROW_COLS} border-b border-zinc-800 px-3 py-1 ${LABEL_CLASS}`}
                    >
                        <span>Driver</span>
                        <span className="text-right">Grid</span>
                        <span
                            className="text-right"
                            title="Position now; at the flag, where the car finished"
                        >
                            Pos
                        </span>
                        {wide && (
                            <span className="mx-1.5 flex justify-between">
                                <span>P1</span>
                                <span>P{field}</span>
                            </span>
                        )}
                        <span
                            className="text-right"
                            title="Places gained since the start (pit-lane starters count from the back)"
                        >
                            Net
                        </span>
                        <span
                            className="text-right"
                            title="Places gained by the end of lap 1"
                        >
                            Lap 1
                        </span>
                    </div>
                    <ol className="min-h-0 flex-1 overflow-y-auto">
                        {rows.map((r) => (
                            <Row
                                key={r.driver}
                                row={r}
                                info={info.get(r.driver)}
                                field={field}
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
    id: "places-gained",
    name: "Places gained",
    group: "session",
    description:
        "Every driver's grid slot against their position now (at the flag, the result), and the places gained on lap 1. Click one to focus them.",
    version: "1.0.0",
    // The header, column labels and six drivers; fills its column and scrolls inside.
    height: { min: HEADER_H + 25 + 6 * ROW_H },
    width: { min: 18, default: 30, max: 50 },
    sessions: ["race"],
    settings: {},
    Component: PlacesGained
})
