import { memo, useMemo } from "react"
import {
    type DriverInfo,
    type DriverLimits,
    type DriverState,
    defineWidget,
    Flash,
    gap,
    Icon,
    LABEL_CLASS,
    type Lap,
    type LiveQualiSegment,
    lapTime,
    MiniSectors,
    type PitStop,
    type QualiPhase,
    type SessionKind,
    sectorTime,
    segmentBest,
    shortTeam,
    standingOf,
    TAP_CLASS,
    TyreBadge,
    teamColor,
    useAllLaps,
    useAllPitStops,
    useBestSectors,
    useCoarsePointer,
    useDriver,
    useDrivers,
    useFastestLap,
    useLaps,
    useLeaderLap,
    useNeutralPeriods,
    useQualiPhase,
    useRunningOrder,
    useSelection,
    useSessionInfo,
    useSettings,
    useTime,
    useTimingLap,
    useTrackLimits,
    useWidgetSize
} from "widget-kit"
import { type Crossings, intervalTrend, type Span, TREND_MIN } from "./trend"

type GapMode = "leader" | "interval"
type Settings = { gapMode: GapMode }

const ROW_H = 30
/** The selection line (h-7 and its hairline) and the column titles (py-1.5, a line of 11 px label, the hairline). */
const HEAD_H = 28 + 1 + 12 + (11 * 20) / 14 + 1
/** Races' gap column also holds the caret for the interval's trend. */
const COLS = "grid-cols-[22px_22px_minmax(0,1fr)_66px_58px_40px_20px]"
/** With the last lap's sectors and the best lap, once the widget is WIDE px or more. */
const WIDE_COLS =
    "grid-cols-[22px_22px_minmax(0,1fr)_66px_46px_46px_46px_58px_58px_40px_20px]"
/** Practice: no grid to gain places from, and laps run (or a PIT tag) in the last column. */
const PRACTICE_COLS = "grid-cols-[28px_minmax(0,1fr)_60px_58px_40px_28px]"
const PRACTICE_WIDE_COLS =
    "grid-cols-[28px_minmax(0,1fr)_60px_46px_46px_46px_58px_58px_40px_28px]"
/** Live qualifying: the best lap in the segment and the gap by it, then (wide) the last lap; the last column says who's out. */
const QUALI_COLS = "grid-cols-[28px_minmax(0,1fr)_60px_52px_40px_28px]"
const QUALI_WIDE_COLS =
    "grid-cols-[28px_minmax(0,1fr)_60px_52px_46px_46px_46px_58px_40px_28px]"
const colsOf = (wide: boolean, kind: SessionKind) =>
    kind === "qualifying"
        ? wide
            ? QUALI_WIDE_COLS
            : QUALI_COLS
        : kind === "practice"
          ? wide
              ? PRACTICE_WIDE_COLS
              : PRACTICE_COLS
          : wide
            ? WIDE_COLS
            : COLS
const WIDE = 590
// Left gutter for the selection check.
const PAD = "pl-5 pr-2"
/** What the columns other than the driver's take (fixed widths, gap-1 between, PAD), so the driver's gets the rest. */
const FIXED_W = 22 + 22 + 66 + 58 + 40 + 20 + 6 * 4 + 20 + 8
const WIDE_FIXED_W = FIXED_W + 3 * 46 + 58 + 4 * 4
/** Practice's (no grid-change column, a wider last one). */
const PRACTICE_FIXED_W = 28 + 60 + 58 + 40 + 28 + 5 * 4 + 20 + 8
const QUALI_FIXED_W = 28 + 60 + 52 + 40 + 28 + 5 * 4 + 20 + 8
const QUALI_WIDE_FIXED_W = QUALI_FIXED_W + 3 * 46 + 58 + 4 * 4
const fixedWidthOf = (wide: boolean, kind: SessionKind) =>
    kind === "qualifying"
        ? wide
            ? QUALI_WIDE_FIXED_W
            : QUALI_FIXED_W
        : (kind === "practice" ? PRACTICE_FIXED_W : FIXED_W) +
          (wide ? WIDE_FIXED_W - FIXED_W : 0)

/**
 * How wide the driver column must be to show every team's name whole after the stripe and acronym (gap-2
 * apart), in the page's font: names are shown in full or not at all ("Merc…" says less than the stripe).
 */
function teamNamesWidth(drivers: readonly DriverInfo[]): number {
    const ctx =
        typeof document === "undefined"
            ? null
            : document.createElement("canvas").getContext("2d")
    if (!ctx) return Infinity
    const family = getComputedStyle(document.body).fontFamily
    const widest = (font: string, texts: string[]) => {
        ctx.font = font
        return Math.max(0, ...texts.map((t) => ctx.measureText(t).width))
    }
    // The acronym is text-sm bold with tracking-wide (0.025em), the team text-xs.
    const acronym =
        widest(
            `700 14px ${family}`,
            drivers.map((d) => d.acronym)
        ) +
        3 * 0.35
    return (
        4 +
        8 +
        acronym +
        8 +
        widest(
            `12px ${family}`,
            drivers.map((d) => shortTeam(d.team))
        ) +
        1
    )
}

/** What a row shows of its driver: it re-renders only when one of these changes. */
interface RowData {
    status: DriverState["status"]
    position: number | null
    gridPosition: number | null
    gap: number | string | null
    lastLap: Lap | null
    bestLap: number | null
    personalBest: boolean
    compound: string | null
    tyreAge: number | null
    pitStops: number
}

const rowData =
    (mode: GapMode) =>
    (s: DriverState): RowData => ({
        status: s.status,
        position: s.position,
        gridPosition: s.gridPosition,
        gap: mode === "leader" ? s.gapToLeader : s.interval,
        lastLap: s.lastLap,
        bestLap: s.bestLap?.duration ?? null,
        personalBest: s.lastLap != null && s.bestLap === s.lastLap,
        compound: s.compound,
        tyreAge: s.tyreAge,
        pitStops: s.pitStops
    })

/** Practice: the gap to the fastest (or the car ahead) by best lap, also from the garage; P1 shows its time. */
function PracticeGapCell({ s }: { s: RowData }) {
    if (s.status === "OUT")
        return <span className="font-semibold text-red-400">OUT</span>
    if (s.position === 1 && s.bestLap != null)
        return (
            <span className="tabular-nums text-zinc-200">
                {lapTime(s.bestLap)}
            </span>
        )
    return <span className="tabular-nums">{gap(s.gap)}</span>
}

/** How the interval to the car ahead went over the last lap, as the caret after the gap shows it. */
interface RowTrend {
    /** Seconds: negative is closing. */
    delta: number
    /** The car ahead's acronym. */
    ahead: string
}

/**
 * The caret after a race gap: up (towards the car ahead, and green like a place gained) when the car closed on it
 * over its last lap, down and red when it lost time; nothing when it held station within TREND_MIN.
 */
function TrendCaret({ trend }: { trend: RowTrend }) {
    const closing = trend.delta < 0
    const by = Math.abs(trend.delta).toFixed(1)
    const label = closing
        ? `Closing on ${trend.ahead}: ${by} s faster on the last lap`
        : `Losing ${by} s to ${trend.ahead} on the last lap`
    return (
        <span
            title={label}
            className={closing ? "text-emerald-400" : "text-red-400"}
        >
            <Icon
                name={closing ? "chevron-up" : "chevron-down"}
                size={10}
                label={label}
                className="[&_path]:[stroke-width:2.5]"
            />
        </span>
    )
}

function GapCell({
    s,
    mode,
    trend
}: {
    s: RowData
    mode: GapMode
    trend: RowTrend | null
}) {
    // Only the leader's row reads the leader's lap (whether the race has started).
    const started = useLeaderLap((l) => l > 0)
    if (s.status === "OUT")
        return <span className="font-semibold text-red-400">OUT</span>
    if (s.status === "PIT")
        return (
            <span className="rounded bg-zinc-200 px-1.5 text-[11px] font-bold text-zinc-900">
                PIT
            </span>
        )
    const flag =
        s.status === "FINISHED" ? (
            <Icon
                name="chequered"
                size={12}
                label="Finished"
                className="mr-1 inline-block align-[-2px]"
            />
        ) : null
    if (s.position === 1)
        return (
            <span className="text-zinc-400">
                {flag}
                {started ? (mode === "leader" ? "Leader" : "Interval") : ""}
            </span>
        )
    return (
        <span className="flex items-center justify-between gap-0.5">
            <span className="tabular-nums">
                {flag}
                {gap(s.gap)}
            </span>
            {trend && s.status === "RUNNING" && <TrendCaret trend={trend} />}
        </span>
    )
}

function LastLapCell({ n, s }: { n: number; s: RowData }) {
    const l = s.lastLap
    // The fastest lap's number if it's this driver's, so other rows ignore a new fastest lap.
    const fastest = useFastestLap((f) => (f?.driver === n ? f.lap : null))
    // Practice: race control has deleted it by now (track limits).
    const deleted = useTime((t) => l?.deleted != null && t >= l.deleted.t)
    if (!l) return <span className="text-zinc-600">—</span>
    if (deleted && l.deleted) {
        return (
            <Flash
                value={l.lap}
                className="tabular-nums text-zinc-400 line-through"
                title={`Deleted: ${l.deleted.reason.toLowerCase()}`}
            >
                {lapTime(l.duration)}
            </Flash>
        )
    }
    const color =
        fastest === l.lap
            ? "text-fuchsia-400"
            : s.personalBest
              ? "text-emerald-400"
              : "text-zinc-300"
    return (
        <Flash value={l.lap} className={`tabular-nums ${color}`}>
            {lapTime(l.duration)}
        </Flash>
    )
}

/** Practice's last column: laps run so far, or PIT while the car is in the pits (the garage, mostly). */
function LapsCell({ n, s }: { n: number; s: RowData }) {
    const laps = useLaps(n, (l) => l.length)
    if (s.status === "PIT")
        return (
            <span className="rounded bg-zinc-200 px-1 text-[10px] font-bold text-zinc-900">
                PIT
            </span>
        )
    return (
        <span className="text-right text-xs tabular-nums text-zinc-400">
            {laps}
        </span>
    )
}

/**
 * Live qualifying: the driver's best lap in the segment they're in (or went out in), the time that places them. The
 * segment's fastest is purple.
 */
function QualiBestCell({
    n,
    s,
    segment
}: {
    n: number
    s: RowData
    segment: LiveQualiSegment | null
}) {
    const laps = useLaps(n)
    const best = useTime((t) =>
        segment ? segmentBest(laps, segment, t) : null
    )
    if (best == null) return <span className="text-xs text-zinc-600">—</span>
    return (
        <Flash
            value={best}
            className={`text-xs tabular-nums ${s.position === 1 ? "text-fuchsia-400" : "text-zinc-200"}`}
        >
            {lapTime(best)}
        </Flash>
    )
}

/** Live qualifying's last column: the segment a car went out in, else (as practice) laps run or PIT. */
function QualiStatusCell({
    n,
    s,
    out
}: {
    n: number
    s: RowData
    out: LiveQualiSegment | null
}) {
    if (out) {
        return (
            <span
                className="text-[11px] font-semibold text-zinc-400"
                title={`Knocked out in ${out.name}`}
            >
                {out.name}
            </span>
        )
    }
    return <LapsCell n={n} s={s} />
}

/** Seconds: sector times equal to a best within this are that best. */
const EPS = 1e-6

/** Each sector's fastest time among a driver's laps so far. */
const personalBestSectors = (laps: readonly Lap[]) =>
    [0, 1, 2].map((k) =>
        laps.reduce<number | null>((min, l) => {
            const v = l.sectors[k]
            return v != null && (min == null || v < min) ? v : min
        }, null)
    )

/**
 * The sector times of the lap being driven (for a few seconds after the line, the one just driven): a dash until the
 * car crosses the sector's end, so they reset at the line and fill in as the lap goes; purple for the fastest by
 * anyone so far, green for the driver's own best, lit up as each comes in. Under each, its mini-sectors as they're
 * passed.
 */
function SectorCells({ n }: { n: number }) {
    const shown = useTimingLap(n)
    const overall = useBestSectors()
    const own = useLaps(n, personalBestSectors)
    return (
        <>
            {[0, 1, 2].map((k) => {
                const v = shown?.sectors[k] ?? null
                const best = overall[k]
                const mine = own[k]
                const color =
                    v == null
                        ? "text-zinc-600"
                        : best == null || v <= best + EPS
                          ? "text-fuchsia-400"
                          : mine == null || v <= mine + EPS
                            ? "text-emerald-400"
                            : "text-zinc-300"
                return (
                    <span key={k} className="flex min-w-0 flex-col gap-0.5">
                        <Flash
                            value={v}
                            className={`self-start text-xs leading-4 tabular-nums ${color}`}
                        >
                            {v == null ? "—" : sectorTime(v)}
                        </Flash>
                        <MiniSectors
                            codes={shown?.segments[k] ?? []}
                            className="h-[3px]"
                        />
                    </span>
                )
            })}
        </>
    )
}

function BestLapCell({ n, s }: { n: number; s: RowData }) {
    const fastest = useFastestLap((f) => (f?.driver === n ? f.duration : null))
    if (s.bestLap == null)
        return <span className="text-xs text-zinc-600">—</span>
    return (
        <Flash
            value={s.bestLap}
            className={`text-xs tabular-nums ${fastest === s.bestLap ? "text-fuchsia-400" : "text-zinc-300"}`}
        >
            {lapTime(s.bestLap)}
        </Flash>
    )
}

function Change({ s }: { s: RowData }) {
    if (s.gridPosition == null || s.position == null || s.status === "OUT")
        return null
    const delta = s.gridPosition - s.position
    if (delta === 0) return <span className="text-zinc-600">–</span>
    return delta > 0 ? (
        <span className="text-emerald-400">▲{delta}</span>
    ) : (
        <span className="text-red-400">▼{-delta}</span>
    )
}

/** What the track limits tag needs (gets past its width check: TAG_W). */
const TAG_W = 34 + 8
/** Races: the black and white flag comes after this many deleted lap times. */
const FLAG_AT = 3

/** A driver gets the tag with a lap time deleted, the black and white flag or the stewards' word on it. */
const tagged = (d: DriverLimits | undefined): d is DriverLimits =>
    d != null && (d.count > 0 || d.blackWhite != null || d.stewards.length > 0)

/** Lap times deleted for track limits so far: "TL 2", white once the black and white flag is out, amber when it's due. */
function LimitsTag({ n, race }: { n: number; race: boolean }) {
    const l = useTrackLimits((all) => {
        const d = all.get(n)
        return tagged(d)
            ? {
                  count: d.count,
                  turns: [
                      ...new Set(
                          d.strikes.flatMap((s) =>
                              !s.reinstated && s.turn != null ? [s.turn] : []
                          )
                      )
                  ],
                  flag: d.blackWhite != null,
                  stewards: d.stewards.at(-1)?.label ?? null
              }
            : null
    })
    if (!l) return null
    const due = race && !l.flag && l.count >= FLAG_AT
    const title = [
        `Track limits: ${l.count} lap ${l.count === 1 ? "time" : "times"} deleted${l.turns.length ? ` (${l.turns.length === 1 ? "turn" : "turns"} ${l.turns.join(", ")})` : ""}`,
        l.flag && "black and white flag shown",
        l.stewards && `stewards: ${l.stewards.toLowerCase()}`
    ]
        .filter(Boolean)
        .join("; ")
    return (
        <span
            className={`shrink-0 rounded px-1 text-[10px] font-bold leading-4 tabular-nums ${
                l.flag
                    ? "bg-zinc-200 text-black"
                    : due
                      ? "bg-zinc-800 text-amber-400"
                      : "bg-zinc-800 text-zinc-300"
            }`}
            title={title}
        >
            TL {l.count}
        </span>
    )
}

/** Whether a driver has a track limits tag in the tower (to make room for it). */
const hasTag = (n: number) => (all: ReadonlyMap<number, DriverLimits>) =>
    tagged(all.get(n))

/** Every car's completed laps as line-crossing times (changes only when a lap is completed). */
const allCrossings = (
    laps: ReadonlyMap<number, readonly Lap[]>
): ReadonlyMap<number, Crossings> =>
    new Map(
        [...laps].map(([n, ls]) => {
            const last = ls.reduce((m, l) => Math.max(m, l.lap), 0)
            const c: (number | null)[] = Array.from(
                { length: last + 1 },
                () => null
            )
            for (const l of ls) c[l.lap] = l.end
            return [n, c]
        })
    )

/** Each car's pit stops so far, entry to exit. */
const pitSpans = (
    pits: ReadonlyMap<number, readonly PitStop[]>
): ReadonlyMap<number, Span[]> =>
    new Map(
        [...pits].map(([n, ps]) => [
            n,
            ps.map((p) => ({ start: p.entry, end: p.exit }))
        ])
    )

/** One driver's row: memoised, and subscribed to just that driver's fields. */
const Row = memo(function Row({
    d,
    index,
    mode,
    wide,
    team,
    kind,
    phase,
    trendDelta,
    trendAhead,
    isSelected,
    isFocused,
    onToggle
}: {
    d: DriverInfo
    index: number
    mode: GapMode
    wide: boolean
    /** Show the team's name after the acronym: without a track limits tag, and with one. */
    team: { bare: boolean; tagged: boolean }
    kind: SessionKind
    /** Live qualifying at t (its clock left out: rows don't show it). */
    phase: QualiPhase | null
    /** Races: the interval's change over the last lap (seconds, negative closing) and the car ahead, if it moved. */
    trendDelta: number | null
    trendAhead: string | null
    isSelected: boolean
    isFocused: boolean
    onToggle: (n: number) => void
}) {
    const select = useMemo(() => rowData(mode), [mode])
    const s = useDriver(d.number, select)
    const pickTag = useMemo(() => hasTag(d.number), [d.number])
    const withTag = useTrackLimits(pickTag)
    if (!s) return null
    const practice = kind === "practice"
    const quali = kind === "qualifying"
    const standing = quali ? standingOf(phase, s.position) : null
    const out = standing && "out" in standing ? standing.out : null
    const danger = standing != null && "danger" in standing
    return (
        <button
            type="button"
            onClick={() => onToggle(d.number)}
            aria-pressed={isSelected}
            title={
                isSelected
                    ? `Remove ${d.acronym} from the selection`
                    : `Add ${d.acronym} to the selection (filters the track map)`
            }
            className={`group absolute inset-x-0 grid ${colsOf(wide, kind)} items-center gap-1 ${PAD} text-left transition-transform duration-500 ease-out focus-visible:-outline-offset-2 ${
                isFocused
                    ? "bg-zinc-800"
                    : isSelected
                      ? "bg-zinc-800/50 hover:bg-zinc-800/70"
                      : "hover:bg-zinc-900"
            } ${s.status === "OUT" || out ? "opacity-50" : ""}`}
            style={{
                height: ROW_H,
                transform: `translateY(${index * ROW_H}px)`
            }}
        >
            <span
                aria-hidden
                className={`absolute left-1.5 top-1/2 flex h-3 w-3 -translate-y-1/2 items-center justify-center rounded-full ${
                    // Touch screens have no hover: the empty check shows on every row, so a tap has a visible target.
                    isSelected
                        ? "bg-zinc-100 text-zinc-900"
                        : "border border-zinc-600 opacity-0 group-hover:opacity-100 pointer-coarse:opacity-100"
                } ${isSelected && isFocused ? "ring-2 ring-zinc-100/40" : ""}`}
            >
                {isSelected && (
                    <Icon
                        name="check"
                        size={9}
                        className="[&_path]:[stroke-width:2.5]"
                    />
                )}
            </span>
            <span
                className={`font-bold tabular-nums ${danger ? "text-red-400" : ""}`}
                title={
                    danger
                        ? "In the drop zone: out if the segment ended now"
                        : undefined
                }
            >
                {s.status === "OUT" ? "–" : s.position}
            </span>
            {!practice && !quali && (
                <span className="text-[10px]">
                    <Change s={s} />
                </span>
            )}
            <span className="flex min-w-0 items-center gap-2">
                <span
                    className="h-4 w-1 shrink-0 rounded-sm"
                    style={{ background: teamColor(d.teamColour) }}
                />
                <span className="font-bold tracking-wide">{d.acronym}</span>
                {(withTag ? team.tagged : team.bare) && (
                    <span
                        className="whitespace-nowrap text-xs text-zinc-400"
                        title={d.team}
                    >
                        {shortTeam(d.team)}
                    </span>
                )}
                <LimitsTag n={d.number} race={!practice && !quali} />
            </span>
            {quali ? (
                <>
                    <QualiBestCell
                        n={d.number}
                        s={s}
                        segment={out ?? phase?.segment ?? null}
                    />
                    <span className="text-xs tabular-nums">
                        {s.position === 1 ? "" : gap(s.gap)}
                    </span>
                    {wide && <SectorCells n={d.number} />}
                    {wide && (
                        <span className="text-xs">
                            <LastLapCell n={d.number} s={s} />
                        </span>
                    )}
                </>
            ) : (
                <>
                    <span className="text-xs">
                        {practice ? (
                            <PracticeGapCell s={s} />
                        ) : (
                            <GapCell
                                s={s}
                                mode={mode}
                                trend={
                                    trendDelta != null && trendAhead != null
                                        ? {
                                              delta: trendDelta,
                                              ahead: trendAhead
                                          }
                                        : null
                                }
                            />
                        )}
                    </span>
                    {wide && <SectorCells n={d.number} />}
                    <span className="text-xs">
                        <LastLapCell n={d.number} s={s} />
                    </span>
                    {wide && <BestLapCell n={d.number} s={s} />}
                </>
            )}
            <TyreBadge compound={s.compound} age={s.tyreAge} />
            {quali ? (
                <span className="flex justify-end">
                    <QualiStatusCell n={d.number} s={s} out={out} />
                </span>
            ) : practice ? (
                <span className="flex justify-end">
                    <LapsCell n={d.number} s={s} />
                </span>
            ) : (
                <span className="text-right text-xs tabular-nums text-zinc-400">
                    {s.pitStops}
                </span>
            )}
        </button>
    )
})

function TimingTower() {
    const drivers = useDrivers()
    const order = useRunningOrder()
    const { selected, focused, toggle, clear } = useSelection()
    const [{ gapMode }, update] = useSettings<Settings>()
    const rowIndex = useMemo(
        () => new Map(order.map((n, i) => [n, i])),
        [order]
    )
    const { width } = useWidgetSize()
    const wide = width >= WIDE
    const coarse = useCoarsePointer()
    // Practice: ordered by best lap, gaps by best lap, and laps run instead of pit stops. Live qualifying: by best lap
    // in the segment, with its cut.
    const kind = useSessionInfo((i) => i.kind)
    const practice = kind === "practice"
    const quali = kind === "qualifying"
    // (Without its clock, so the rows aren't re-rendered as it counts down.)
    const phase = useQualiPhase((p) =>
        p ? { ...p, left: 0, red: false } : null
    )
    const cut =
        quali &&
        phase?.segment?.advance != null &&
        phase.field > phase.segment.advance
            ? phase.segment.advance
            : null
    const teamRoom = useMemo(() => teamNamesWidth(drivers), [drivers])
    const crossings = useAllLaps(allCrossings)
    const pits = useAllPitStops(pitSpans)
    const neutral = useNeutralPeriods()
    // Races: each car's interval trend over its last lap, against the car ahead of it now.
    const trends = useMemo(() => {
        const out = new Map<number, RowTrend>()
        if (kind !== "race") return out
        const acronym = new Map(drivers.map((d) => [d.number, d.acronym]))
        order.forEach((n, i) => {
            if (i === 0) return
            const t = intervalTrend(crossings, n, pits, neutral, order[i - 1])
            if (t && Math.abs(t.delta) >= TREND_MIN)
                out.set(n, {
                    delta: t.delta,
                    ahead: acronym.get(t.ahead) ?? `#${t.ahead}`
                })
        })
        return out
    }, [kind, drivers, order, crossings, pits, neutral])
    const room = width - fixedWidthOf(wide, kind)
    const teams = useMemo(
        () => ({ bare: room >= teamRoom, tagged: room >= teamRoom + TAG_W }),
        [room, teamRoom]
    )

    return (
        <div className="flex h-full flex-col text-sm">
            <div className="flex h-7 shrink-0 items-center border-b border-zinc-800 px-2 text-[11px]">
                {selected.length > 0 ? (
                    <span className="text-zinc-400">
                        Showing{" "}
                        <span className="font-semibold tabular-nums text-zinc-100">
                            {selected.length}
                        </span>{" "}
                        on track ·{" "}
                        <button
                            type="button"
                            onClick={clear}
                            className={`${TAP_CLASS} rounded px-1 font-semibold text-zinc-200 underline-offset-2 hover:bg-zinc-800 hover:text-white hover:underline`}
                            title="Show every car on the track map (esc)"
                        >
                            Show all
                        </button>
                    </span>
                ) : (
                    <span className="text-zinc-400">
                        {coarse ? "Tap" : "Click"} drivers to show only them on
                        the track map
                    </span>
                )}
            </div>
            <div
                className={`grid shrink-0 ${colsOf(wide, kind)} items-center gap-1 border-b border-zinc-800 ${PAD} py-1.5 ${LABEL_CLASS}`}
            >
                <span>Pos</span>
                {!practice && !quali && <span />}
                <span>Driver</span>
                {quali && (
                    <span
                        title={`Best lap in ${phase?.segment?.name ?? "the segment"}`}
                    >
                        {phase?.segment?.name ?? "Best"}
                    </span>
                )}
                <button
                    type="button"
                    onClick={() =>
                        update({
                            gapMode:
                                gapMode === "leader" ? "interval" : "leader"
                        })
                    }
                    className={`${TAP_CLASS} flex items-center gap-1 rounded-sm text-left uppercase hover:text-zinc-100`}
                    title={
                        practice || quali
                            ? gapMode === "leader"
                                ? "Gap to the fastest by best lap: switch to the car ahead"
                                : "Gap to the car ahead by best lap: switch to the fastest"
                            : gapMode === "leader"
                              ? "Gap to the leader: switch to the interval to the car ahead"
                              : "Interval to the car ahead: switch to the gap to the leader"
                    }
                >
                    {gapMode === "leader" ? "Gap" : "Int"}
                    <Icon name="swap" size={11} />
                </button>
                {wide && (
                    <>
                        <span title="Sector 1 of the lap being driven, and its mini-sectors">
                            S1
                        </span>
                        <span title="Sector 2 of the lap being driven, and its mini-sectors">
                            S2
                        </span>
                        <span title="Sector 3 of the lap being driven, and its mini-sectors">
                            S3
                        </span>
                    </>
                )}
                {(!quali || wide) && <span>Last</span>}
                {wide && !quali && <span title="Best lap so far">Best</span>}
                <span>Tyre</span>
                {practice || quali ? (
                    <span className="text-right" title="Laps run">
                        Laps
                    </span>
                ) : (
                    <span className="text-right">Pit</span>
                )}
            </div>
            <div className="relative min-h-0 flex-1 overflow-y-auto">
                <div
                    className="relative"
                    style={{ height: order.length * ROW_H }}
                >
                    {cut != null && (
                        // The cut: the cars under it go out at the end of the segment.
                        <div
                            aria-hidden
                            className="pointer-events-none absolute inset-x-0 z-10 border-t border-dashed border-red-500/70"
                            style={{ top: cut * ROW_H }}
                        >
                            <span className="absolute right-1 top-0 -translate-y-1/2 bg-zinc-950 px-1 text-[9px] font-bold uppercase tracking-wider text-red-400">
                                {phase?.settled ? "Out" : "Drop zone"}
                            </span>
                        </div>
                    )}
                    {drivers.map((d) => (
                        <Row
                            key={d.number}
                            d={d}
                            index={rowIndex.get(d.number) ?? 0}
                            mode={gapMode}
                            wide={wide}
                            team={teams}
                            kind={kind}
                            phase={phase}
                            trendDelta={trends.get(d.number)?.delta ?? null}
                            trendAhead={trends.get(d.number)?.ahead ?? null}
                            isSelected={selected.includes(d.number)}
                            isFocused={focused === d.number}
                            onToggle={toggle}
                        />
                    ))}
                </div>
            </div>
        </div>
    )
}

export default defineWidget({
    id: "timing-tower",
    name: "Timing tower",
    group: "session",
    description:
        "Every driver's position, gap, sectors and mini-sectors of the lap being driven, last and best lap, tyre and pit stops. In practice, by best lap; in live qualifying, by best lap in the segment, with its cut.",
    version: "1.0.0",
    // Fills its column; the rows scroll inside when they don't all fit.
    height: { min: HEAD_H + 5 * ROW_H },
    width: { min: 22, default: 35, max: 45 },
    sessions: ["race", "practice", "qualifying"],
    settings: { gapMode: "leader" as GapMode },
    fields: {
        gapMode: {
            kind: "choice",
            label: "Gap",
            options: [
                { value: "leader", label: "Gap to leader" },
                { value: "interval", label: "Interval" }
            ]
        }
    },
    Component: TimingTower
})
