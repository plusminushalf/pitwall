import { type KeyboardEvent, type MouseEvent, useMemo, useRef } from "react"
import {
    type CompareStyle,
    compareStyles,
    type DriverInfo,
    defineWidget,
    type FeedEntry,
    LABEL_CLASS,
    type Lap,
    type PitStop,
    useAllDrivers,
    useAllLaps,
    useAllPitStops,
    useCardState,
    useDrivers,
    useFeed,
    useFrame,
    useLapWindow,
    useNeutralPeriods,
    usePlayback,
    useSelection,
    useSessionInfo,
    useTotalLaps,
    useWidgetSize
} from "widget-kit"
import {
    type Crossings,
    crossingsOf,
    type LapPositions,
    lapPositions,
    lapsLed,
    leaderCrossings,
    type Neutral,
    neutralLaps,
    orderAt
} from "./chart"

const FONT = "10px ui-sans-serif, system-ui, sans-serif"
const LABEL_FONT = "600 10px ui-sans-serif, system-ui, sans-serif"
/** The padding around the chart (px-3, pt-2, pb-2) and the title line over it. */
const PAD_X = 24
const PAD_Y = 16
const HEAD_H = 20
/** Inside the canvas: the neutral laps' labels on top, the lap numbers under the plot, the order down each side. */
const TOP = 14
const BOTTOM = 16
const SIDE = 50
/** Room above the first place and below the last, so a dot or cross there isn't cut. */
const INSET = 5
const LAP_PX = 30
const LAP_STEPS = [1, 2, 5, 10, 20, 25, 50]
const GROUND = "#09090b"
/** With a car picked (selected, or under the pointer), the others are drawn this faint. */
const FAINT = 0.18
const NEUTRAL: Record<Neutral, { fill: string; label: string; title: string }> =
    {
        SC: {
            fill: "rgba(255, 210, 48, 0.12)",
            label: "SC",
            title: "Safety car"
        },
        VSC: {
            fill: "rgba(255, 210, 48, 0.06)",
            label: "VSC",
            title: "Virtual safety car"
        },
        RED: {
            fill: "rgba(231, 0, 11, 0.16)",
            label: "RED",
            title: "Red flag"
        }
    }

/** Every car's crossings, by car number: compared by value, so the chart re-renders only when someone completes a lap. */
const allCrossings = (
    laps: ReadonlyMap<number, readonly Lap[]>
): ReadonlyMap<number, Crossings> =>
    new Map([...laps].map(([n, l]) => [n, crossingsOf(l)]))

/** The laps each car pitted on (its in-lap). */
const pitLaps = (
    pits: ReadonlyMap<number, readonly PitStop[]>
): ReadonlyMap<number, number[]> =>
    new Map([...pits].map(([n, p]) => [n, p.map((s) => s.lap)]))

/** The cars that have retired so far (the feed's retirements, so never ahead of the replay), by number. */
const retiredCars = (feed: readonly FeedEntry[]): number[] =>
    feed
        .flatMap((e) =>
            e.kind === "retired" && e.driver != null ? [e.driver] : []
        )
        .sort((a, b) => a - b)

/** A line as drawn: its car, colour and dash, its pit laps, and whether the car has retired (its line ends in a cross). */
interface Line {
    series: LapPositions
    info: DriverInfo
    style: CompareStyle
    pits: readonly number[]
    out: boolean
}

/** Where things go on the canvas, CSS px. */
interface Layout {
    w: number
    h: number
    plotW: number
    plotBottom: number
    /** The lap at the left edge (0: the grid) and laps across the chart: the race distance, or the timeline's lap window. */
    from: number
    laps: number
    /** Places down the chart: the field. */
    places: number
}

const xOf = (L: Layout, lap: number) =>
    SIDE + ((lap - L.from) / L.laps) * L.plotW
const yOf = (L: Layout, p: number) =>
    TOP +
    INSET +
    ((p - 1) / Math.max(L.places - 1, 1)) * (L.plotBottom - TOP - 2 * INSET)
const lapAt = (L: Layout, x: number) =>
    L.from + Math.round(((x - SIDE) / L.plotW) * L.laps)
const placeAt = (L: Layout, y: number) =>
    1 +
    Math.round(
        ((y - TOP - INSET) / (L.plotBottom - TOP - 2 * INSET)) *
            Math.max(L.places - 1, 1)
    )

/** The car under the pointer: the one in that place at that lap (null: none there). */
const carAt = (lines: readonly Line[], lap: number, place: number) =>
    lines.find((l) => l.series.positions[lap] === place)?.info.number ?? null

function draw(
    canvas: HTMLCanvasElement,
    L: Layout,
    lines: Line[],
    neutral: (Neutral | null)[],
    /** The cars drawn bright (the rest faint); empty: every car. */
    bright: ReadonlySet<number>,
    left: readonly number[],
    right: readonly number[],
    hover: number | null,
    dpr: number
) {
    const pw = Math.round(L.w * dpr)
    const ph = Math.round(L.h * dpr)
    if (canvas.width !== pw || canvas.height !== ph) {
        canvas.width = pw
        canvas.height = ph
    }
    const ctx = canvas.getContext("2d")
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, L.w, L.h)
    ctx.font = FONT
    const lo = L.from
    const hi = L.from + L.laps
    const lit = (n: number) => bright.size === 0 || bright.has(n)

    // Neutral laps: a wash over each run of them, labelled on top; a VSC hatched too, so it isn't told by shade alone.
    for (let n = 1; n < neutral.length; n++) {
        const kind = neutral[n]
        if (!kind || neutral[n - 1] === kind) continue
        let end = n
        while (neutral[end + 1] === kind) end++
        const x0 = Math.max(xOf(L, n - 1), SIDE)
        const x1 = Math.min(xOf(L, end), SIDE + L.plotW)
        if (x1 <= x0) continue
        ctx.fillStyle = NEUTRAL[kind].fill
        ctx.fillRect(x0, TOP, x1 - x0, L.plotBottom - TOP)
        if (kind === "VSC") {
            ctx.save()
            ctx.beginPath()
            ctx.rect(x0, TOP, x1 - x0, L.plotBottom - TOP)
            ctx.clip()
            ctx.strokeStyle = "rgba(255, 210, 48, 0.12)"
            ctx.lineWidth = 1
            ctx.beginPath()
            for (let x = x0 - L.h; x < x1; x += 6) {
                ctx.moveTo(x, L.plotBottom)
                ctx.lineTo(x + (L.plotBottom - TOP), TOP)
            }
            ctx.stroke()
            ctx.restore()
        }
        ctx.fillStyle = kind === "RED" ? "#ff6467" : "#fee685"
        ctx.textAlign = "center"
        ctx.textBaseline = "top"
        ctx.fillText(NEUTRAL[kind].label, (x0 + x1) / 2, 1)
    }

    // Lap numbers ("Grid" under lap 0).
    const every =
        LAP_STEPS.find((s) => (s / L.laps) * L.plotW >= LAP_PX) ?? L.laps
    ctx.fillStyle = "#9f9fa9"
    ctx.textAlign = "center"
    ctx.textBaseline = "top"
    if (lo === 0) ctx.fillText("Grid", xOf(L, 0), L.plotBottom + 3)
    for (let n = (Math.floor(lo / every) + 1) * every; n <= hi; n += every)
        if ((n - lo) / L.laps > 0.06 || lo > 0)
            ctx.fillText(String(n), xOf(L, n), L.plotBottom + 3)

    // The lines, the faint ones first so the bright ones sit on top; broken where a car has no place.
    const ordered = [...lines].sort(
        (a, b) => Number(lit(a.info.number)) - Number(lit(b.info.number))
    )
    ctx.save()
    ctx.beginPath()
    ctx.rect(SIDE - 6, 0, L.plotW + 12, L.plotBottom + 1)
    ctx.clip()
    ctx.lineJoin = "round"
    ctx.lineCap = "round"
    for (const line of ordered) {
        const { positions } = line.series
        const on = lit(line.info.number)
        ctx.globalAlpha = on ? 1 : FAINT
        ctx.lineWidth = on && bright.size > 0 ? 2.5 : 1.75
        ctx.strokeStyle = line.style.color
        ctx.fillStyle = line.style.color
        ctx.setLineDash(line.style.dash)
        ctx.beginPath()
        for (let n = lo; n < positions.length && n <= hi; n++) {
            const p = positions[n]
            if (p == null) continue
            const x = xOf(L, n)
            const y = yOf(L, p)
            if (n > lo && positions[n - 1] != null) ctx.lineTo(x, y)
            else ctx.moveTo(x, y)
        }
        ctx.stroke()
        ctx.setLineDash([])
        // Pit stops: a dot on the in-lap.
        for (const lap of line.pits) {
            const p = positions[lap]
            if (lap < lo || lap > hi || p == null) continue
            dot(ctx, xOf(L, lap), yOf(L, p), 2.5, line.style.color)
        }
        // A retired car's line ends in a cross.
        const last = positions.length - 1
        const p = positions[last]
        if (line.out && last >= lo && last <= hi && p != null)
            cross(ctx, xOf(L, last), yOf(L, p), 3, line.style.color)
    }
    ctx.globalAlpha = 1
    ctx.restore()

    // The order down each side: at the left edge's lap (the grid, unzoomed), and at the right edge's (now).
    const info = new Map(lines.map((l) => [l.info.number, l]))
    const label = (n: number, place: number, side: "left" | "right") => {
        const line = info.get(n)
        if (!line) return
        const on = lit(n)
        const y = yOf(L, place)
        const stripe = side === "left" ? 0 : L.w - 2
        ctx.globalAlpha = on ? 1 : 0.5
        ctx.fillStyle = line.style.color
        ctx.fillRect(stripe, y - 4, 2, 8)
        ctx.globalAlpha = 1
        ctx.textBaseline = "middle"
        ctx.font = FONT
        ctx.fillStyle = "#9f9fa9"
        ctx.textAlign = side === "left" ? "left" : "right"
        const num = String(place)
        ctx.fillText(num, side === "left" ? 5 : L.w - 5, y)
        ctx.font = LABEL_FONT
        ctx.fillStyle =
            on && bright.size > 0 ? "#fafafa" : on ? "#d4d4d8" : "#9f9fa9"
        ctx.textAlign = side === "left" ? "right" : "left"
        ctx.fillText(
            line.info.acronym,
            side === "left" ? SIDE - 6 : L.w - SIDE + 6,
            y
        )
    }
    for (const [i, n] of left.entries()) label(n, i + 1, "left")
    for (const [i, n] of right.entries()) label(n, i + 1, "right")

    // The hovered lap: a crosshair.
    if (hover != null) {
        const x = Math.round(xOf(L, hover)) + 0.5
        ctx.strokeStyle = "#71717b"
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(x, TOP)
        ctx.lineTo(x, L.plotBottom)
        ctx.stroke()
    }
}

/** A dot with a 1.5 px ring in the ground colour, so it stays clear of the lines it sits on. */
function dot(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    r: number,
    color: string
) {
    ctx.beginPath()
    ctx.arc(x, y, r + 1.5, 0, Math.PI * 2)
    ctx.fillStyle = GROUND
    ctx.fill()
    ctx.beginPath()
    ctx.arc(x, y, r, 0, Math.PI * 2)
    ctx.fillStyle = color
    ctx.fill()
}

/** An × with a 2 px outline in the ground colour: where a retired car's line ends. */
function cross(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    r: number,
    color: string
) {
    ctx.save()
    ctx.lineCap = "round"
    ctx.beginPath()
    ctx.moveTo(x - r, y - r)
    ctx.lineTo(x + r, y + r)
    ctx.moveTo(x + r, y - r)
    ctx.lineTo(x - r, y + r)
    ctx.strokeStyle = GROUND
    ctx.lineWidth = 5
    ctx.stroke()
    ctx.strokeStyle = color
    ctx.lineWidth = 2
    ctx.stroke()
    ctx.restore()
}

/** "+3" gained since the grid, "−2" lost, "=" none. */
const change = (from: number | null, to: number) =>
    from == null
        ? null
        : from === to
          ? "="
          : from > to
            ? `+${from - to}`
            : `−${to - from}`

function Tooltip({
    lap,
    line,
    neutral,
    left
}: {
    lap: number
    line: Line | null
    neutral: Neutral | null
    left: boolean
}) {
    const p = line?.series.positions[lap] ?? null
    const grid = line?.series.positions[0] ?? null
    const diff = p != null && lap > 0 ? change(grid, p) : null
    return (
        <div
            className={`pointer-events-none absolute top-0 z-10 min-w-32 rounded-md border border-zinc-800 bg-zinc-900 px-2.5 py-2 text-xs shadow-lg ${left ? "-translate-x-full" : ""}`}
        >
            <div className={`${LABEL_CLASS} whitespace-nowrap`}>
                {lap === 0 ? "Grid" : `Lap ${lap}`}
                {neutral && lap > 0 && (
                    <span
                        className={`font-normal normal-case tracking-normal ${neutral === "RED" ? "text-red-400" : "text-amber-200"}`}
                    >
                        {" "}
                        · {NEUTRAL[neutral].title}
                    </span>
                )}
            </div>
            {line && p != null && (
                <div className="mt-1 flex items-center gap-2 whitespace-nowrap">
                    <span
                        className="h-3 w-1 shrink-0 rounded-sm"
                        style={{ background: line.style.color }}
                    />
                    <span className="font-semibold text-zinc-100">
                        {line.info.acronym}
                    </span>
                    <span className="tabular-nums text-zinc-100">P{p}</span>
                    {diff && (
                        <span
                            className={`tabular-nums ${diff.startsWith("+") ? "text-emerald-400" : "text-zinc-400"}`}
                            title="Places since the grid"
                        >
                            {diff}
                        </span>
                    )}
                    {line.pits.includes(lap) && (
                        <span className="text-zinc-400">· pitted</span>
                    )}
                </div>
            )}
            <div className="mt-1.5 whitespace-nowrap text-[11px] text-zinc-400">
                Click to watch from lap {Math.max(lap, 1)}
            </div>
        </div>
    )
}

/** Every car's place at the end of each lap so far, from the grid; pit stops dotted, neutral laps shaded. */
function LapChart() {
    const all = useAllLaps(allCrossings)
    const grid = useAllDrivers(
        (ds) => new Map(ds.map((d) => [d.driver, d.gridPosition]))
    )
    // The places of the cars that have taken the flag: the classification (see lapPositions).
    const finished = useAllDrivers(
        (ds) =>
            new Map(
                ds.flatMap((d) =>
                    d.status === "FINISHED" && d.position != null
                        ? [[d.driver, d.position] as const]
                        : []
                )
            )
    )
    const pits = useAllPitStops(pitLaps)
    const drivers = useDrivers()
    const retired = useFeed(retiredCars)
    const selected = useSelection((s) => s.selected)
    const periods = useNeutralPeriods()
    const lightsOut = useSessionInfo((i) => i.lightsOut)
    const totalLaps = useTotalLaps()
    const seekToLap = usePlayback((p) => p.seekToLap)
    const size = useWidgetSize()
    const [hover, setHover] = useCardState<{
        lap: number
        car: number | null
    } | null>("hover", null)
    const canvasRef = useRef<HTMLCanvasElement>(null)

    const series = useMemo(
        () => lapPositions(all, grid, finished),
        [all, grid, finished]
    )
    const leader = useMemo(() => leaderCrossings([...all.values()]), [all])
    const neutral = useMemo(
        () => neutralLaps(periods, leader, lightsOut),
        [periods, leader, lightsOut]
    )
    const led = useMemo(() => lapsLed(series), [series])
    const out = useMemo(() => new Set(retired), [retired])
    const lines = useMemo((): Line[] => {
        const info = new Map(drivers.map((d) => [d.number, d]))
        const shown = series.filter((s) => info.has(s.driver))
        // Teammates told apart within their team only, in session order (the second lighter and dashed): across the
        // whole field compareStyles would lighten every car whose livery is near an earlier one, towards white.
        const teams = new Map<string, DriverInfo[]>()
        for (const s of shown) {
            const d = info.get(s.driver)
            if (d) teams.set(d.team, [...(teams.get(d.team) ?? []), d])
        }
        const styleOf = (d: DriverInfo) => {
            const mates = teams.get(d.team) ?? [d]
            return compareStyles(mates)[mates.indexOf(d)]
        }
        return shown.flatMap((s) => {
            const d = info.get(s.driver)
            return d
                ? [
                      {
                          series: s,
                          info: d,
                          style: styleOf(d),
                          pits: pits.get(s.driver) ?? [],
                          out: out.has(s.driver)
                      }
                  ]
                : []
        })
    }, [series, drivers, pits, out])
    const acronym = useMemo(
        () => new Map(drivers.map((d) => [d.number, d.acronym])),
        [drivers]
    )

    const completed = leader.length - 1
    const win = useLapWindow(Math.max(totalLaps, completed, 1))
    const w = size.width - PAD_X
    const h = size.height - PAD_Y - HEAD_H
    const layout = useMemo((): Layout => {
        const places = Math.max(
            lines.length,
            ...lines.flatMap((l) =>
                l.series.positions.filter((p): p is number => p != null)
            ),
            2
        )
        const from = win.from - 1
        return {
            w,
            h,
            plotW: Math.max(w - 2 * SIDE, 1),
            plotBottom: h - BOTTOM,
            from,
            laps: win.to - from,
            places
        }
    }, [w, h, lines, win])
    const lo = layout.from
    const lastShown = Math.min(lo + layout.laps, completed)
    const left = useMemo(
        () => (lastShown >= lo ? orderAt(series, lo, out) : []),
        [series, lo, lastShown, out]
    )
    const right = useMemo(
        () =>
            completed > 0 && lastShown > lo
                ? orderAt(series, lastShown, out)
                : [],
        [series, lo, lastShown, completed, out]
    )
    const bright = useMemo(
        () =>
            new Set(
                hover?.car != null
                    ? [hover.car]
                    : selected.filter((n) => all.has(n))
            ),
        [hover, selected, all]
    )

    const drawn = useRef<unknown[]>([])
    useFrame(() => {
        const canvas = canvasRef.current
        const now = [
            layout,
            lines,
            neutral,
            bright,
            left,
            right,
            hover?.lap,
            size.pixelRatio
        ]
        if (
            !canvas ||
            w <= 0 ||
            h <= 0 ||
            now.every((v, i) => v === drawn.current[i])
        )
            return
        drawn.current = now
        draw(
            canvas,
            layout,
            lines,
            neutral,
            bright,
            left,
            right,
            hover?.lap ?? null,
            size.pixelRatio
        )
    })

    const pointAt = (e: MouseEvent<HTMLCanvasElement>) => {
        const r = e.currentTarget.getBoundingClientRect()
        if (lastShown < lo) return null
        const lap = Math.min(
            Math.max(lapAt(layout, e.clientX - r.left), lo),
            lastShown
        )
        return {
            lap,
            car: carAt(lines, lap, placeAt(layout, e.clientY - r.top))
        }
    }
    const onKeyDown = (e: KeyboardEvent<HTMLCanvasElement>) => {
        if (lastShown < lo) return
        const step = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0
        if (step) {
            e.preventDefault()
            setHover((h) => {
                const lap = Math.min(
                    Math.max(
                        (h?.lap ?? lastShown + (step < 0 ? 1 : 0)) + step,
                        lo
                    ),
                    lastShown
                )
                return { lap, car: h?.car ?? null }
            })
        } else if (e.key === "Enter" && hover != null)
            seekToLap(Math.max(hover.lap, 1))
        else if (e.key === "Escape") setHover(null)
    }

    const hoverX = hover != null ? xOf(layout, hover.lap) : 0
    const flip = hoverX > layout.w / 2
    const hoverLine =
        hover?.car != null
            ? (lines.find((l) => l.info.number === hover.car) ?? null)
            : null

    return (
        <div className="h-full px-3 pb-2 pt-2 text-sm">
            <div
                className="flex items-center justify-between gap-3"
                style={{ height: HEAD_H }}
            >
                <span className={`${LABEL_CLASS} shrink-0`}>
                    Lap chart
                    {win.zoomed && (
                        <span className="font-normal normal-case tracking-normal text-zinc-400">
                            {" "}
                            · laps {win.from}–{win.to}
                        </span>
                    )}
                </span>
                {led.length > 0 && (
                    <span
                        className="min-w-0 truncate whitespace-nowrap text-[11px] tabular-nums text-zinc-400"
                        title={`Laps led: ${led.map((l) => `${acronym.get(l.driver) ?? `#${l.driver}`} ${l.laps}`).join(", ")}`}
                    >
                        Led{" "}
                        {led.map((l, i) => (
                            <span key={l.driver}>
                                {i > 0 && " · "}
                                <span className="font-semibold text-zinc-200">
                                    {acronym.get(l.driver) ?? `#${l.driver}`}
                                </span>{" "}
                                {l.laps}
                            </span>
                        ))}
                    </span>
                )}
            </div>
            <div className="relative" style={{ width: w, height: h }}>
                <canvas
                    ref={canvasRef}
                    role="img"
                    tabIndex={0}
                    aria-label="Every car's place at the end of each lap, from the grid. Arrow keys pick a lap, Enter watches it."
                    // touch-pan-y: a finger dragged along the chart scrubs the readout, while an up-and-down drag scrolls the page.
                    className="block cursor-crosshair touch-pan-y rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-300"
                    style={{ width: w, height: h }}
                    onPointerMove={(e) => setHover(pointAt(e))}
                    // A finger leaves as soon as it lifts: the readout it stopped on stays until the next touch or a tap elsewhere.
                    onPointerLeave={(e) =>
                        e.pointerType !== "touch" && setHover(null)
                    }
                    onBlur={() => setHover(null)}
                    onKeyDown={onKeyDown}
                    onClick={(e) => {
                        const at = pointAt(e)
                        if (at) seekToLap(Math.max(at.lap, 1))
                    }}
                />
                {completed === 0 && (
                    <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-xs text-zinc-400">
                        Places show from the end of lap 1.
                    </div>
                )}
                {completed > 0 && lastShown < lo && (
                    <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-xs text-zinc-400">
                        Laps {win.from}–{win.to} haven't been run yet.
                    </div>
                )}
                {hover != null && (
                    <div
                        className="pointer-events-none absolute top-0"
                        style={{ left: hoverX + (flip ? -10 : 10) }}
                    >
                        <Tooltip
                            lap={hover.lap}
                            line={hoverLine}
                            neutral={neutral[hover.lap] ?? null}
                            left={flip}
                        />
                    </div>
                )}
            </div>
        </div>
    )
}

export default defineWidget({
    id: "lap-chart",
    name: "Lap chart",
    group: "analysis",
    description:
        "Every car's place at the end of each lap, from the grid, with pit stops, safety car laps and laps led. Click a lap to watch it.",
    version: "1.0.0",
    // Fills its column: the title line and a place for each car at a readable spacing.
    height: { min: PAD_Y + HEAD_H + 260 },
    width: { min: 28, default: 50, max: 100 },
    sessions: ["race"],
    settings: {},
    Component: LapChart
})
