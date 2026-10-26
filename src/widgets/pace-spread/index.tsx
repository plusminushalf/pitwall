import { useMemo } from "react"
import {
    type DriverInfo,
    DriverTag,
    defineWidget,
    LABEL_CLASS,
    Label,
    lapTime,
    shortTeam,
    TAP_CLASS,
    teamColor,
    useAllLaps,
    useAllStints,
    useDrivers,
    useNeutralPeriods,
    useSelection,
    useSettings,
    useWidgetSize
} from "widget-kit"
import {
    CUTOFF,
    MIN_LAPS,
    type Spread,
    type SpreadLap,
    spreads,
    ticks
} from "./spread"

type By = "drivers" | "teams"
type Settings = { by: By }

const ROW_H = 24
const HEADER_H = 30
const AXIS_H = 20
/** The name column, and the median and gap columns after the chart. */
const NAME_W = 124
const MEDIAN_W = 72
const GAP_W = 56
/** Room either side of the boxes, so a whisker's end isn't on the frame. */
const PAD = 8

const toLaps = (all: ReadonlyMap<number, readonly SpreadLap[]>) =>
    new Map(
        [...all].map(([n, laps]) => [
            n,
            laps.map(({ lap, start, end, duration, pitOut }) => ({
                lap,
                start,
                end,
                duration,
                pitOut
            }))
        ])
    )
const toStarts = (all: ReadonlyMap<number, readonly { lapStart: number }[]>) =>
    new Map([...all].map(([n, s]) => [n, s.map((x) => x.lapStart)]))

/** 91.53 -> "1:31.5": an axis label, to the tenth. */
function axisTime(s: number): string {
    const m = Math.floor(s / 60)
    const rest = (s - m * 60).toFixed(1).padStart(4, "0")
    return m > 0 ? `${m}:${rest}` : rest
}

/** "Lewis HAMILTON" -> "Hamilton": the words in capitals, else the last. */
function surname(fullName: string): string {
    const words = fullName.split(" ")
    const caps = words.filter((w) => w.length > 1 && w === w.toUpperCase())
    return (caps.length ? caps : words.slice(-1))
        .map((w) => w.charAt(0) + w.slice(1).toLowerCase())
        .join(" ")
}

function rowTitle(name: string, s: Spread): string {
    return `${name}: ${s.laps} clean laps. Median ${lapTime(s.median)}, the middle half ${lapTime(s.q1)} to ${lapTime(s.q3)}, best ${lapTime(s.best)}.`
}

/** One row's box plot, on the shared scale `x` (s -> px). */
function Box({
    s,
    x,
    width,
    colour
}: {
    s: Spread
    x: (v: number) => number
    width: number
    colour: string
}) {
    const mid = ROW_H / 2
    const clamp = (v: number) => Math.min(width - 2, Math.max(2, x(v)))
    return (
        <svg width={width} height={ROW_H} aria-hidden className="block">
            <line
                x1={x(s.low)}
                x2={x(s.high)}
                y1={mid}
                y2={mid}
                stroke={colour}
                strokeWidth={1.5}
            />
            {[s.low, s.high].map((v) => (
                <line
                    key={v}
                    x1={x(v)}
                    x2={x(v)}
                    y1={mid - 4}
                    y2={mid + 4}
                    stroke={colour}
                    strokeWidth={1.5}
                />
            ))}
            <rect
                x={x(s.q1)}
                y={mid - 7}
                width={Math.max(2, x(s.q3) - x(s.q1))}
                height={14}
                rx={2}
                fill={colour}
                fillOpacity={0.45}
                stroke={colour}
                strokeWidth={1.5}
            />
            <line
                x1={x(s.median)}
                x2={x(s.median)}
                y1={mid - 7}
                y2={mid + 7}
                stroke="#fafafa"
                strokeWidth={2}
            />
            {s.outliers.map((v, i) => (
                <circle
                    // biome-ignore lint/suspicious/noArrayIndexKey: equal lap times can repeat
                    key={i}
                    cx={clamp(v)}
                    cy={mid}
                    r={2}
                    fill="none"
                    stroke={colour}
                    strokeWidth={1}
                />
            ))}
        </svg>
    )
}

/** Each driver's (or team's) clean laps so far as a box plot, lowest median first. */
function PaceSpread() {
    const all = useAllLaps(toLaps)
    const starts = useAllStints(toStarts)
    const neutral = useNeutralPeriods()
    const drivers = useDrivers()
    const focus = useSelection((s) => s.focus)
    const [{ by }, update] = useSettings<Settings>()
    const { width } = useWidgetSize()

    const info = useMemo(
        () => new Map<number, DriverInfo>(drivers.map((d) => [d.number, d])),
        [drivers]
    )
    const colourOfTeam = useMemo(
        () => new Map(drivers.map((d) => [d.team, d.teamColour])),
        [drivers]
    )
    const { rows, short } = useMemo(
        () =>
            spreads(
                [...all].map(([n, laps]) => ({
                    driver: n,
                    team: info.get(n)?.team ?? `#${n}`,
                    laps,
                    stints: (starts.get(n) ?? []).map((lapStart) => ({
                        lapStart
                    }))
                })),
                neutral,
                by
            ),
        [all, starts, neutral, info, by]
    )

    const chartW = Math.max(80, width - NAME_W - MEDIAN_W - GAP_W)
    // The scale runs whisker to whisker: an outlier past it sits on the edge.
    const lo = Math.min(...rows.map((r) => r.low))
    const hi = Math.max(...rows.map((r) => r.high))
    const span = Math.max(hi - lo, 0.5)
    const x = (v: number) => PAD + ((v - lo) / span) * (chartW - 2 * PAD)
    const lines = rows.length ? ticks(lo, hi, Math.floor(chartW / 56)) : []
    const leader = rows[0]?.median

    return (
        <section className="flex h-full flex-col text-sm">
            <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-1.5">
                <Label as="h2" className="shrink-0 whitespace-nowrap">
                    Lap time spread
                </Label>
                <span
                    className="truncate text-[11px] text-zinc-400"
                    title={`Laps as driven, fuel and tyres not taken out. Left out: lap 1, in-laps and out-laps, laps under a safety car, VSC or red flag, and laps over ${Math.round((CUTOFF - 1) * 100)}% slower than the driver's best. The box is the middle half of the laps, the white line the median.`}
                >
                    Clean laps, as driven
                </span>
                <div
                    data-shot-control=""
                    className="ml-auto flex shrink-0 rounded-md bg-zinc-900 p-0.5"
                >
                    {(["drivers", "teams"] as const).map((v) => (
                        <button
                            type="button"
                            key={v}
                            onClick={() => update({ by: v })}
                            aria-pressed={by === v}
                            className={`${TAP_CLASS} rounded px-2 text-[11px] leading-5 ${by === v ? "bg-zinc-700 text-zinc-50" : "text-zinc-300 hover:text-white"}`}
                            title={
                                v === "teams"
                                    ? "A box per team, both cars' laps together"
                                    : "A box per driver"
                            }
                        >
                            {v === "teams" ? "Teams" : "Drivers"}
                        </button>
                    ))}
                </div>
            </div>
            <div
                className={`grid items-center border-b border-zinc-800 py-1 ${LABEL_CLASS}`}
                style={{
                    gridTemplateColumns: `${NAME_W}px ${chartW}px ${MEDIAN_W}px ${GAP_W}px`
                }}
            >
                <span className="px-3">
                    {by === "teams" ? "Team" : "Driver"}
                </span>
                <span className="px-2">Lap times</span>
                <span className="px-2 text-right">Median</span>
                <span className="pr-3 text-right">Gap</span>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
                {rows.length === 0 ? (
                    <p className="px-3 py-6 text-center text-xs text-zinc-400">
                        {`No one has ${MIN_LAPS} clean laps yet`}
                    </p>
                ) : (
                    <ol>
                        {rows.map((s) => {
                            const d =
                                typeof s.key === "number"
                                    ? info.get(s.key)
                                    : undefined
                            const team =
                                typeof s.key === "string" ? s.key : null
                            const colour = teamColor(
                                (team
                                    ? colourOfTeam.get(team)
                                    : d?.teamColour) ?? "71717b"
                            )
                            const name = team
                                ? shortTeam(team)
                                : d
                                  ? surname(d.fullName)
                                  : `#${s.key}`
                            const gap = leader == null ? 0 : s.median - leader
                            return (
                                <li
                                    key={s.key}
                                    className="grid items-center border-b border-zinc-800/70"
                                    style={{
                                        gridTemplateColumns: `${NAME_W}px ${chartW}px ${MEDIAN_W}px ${GAP_W}px`,
                                        height: ROW_H
                                    }}
                                    title={rowTitle(name, s)}
                                >
                                    {team ? (
                                        <span className="flex min-w-0 items-center gap-1.5 px-3">
                                            <span
                                                aria-hidden
                                                className="h-3.5 w-1 shrink-0 rounded-sm"
                                                style={{ background: colour }}
                                            />
                                            <span className="truncate text-xs font-semibold text-zinc-100">
                                                {name}
                                            </span>
                                        </span>
                                    ) : (
                                        <button
                                            type="button"
                                            onClick={() =>
                                                focus(s.key as number)
                                            }
                                            className="flex h-5 min-w-0 items-center gap-1.5 rounded-sm px-3 text-left"
                                            title={`Focus ${d?.acronym ?? name}`}
                                        >
                                            <DriverTag
                                                driver={d}
                                                number={s.key as number}
                                            />
                                            <span className="truncate text-xs text-zinc-200">
                                                {name}
                                            </span>
                                        </button>
                                    )}
                                    <Box
                                        s={s}
                                        x={x}
                                        width={chartW}
                                        colour={colour}
                                    />
                                    <span className="px-2 text-right text-xs font-semibold tabular-nums text-zinc-50">
                                        {lapTime(s.median)}
                                    </span>
                                    <span className="pr-3 text-right text-xs tabular-nums text-zinc-400">
                                        {gap === 0 ? "" : `+${gap.toFixed(3)}`}
                                    </span>
                                </li>
                            )
                        })}
                    </ol>
                )}
                {rows.length > 0 && (
                    <svg
                        width={NAME_W + chartW}
                        height={AXIS_H}
                        aria-hidden
                        className="block"
                    >
                        {lines.map((v) => (
                            <text
                                key={v}
                                x={NAME_W + x(v)}
                                y={13}
                                textAnchor="middle"
                                className="fill-zinc-400 text-[10px] tabular-nums"
                            >
                                {axisTime(v)}
                            </text>
                        ))}
                    </svg>
                )}
                {short > 0 && rows.length > 0 && (
                    <p className="border-t border-zinc-800 px-3 py-1 text-[11px] leading-4 text-zinc-400">
                        {`${short} ${by === "teams" ? (short === 1 ? "team" : "teams") : short === 1 ? "driver" : "drivers"} with under ${MIN_LAPS} clean laps not shown`}
                    </p>
                )}
            </div>
        </section>
    )
}

export default defineWidget({
    id: "pace-spread",
    name: "Lap time spread",
    group: "analysis",
    description:
        "Each driver's clean laps as a box plot, lowest median first: how quick they typically were and how much their laps varied. Laps as driven; Pace order's race pace takes fuel and tyres out.",
    version: "1.0.0",
    // The header, column labels and five rows; fills its column and scrolls inside.
    height: { min: HEADER_H + 25 + 5 * ROW_H + AXIS_H },
    width: { min: 24, default: 34, max: 60 },
    sessions: ["race"],
    settings: { by: "drivers" as By },
    fields: {
        by: {
            kind: "choice",
            label: "Rows",
            options: [
                { value: "drivers", label: "Drivers" },
                { value: "teams", label: "Teams" }
            ]
        }
    },
    Component: PaceSpread
})
