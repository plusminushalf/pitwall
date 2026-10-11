import { memo, useMemo } from "react"
import {
    type DriverInfo,
    type DriverState,
    defineWidget,
    gap,
    Icon,
    LABEL_CLASS,
    type Lap,
    type LapInProgress,
    type LapTrace,
    type LiveLap,
    type LiveQualiSegment,
    lapTime,
    type QualiPhase,
    type SessionKind,
    sectorTime,
    segmentBest,
    standingOf,
    TAP_CLASS,
    TyreBadge,
    teamColor,
    timeAtDistance,
    useBestSectors,
    useCoarsePointer,
    useDriver,
    useDrivers,
    useFastestLap,
    useLapGeometry,
    useLapInProgress,
    useLaps,
    useLapTrace,
    useLiveLap,
    useQualiPhase,
    useRunningOrder,
    useSelection,
    useSessionInfo,
    useTime,
    useWidgetSize
} from "widget-kit"

const ROW_H = 34
/** The selection line (h-7 and its hairline) and the column titles (py-1.5, a line of 11 px label, the hairline). */
const HEAD_H = 28 + 1 + 12 + (11 * 20) / 14 + 1
const PAD = "pl-5 pr-2"

/**
 * Columns by width: all of them; without the last lap and laps run; and (narrowest) the sectors as their mini-sectors
 * only. Pos, driver, best, gap, S1–S3, [last], now, tyre, [laps].
 */
const FULL = 700
const MEDIUM = 600
const colsOf = (width: number) =>
    width >= FULL
        ? "grid-cols-[22px_minmax(48px,1fr)_62px_52px_repeat(3,72px)_62px_96px_40px_24px]"
        : width >= MEDIUM
          ? "grid-cols-[22px_minmax(48px,1fr)_62px_52px_repeat(3,72px)_96px_40px]"
          : "grid-cols-[22px_minmax(48px,1fr)_62px_52px_repeat(3,44px)_96px_40px]"

/** A push lap: not an out-lap, and within this share (plus the slack) of the fastest lap's time to the same point. */
const PUSH_RATIO = 1.05
const PUSH_SLACK_MS = 1_000
/** Too early in a lap to tell a push lap from a cool-down lap (metres). */
const PUSH_FROM_M = 300

const EPS = 1e-6
// Mini-sector status codes: 2048 yellow, 2049 green, 2051 purple, 2064 pit lane.
const SEGMENT_COLOR: Record<number, string> = {
    2048: "#eab308",
    2049: "#10b981",
    2051: "#d946ef",
    2064: "#3b82f6"
}
const NOT_YET = "#3f3f46"

/** What a row shows of its driver: it re-renders only when one of these changes. */
interface RowData {
    status: DriverState["status"]
    position: number | null
    gap: number | string | null
    lastLap: Lap | null
    bestLap: number | null
    personalBest: boolean
    compound: string | null
    tyreAge: number | null
}

const rowData = (s: DriverState): RowData => ({
    status: s.status,
    position: s.position,
    gap: s.gapToLeader,
    lastLap: s.lastLap,
    bestLap: s.bestLap?.duration ?? null,
    personalBest: s.lastLap != null && s.bestLap === s.lastLap,
    compound: s.compound,
    tyreAge: s.tyreAge
})

/** Each sector's fastest time among a driver's laps so far. */
const personalBestSectors = (laps: readonly Lap[]) =>
    [0, 1, 2].map((k) =>
        laps.reduce<number>((min, l) => {
            const v = l.sectors[k]
            return v != null && v < min ? v : min
        }, Infinity)
    )

/** What the sector cells show: a lap's sector times and mini-sectors (null: not reached). */
type Shown = Pick<LapInProgress, "sectors" | "segments">

const shownOf = (l: Lap): Shown => ({
    sectors: l.sectors,
    segments: l.segments
})

/**
 * The lap the sector cells show: the one being driven once its first mini-sector is in, the one before it until then
 * (and while the car is in the garage), so a lap's sectors stay on screen as it's crossing the line.
 */
function useShownLap(n: number): Shown | null {
    const current = useLapInProgress(n, (l) =>
        l.segments.some((s) => s.some((c) => c != null)) ||
        l.sectors.some((s) => s != null)
            ? { sectors: l.sectors, segments: l.segments }
            : null
    )
    const previous = useLaps(n, (laps) => {
        const l = laps.at(-1)
        return l ? shownOf(l) : null
    })
    return current ?? previous
}

function MiniSectors({ codes }: { codes: readonly (number | null)[] }) {
    return (
        <span className="flex h-[3px] gap-px">
            {codes.length > 0 ? (
                codes.map((c, i) => (
                    <span
                        // biome-ignore lint/suspicious/noArrayIndexKey: mini-sectors are positions along the sector (their colours repeat): the index is each one's identity
                        key={i}
                        className="flex-1 rounded-[1px]"
                        style={{
                            background:
                                (c != null && SEGMENT_COLOR[c]) || NOT_YET
                        }}
                    />
                ))
            ) : (
                <span className="flex-1 rounded-[1px] bg-zinc-800" />
            )}
        </span>
    )
}

/**
 * The three sectors of the lap being driven (or just driven): the time once crossed, purple for the fastest by
 * anyone, green for the driver's own best; under it the mini-sectors as they're passed.
 */
function SectorCells({ n, times }: { n: number; times: boolean }) {
    const shown = useShownLap(n)
    const overall = useBestSectors()
    const own = useLaps(n, personalBestSectors)
    return (
        <>
            {[0, 1, 2].map((k) => {
                const v = shown?.sectors[k] ?? null
                const color =
                    v == null
                        ? "text-zinc-600"
                        : v <= (overall[k] ?? Infinity) + EPS
                          ? "text-fuchsia-400"
                          : v <= own[k] + EPS
                            ? "text-emerald-400"
                            : "text-zinc-300"
                return (
                    <span key={k} className="flex min-w-0 flex-col gap-1">
                        {times && (
                            <span
                                className={`text-xs leading-4 tabular-nums ${color}`}
                            >
                                {v == null ? "" : sectorTime(v)}
                            </span>
                        )}
                        <MiniSectors codes={shown?.segments[k] ?? []} />
                    </span>
                )
            })}
        </>
    )
}

function LastLapCell({ n, s }: { n: number; s: RowData }) {
    const l = s.lastLap
    const fastest = useFastestLap((f) => (f?.driver === n ? f.lap : null))
    const deleted = useTime((t) => l?.deleted != null && t >= l.deleted.t)
    if (!l) return <span className="text-xs text-zinc-600">—</span>
    if (deleted)
        return (
            <span
                className="text-xs tabular-nums text-zinc-400 line-through"
                title={`Deleted: ${l.deleted?.reason.toLowerCase()}`}
            >
                {lapTime(l.duration)}
            </span>
        )
    const color =
        fastest === l.lap
            ? "text-fuchsia-400"
            : s.personalBest
              ? "text-emerald-400"
              : "text-zinc-300"
    return (
        <span className={`text-xs tabular-nums ${color}`}>
            {lapTime(l.duration)}
        </span>
    )
}

/** Practice: the best lap so far. Live qualifying: the best in the segment the driver is in (or went out in). */
function BestCell({
    n,
    s,
    segment
}: {
    n: number
    s: RowData
    segment: LiveQualiSegment | null
}) {
    const laps = useLaps(n)
    const inSegment = useTime((t) =>
        segment ? segmentBest(laps, segment, t) : null
    )
    const best = segment ? inSegment : s.bestLap
    if (best == null) return <span className="text-xs text-zinc-600">—</span>
    return (
        <span
            className={`text-xs tabular-nums ${s.position === 1 ? "text-fuchsia-400" : "text-zinc-200"}`}
        >
            {lapTime(best)}
        </span>
    )
}

type Now =
    | { kind: "out" }
    | { kind: "early"; elapsed: number }
    | { kind: "push"; delta: number | null; share: number }
    | { kind: "slow" }

/**
 * Where the car is on its lap now: an out lap, on a push lap (with the gap to the fastest lap at the same point and
 * how far round it is) or on a slow lap (cool-down, traffic).
 */
function nowOf(l: LiveLap, ref: LapTrace | null, lapLength: number): Now {
    const distance = l.trace.length
    const elapsed = l.trace.duration
    if (l.pitOut) return { kind: "out" }
    if (distance < PUSH_FROM_M) return { kind: "early", elapsed }
    const refTime = ref ? timeAtDistance(ref, distance) : null
    if (refTime != null && elapsed > PUSH_RATIO * refTime + PUSH_SLACK_MS)
        return { kind: "slow" }
    return {
        kind: "push",
        delta: refTime == null ? null : (elapsed - refTime) / 1000,
        share: Number.isFinite(lapLength)
            ? Math.min(1, distance / lapLength)
            : 0
    }
}

const signed = (s: number) =>
    `${s > 0 ? "+" : s < 0 ? "−" : "±"}${Math.abs(s).toFixed(3)}`

function NowCell({
    n,
    s,
    reference,
    lapLength
}: {
    n: number
    s: RowData
    reference: LapTrace | null
    lapLength: number
}) {
    const now =
        useLiveLap(n, (l) => nowOf(l, reference, lapLength)) ??
        (s.status === "PIT" ? { kind: "pit" as const } : null)
    if (!now) return null
    if (now.kind === "pit")
        return (
            <span className="rounded bg-zinc-800 px-1 text-[10px] font-bold text-zinc-300">
                PIT
            </span>
        )
    if (now.kind === "out")
        return <span className="text-xs text-zinc-400">Out lap</span>
    if (now.kind === "slow")
        return <span className="text-xs text-zinc-500">Slow lap</span>
    if (now.kind === "early")
        return (
            <span className="text-xs tabular-nums text-zinc-400">
                {lapTime(now.elapsed / 1000)}
            </span>
        )
    const { delta } = now
    return (
        <span
            className="flex min-w-0 flex-col gap-1"
            title={
                delta == null
                    ? "On a push lap"
                    : `On a push lap: ${signed(delta)} s to the fastest lap at the same point`
            }
        >
            <span className="flex items-center gap-1.5 text-xs leading-4">
                <span className="rounded bg-zinc-100 px-1 text-[10px] font-bold text-zinc-900">
                    PUSH
                </span>
                {delta != null && (
                    <span
                        className={`tabular-nums ${delta < 0 ? "font-semibold text-fuchsia-400" : "text-zinc-200"}`}
                    >
                        {signed(delta)}
                    </span>
                )}
            </span>
            <span className="relative h-[3px] overflow-hidden rounded-full bg-zinc-800">
                <span
                    className="absolute inset-y-0 left-0 rounded-full bg-zinc-300"
                    style={{ width: `${now.share * 100}%` }}
                />
            </span>
        </span>
    )
}

/** Practice's last column: laps run so far. */
function LapsCell({ n }: { n: number }) {
    const laps = useLaps(n, (l) => l.length)
    return (
        <span className="text-right text-xs tabular-nums text-zinc-400">
            {laps}
        </span>
    )
}

/** One driver's row: memoised, and subscribed to just that driver's fields. */
const Row = memo(function Row({
    d,
    index,
    width,
    kind,
    phase,
    reference,
    lapLength,
    isSelected,
    isFocused,
    onToggle
}: {
    d: DriverInfo
    index: number
    width: number
    kind: SessionKind
    /** Live qualifying at t (its clock left out: rows don't show it). */
    phase: QualiPhase | null
    reference: LapTrace | null
    lapLength: number
    isSelected: boolean
    isFocused: boolean
    onToggle: (n: number) => void
}) {
    const s = useDriver(d.number, rowData)
    // A push lap washes its row, so who's on one reads down the column.
    const pushing =
        useLiveLap(
            d.number,
            (l) => nowOf(l, reference, lapLength).kind === "push"
        ) ?? false
    if (!s) return null
    const standing =
        kind === "qualifying" ? standingOf(phase, s.position) : null
    const out = standing && "out" in standing ? standing.out : null
    const danger = standing != null && "danger" in standing
    const full = width >= FULL
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
            className={`group absolute inset-x-0 grid ${colsOf(width)} items-center gap-1 border-b border-zinc-800/70 ${PAD} text-left transition-transform duration-500 ease-out focus-visible:-outline-offset-2 ${
                isFocused
                    ? "bg-zinc-800"
                    : isSelected
                      ? "bg-zinc-800/50 hover:bg-zinc-800/70"
                      : pushing
                        ? "bg-zinc-100/[0.05] hover:bg-zinc-900"
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
                        : out
                          ? `Knocked out in ${out.name}`
                          : undefined
                }
            >
                {s.status === "OUT" ? "–" : s.position}
            </span>
            <span className="flex min-w-0 items-center gap-2">
                <span
                    className="h-4 w-1 shrink-0 rounded-sm"
                    style={{ background: teamColor(d.teamColour) }}
                />
                <span className="font-bold tracking-wide">{d.acronym}</span>
                {out && (
                    <span className="text-[10px] font-semibold text-zinc-400">
                        {out.name}
                    </span>
                )}
            </span>
            <BestCell
                n={d.number}
                s={s}
                segment={
                    kind === "qualifying"
                        ? (out ?? phase?.segment ?? null)
                        : null
                }
            />
            <span className="text-xs tabular-nums">
                {s.position === 1 ? "" : gap(s.gap)}
            </span>
            <SectorCells n={d.number} times={width >= MEDIUM} />
            {full && <LastLapCell n={d.number} s={s} />}
            <NowCell
                n={d.number}
                s={s}
                reference={reference}
                lapLength={lapLength}
            />
            <TyreBadge compound={s.compound} age={s.tyreAge} />
            {full && <LapsCell n={d.number} />}
        </button>
    )
})

/**
 * The timing screen: every car by best lap (in live qualifying, by best lap in the segment, with its cut), the sectors
 * and mini-sectors of the lap being driven as they come in, and who's on a push lap now with their gap to the fastest
 * lap at the same point.
 */
function LiveTiming() {
    const drivers = useDrivers()
    const order = useRunningOrder()
    const { selected, focused, toggle, clear } = useSelection()
    const rowIndex = useMemo(
        () => new Map(order.map((n, i) => [n, i])),
        [order]
    )
    const { width } = useWidgetSize()
    const coarse = useCoarsePointer()
    const kind = useSessionInfo((i) => i.kind)
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
    const fastest = useFastestLap((f) =>
        f ? { driver: f.driver, lap: f.lap } : null
    )
    const reference = useLapTrace(fastest?.driver ?? null, fastest?.lap ?? null)
    const lapLength = useLapGeometry((g) => g.lapLength)
    const full = width >= FULL
    const times = width >= MEDIUM

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
                className={`grid shrink-0 ${colsOf(width)} items-center gap-1 border-b border-zinc-800 ${PAD} py-1.5 ${LABEL_CLASS}`}
            >
                <span>Pos</span>
                <span>Driver</span>
                <span
                    title={
                        quali
                            ? `Best lap in ${phase?.segment?.name ?? "the segment"}`
                            : "Best lap so far"
                    }
                >
                    {quali ? (phase?.segment?.name ?? "Best") : "Best"}
                </span>
                <span title="Gap to the fastest by best lap">Gap</span>
                {[1, 2, 3].map((k) => (
                    <span
                        key={k}
                        title={`Sector ${k} of the lap being driven, and its mini-sectors`}
                    >
                        S{k}
                    </span>
                ))}
                {full && <span title="Last lap">Last</span>}
                <span title="On a push lap now, with the gap to the fastest lap at the same point; an out lap, a slow lap or in the pits">
                    Now
                </span>
                <span>Tyre</span>
                {full && (
                    <span className="text-right" title="Laps run">
                        Laps
                    </span>
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
                            width={full ? FULL : times ? MEDIUM : 0}
                            kind={kind}
                            phase={phase}
                            reference={reference}
                            lapLength={lapLength}
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
    id: "live-timing",
    name: "Live timing",
    group: "session",
    description:
        "The timing screen: every car by best lap (in qualifying, by segment, with its cut), the sectors and mini-sectors of the lap being driven as they come in, and who's on a push lap now with their gap to the fastest lap at the same point.",
    version: "1.0.0",
    // Fills its column; the rows scroll inside when they don't all fit.
    height: { min: HEAD_H + 5 * ROW_H },
    width: { min: 30, default: 47, max: 70 },
    sessions: ["practice", "qualifying"],
    settings: {},
    Component: LiveTiming
})
