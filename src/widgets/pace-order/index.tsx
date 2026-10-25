import { useEffect, useMemo } from "react"
import {
    type DriverInfo,
    defineWidget,
    LABEL_CLASS,
    Label,
    type Lap,
    lapTime,
    shortTeam,
    TAP_CLASS,
    TyreBadge,
    teamColor,
    textOn,
    useAllLaps,
    useAllStints,
    useCardState,
    useDrivers,
    useNeutralPeriods,
    usePlayback,
    useSelection,
    useSessionInfo,
    useSettings,
    useTime,
    useWidgetSize
} from "widget-kit"
import {
    bestLap,
    CLEAR_AIR,
    leftOf,
    type PaceFit,
    type PaceRow,
    type PinnedBest,
    paceRows,
    type RaceRow,
    racePaces,
    raceRows,
    watching,
    withPin
} from "./pace"

type Show = "drivers" | "teams"
/** In a race: rank by race pace (fuel and tyres taken out) or by best lap. Other sessions rank by best lap. */
type By = "pace" | "best"
type Settings = { show: Show; by: By }

/** Rank, driver (or team), tyre, the gap bar, best, gap, ideal, left on the table. */
const COLS =
    "grid grid-cols-[18px_44px_40px_minmax(40px,1fr)_68px_56px_68px_48px] items-center gap-x-2"
const TEAM_COLS =
    "grid grid-cols-[18px_128px_40px_minmax(40px,1fr)_68px_56px_68px_48px] items-center gap-x-2"
/** Under NARROW px the ideal lap's column goes (its time is in the row's tooltip); what's left on the table stays. */
const NARROW_COLS =
    "grid grid-cols-[18px_44px_40px_minmax(24px,1fr)_68px_56px_44px] items-center gap-x-1.5"
const NARROW_TEAM_COLS =
    "grid grid-cols-[18px_96px_40px_minmax(24px,1fr)_68px_56px_44px] items-center gap-x-1.5"
const NARROW = 460
const colsOf = (narrow: boolean, teams: boolean) =>
    narrow ? (teams ? NARROW_TEAM_COLS : NARROW_COLS) : teams ? TEAM_COLS : COLS
/** Race pace: rank, driver (or team), the gap bar, the gap, the median lap as driven, the laps in the fit. */
const RACE_COLS =
    "grid grid-cols-[18px_44px_minmax(40px,1fr)_60px_68px_36px] items-center gap-x-2"
const RACE_TEAM_COLS =
    "grid grid-cols-[18px_128px_minmax(40px,1fr)_60px_68px_36px] items-center gap-x-2"
const NARROW_RACE_COLS =
    "grid grid-cols-[18px_44px_minmax(24px,1fr)_56px_64px_32px] items-center gap-x-1.5"
const NARROW_RACE_TEAM_COLS =
    "grid grid-cols-[18px_96px_minmax(24px,1fr)_56px_64px_32px] items-center gap-x-1.5"
const raceColsOf = (narrow: boolean, teams: boolean) =>
    narrow
        ? teams
            ? NARROW_RACE_TEAM_COLS
            : NARROW_RACE_COLS
        : teams
          ? RACE_TEAM_COLS
          : RACE_COLS

/** The bars' scale: the slowest gap shown, between these (s): a lap 6 s off doesn't squash the rest. */
const SCALE_MIN = 0.5
const SCALE_MAX = 3

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`
/** The last deletion by race control up to t (validity only needs that, so the list doesn't recompute 10 times a second). */
const lastDeletion = (laps: ReadonlyMap<number, readonly Lap[]>, t: number) => {
    let last = -Infinity
    for (const own of laps.values())
        for (const l of own)
            if (l.deleted && l.deleted.t <= t && l.deleted.t > last)
                last = l.deleted.t
    return last
}

/** A driver's team-coloured acronym, or the team's name. */
function Chip({
    n,
    d,
    team
}: {
    n: number
    d: DriverInfo | undefined
    team: boolean
}) {
    return (
        <span
            className={`inline-block truncate rounded px-1 text-center text-[11px] font-bold leading-5 ${d ? "" : "bg-zinc-700 text-zinc-100"}`}
            style={
                d
                    ? {
                          background: teamColor(d.teamColour),
                          color: textOn(d.teamColour)
                      }
                    : undefined
            }
        >
            {team && d ? shortTeam(d.team) : (d?.acronym ?? `#${n}`)}
        </span>
    )
}

const s3 = (x: number) => `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(3)}`
const compoundName = (c: string) => c.charAt(0) + c.slice(1).toLowerCase()
/** What the fit took out, for the footnote's title. */
const fitText = (f: PaceFit) =>
    `The fit so far: ${s3(f.fuel)} s each lap of the race (fuel burning off, the track rubbering in); ` +
    `${Object.entries(f.wear)
        .map(([c, w]) => `${compoundName(c)} ${s3(w)} s`)
        .join(", ")} each lap on the set; ` +
    `${
        Object.entries(f.offset)
            .filter(([c]) => c !== f.base)
            .map(([c, o]) => `${compoundName(c)} ${s3(o)} s`)
            .join(", ") || "one compound"
    }${Object.keys(f.offset).length > 1 ? ` against a new ${f.base.toLowerCase()}` : ""}.`

/** The gap to the quickest, on one scale for every row (none for the quickest). */
function GapBar({
    gap,
    scale,
    info
}: {
    gap: number
    scale: number
    info: DriverInfo | undefined
}) {
    return (
        <span className="relative h-3">
            {gap > 0 && (
                <span
                    className="absolute inset-y-0 left-0 rounded-sm"
                    style={{
                        width: `max(2px, ${Math.min(1, gap / scale) * 100}%)`,
                        background: info
                            ? teamColor(info.teamColour)
                            : "#71717b"
                    }}
                />
            )}
        </span>
    )
}

function PaceRowView({
    row,
    info,
    scale,
    narrow,
    teams,
    pinned,
    onPick
}: {
    row: PaceRow
    info: DriverInfo | undefined
    scale: number
    narrow: boolean
    teams: boolean
    pinned: boolean
    onPick: (r: PaceRow) => void
}) {
    const { best, rank, gap } = row
    const name = info?.acronym ?? `#${best.driver}`
    const left = leftOf(best)
    const first = rank === 1
    const title =
        `${teams && info ? `${shortTeam(info.team)}, ${name}` : name}: ${lapTime(best.time)} on lap ${best.lap}, ` +
        `${best.compound.toLowerCase()}s ${best.age === 0 ? "new" : `${plural(best.age, "lap")} old`}` +
        `${first ? "" : `, ${gap.toFixed(3)} s off the quickest`}. ` +
        (best.ideal == null || left == null
            ? "No ideal lap yet (a sector without a valid time). "
            : `Ideal lap (best sectors) ${lapTime(best.ideal)}: ${left.toFixed(3)} s left on the table. `) +
        (pinned ? "Watching it." : "Click to watch the lap.")
    return (
        <li className={pinned ? "bg-zinc-800/80" : undefined}>
            <button
                type="button"
                onClick={() => onPick(row)}
                className={`${colsOf(narrow, teams)} w-full px-3 py-1 text-left ${pinned ? "" : "hover:bg-zinc-900"}`}
                title={title}
                aria-current={pinned ? "true" : undefined}
            >
                <span
                    className={`text-right text-[11px] font-semibold tabular-nums ${first ? "text-zinc-50" : "text-zinc-400"}`}
                >
                    {rank}
                </span>
                <span className="flex min-w-0 items-center gap-1">
                    <Chip n={best.driver} d={info} team={teams} />
                    {teams && !narrow && (
                        <span className="text-[11px] text-zinc-400">
                            {name}
                        </span>
                    )}
                </span>
                <TyreBadge compound={best.compound} age={best.age} size={16} />
                <GapBar gap={gap} scale={scale} info={info} />
                <span
                    className={`text-right text-xs tabular-nums ${first ? "font-semibold text-zinc-50" : "text-zinc-200"}`}
                >
                    {lapTime(best.time)}
                </span>
                <span className="text-right text-xs tabular-nums text-zinc-400">
                    {first ? "" : `+${gap.toFixed(3)}`}
                </span>
                {!narrow && (
                    <span className="text-right text-xs tabular-nums text-zinc-300">
                        {lapTime(best.ideal)}
                    </span>
                )}
                <span className="text-right text-xs tabular-nums text-zinc-400">
                    {left == null ? "—" : left.toFixed(3)}
                </span>
            </button>
        </li>
    )
}

function RaceRowView({
    row,
    info,
    scale,
    narrow,
    teams,
    onPick
}: {
    row: RaceRow
    info: DriverInfo | undefined
    scale: number
    narrow: boolean
    teams: boolean
    onPick: (driver: number) => void
}) {
    const { pace, rank, gap } = row
    const name = info?.acronym ?? `#${pace.driver}`
    const first = rank === 1
    const title =
        `${teams && info ? `${shortTeam(info.team)}, ${name}` : name}: ` +
        (first
            ? "the quickest race pace"
            : `${gap.toFixed(3)} s a lap off the quickest race pace`) +
        ` once fuel, tyre age and compound are taken out, from ${plural(pace.laps, "clean lap")} in clear air ` +
        `(a median of ${lapTime(pace.median)} as driven). Click to follow ${name}.`
    return (
        <li>
            <button
                type="button"
                onClick={() => onPick(pace.driver)}
                className={`${raceColsOf(narrow, teams)} w-full px-3 py-1 text-left hover:bg-zinc-900`}
                title={title}
            >
                <span
                    className={`text-right text-[11px] font-semibold tabular-nums ${first ? "text-zinc-50" : "text-zinc-400"}`}
                >
                    {rank}
                </span>
                <span className="flex min-w-0 items-center gap-1">
                    <Chip n={pace.driver} d={info} team={teams} />
                    {teams && !narrow && (
                        <span className="text-[11px] text-zinc-400">
                            {name}
                        </span>
                    )}
                </span>
                <GapBar gap={gap} scale={scale} info={info} />
                <span
                    className={`text-right tabular-nums ${first ? "text-[11px] text-zinc-400" : "text-xs text-zinc-100"}`}
                >
                    {first ? "quickest" : `+${gap.toFixed(3)}`}
                </span>
                <span className="text-right text-xs tabular-nums text-zinc-400">
                    {lapTime(pace.median)}
                </span>
                <span className="text-right text-xs tabular-nums text-zinc-400">
                    {pace.laps}
                </span>
            </button>
        </li>
    )
}

/** Every driver's best valid lap so far, ranked, on the tyre it was set on, with the ideal lap from their best sectors. */
function PaceOrder() {
    const drivers = useDrivers()
    const laps = useAllLaps()
    const stints = useAllStints()
    const neutral = useNeutralPeriods()
    const selected = useSelection((s) => s.selected)
    const focus = useSelection((s) => s.focus)
    const toggle = useSelection((s) => s.toggle)
    const seek = usePlayback((p) => p.seek)
    const [{ show, by }, update] = useSettings<Settings>()
    const race = useSessionInfo((i) => i.kind === "race")
    const byPace = race && by === "pace"
    const info = useMemo(
        () => new Map<number, DriverInfo>(drivers.map((d) => [d.number, d])),
        [drivers]
    )
    const sessionKey = useSessionInfo((i) => i.sessionKey)
    const narrow = useWidgetSize().width < NARROW
    const teams = show === "teams"
    const deletedBy = useTime((t) => lastDeletion(laps, t))

    // The best clicked, kept as its driver's best while its lap is watched (pace.ts); it goes once the lap is done.
    const [pin, setPin] = useCardState<PinnedBest | null>("pin", null)
    const watched = useTime((t) => pin != null && watching(pin, t, sessionKey))
    useEffect(() => {
        if (pin && !watched) setPin(null)
    }, [pin, watched])

    const teamOf = useMemo(
        () => (teams ? (n: number) => info.get(n)?.team ?? `#${n}` : undefined),
        [teams, info]
    )
    const rows = useMemo(() => {
        if (byPace) return []
        const bests = [...laps].flatMap(
            ([n, own]) =>
                bestLap(n, own, stints.get(n) ?? [], neutral, deletedBy) ?? []
        )
        return paceRows(withPin(bests, watched ? pin : null), teamOf)
    }, [byPace, laps, stints, neutral, deletedBy, pin, watched, teamOf])
    const { racePaceRows, fit } = useMemo(() => {
        if (!byPace) return { racePaceRows: [], fit: null }
        const { paces, fit } = racePaces(laps, stints, neutral, deletedBy)
        return { racePaceRows: raceRows(paces, teamOf), fit }
    }, [byPace, laps, stints, neutral, deletedBy, teamOf])
    const scale = Math.min(
        SCALE_MAX,
        Math.max(SCALE_MIN, ...(byPace ? racePaceRows : rows).map((r) => r.gap))
    )

    // Watch the lap from its start, with its driver focused; with drivers selected, it joins them (so the other
    // widgets show it too). It stays in the list meanwhile (pinned).
    const follow = (driver: number) => {
        if (selected.length > 0 && !selected.includes(driver)) toggle(driver)
        focus(driver)
    }
    const onPick = (row: PaceRow) => {
        const b = row.best
        setPin({ best: b, sessionKey })
        seek(b.start)
        follow(b.driver)
    }

    return (
        <section className="flex h-full flex-col text-sm">
            <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-1.5">
                <Label as="h2" className="shrink-0 whitespace-nowrap">
                    Pace order
                </Label>
                <span
                    className="truncate text-[11px] text-zinc-400"
                    title={
                        byPace
                            ? "Each driver's race pace so far, ranked: clean laps in clear air with fuel, tyre age and compound taken out; the bar is the gap to the quickest"
                            : "Each best valid lap so far, ranked; the bar is the gap to the quickest"
                    }
                >
                    {teams
                        ? "Each team's quicker driver"
                        : byPace
                          ? "Fuel and tyres taken out"
                          : "Best lap so far"}
                </span>
                {race && (
                    <div
                        data-shot-control=""
                        className="ml-auto flex shrink-0 rounded-md bg-zinc-900 p-0.5"
                    >
                        {(["pace", "best"] as const).map((v) => (
                            <button
                                type="button"
                                key={v}
                                onClick={() => update({ by: v })}
                                aria-pressed={by === v}
                                className={`${TAP_CLASS} rounded px-2 text-[11px] leading-5 ${by === v ? "bg-zinc-700 text-zinc-50" : "text-zinc-300 hover:text-white"}`}
                                title={
                                    v === "pace"
                                        ? "By race pace: clean laps in clear air, with fuel, tyre age and compound taken out"
                                        : "By best lap: each driver's quickest valid lap"
                                }
                            >
                                {v === "pace" ? "Race pace" : "Best lap"}
                            </button>
                        ))}
                    </div>
                )}
                <div
                    data-shot-control=""
                    className={`${race ? "" : "ml-auto "}flex shrink-0 rounded-md bg-zinc-900 p-0.5`}
                >
                    {(["drivers", "teams"] as const).map((v) => (
                        <button
                            type="button"
                            key={v}
                            onClick={() => update({ show: v })}
                            aria-pressed={show === v}
                            className={`${TAP_CLASS} rounded px-2 text-[11px] leading-5 ${show === v ? "bg-zinc-700 text-zinc-50" : "text-zinc-300 hover:text-white"}`}
                            title={
                                v === "drivers"
                                    ? "Every driver's best lap"
                                    : "Each team's best lap, by its quicker driver"
                            }
                        >
                            {v === "drivers" ? "Drivers" : "Teams"}
                        </button>
                    ))}
                </div>
            </div>
            {byPace ? (
                <div
                    className={`${raceColsOf(narrow, teams)} border-b border-zinc-800 px-3 py-1 ${LABEL_CLASS}`}
                >
                    <span />
                    <span>{teams ? "Team" : "Driver"}</span>
                    <span />
                    <span
                        className="text-right"
                        title="Seconds a lap off the quickest race pace, once fuel, tyre age and compound are taken out"
                    >
                        Gap
                    </span>
                    <span
                        className="text-right"
                        title="The median of those laps, as driven"
                    >
                        Median
                    </span>
                    <span
                        className="text-right"
                        title="Clean laps in clear air, in the fit"
                    >
                        Laps
                    </span>
                </div>
            ) : (
                <div
                    className={`${colsOf(narrow, teams)} border-b border-zinc-800 px-3 py-1 ${LABEL_CLASS}`}
                >
                    <span />
                    <span>{teams ? "Team" : "Driver"}</span>
                    <span title="The tyre the lap was set on, and laps on the set">
                        Tyre
                    </span>
                    <span />
                    <span className="text-right" title="Best valid lap">
                        Best
                    </span>
                    <span className="text-right" title="Behind the quickest">
                        Gap
                    </span>
                    {!narrow && (
                        <span
                            className="text-right"
                            title="Ideal lap: the driver's best valid sectors added up"
                        >
                            Ideal
                        </span>
                    )}
                    <span
                        className="text-right"
                        title="Left on the table: best lap minus ideal lap"
                    >
                        Left
                    </span>
                </div>
            )}

            <div className="min-h-0 flex-1 overflow-y-auto">
                {(byPace ? racePaceRows : rows).length === 0 && (
                    <p className="px-3 py-6 text-center text-xs text-zinc-400">
                        {byPace ? "No clean laps yet" : "No valid laps yet"}
                    </p>
                )}
                <ol>
                    {racePaceRows.map((row) => (
                        <RaceRowView
                            key={row.pace.driver}
                            row={row}
                            info={info.get(row.pace.driver)}
                            scale={scale}
                            narrow={narrow}
                            teams={teams}
                            onPick={follow}
                        />
                    ))}
                    {rows.map((row) => (
                        <PaceRowView
                            key={row.best.driver}
                            row={row}
                            info={info.get(row.best.driver)}
                            scale={scale}
                            narrow={narrow}
                            teams={teams}
                            pinned={
                                watched && pin?.best.driver === row.best.driver
                            }
                            onPick={onPick}
                        />
                    ))}
                </ol>
            </div>
            <p
                className="border-t border-zinc-800 px-3 py-1 text-[11px] leading-4 text-zinc-400"
                title={byPace && fit ? fitText(fit) : undefined}
            >
                {byPace
                    ? `Clean laps ${CLEAR_AIR} s or more behind any car, with fuel, tyre age and compound taken out by one fit across the field. Not lap 1, out-, in- or deleted laps, laps under a VSC, safety car or red flag, or laps over 107% of the median. Engine modes aren't known.`
                    : "Out-, in- and deleted laps and laps under a VSC, safety car or red flag aren't counted. Fuel loads and engine modes aren't known."}
            </p>
        </section>
    )
}

export default defineWidget({
    id: "pace-order",
    name: "Pace order",
    group: "analysis",
    description:
        "The order by best lap: every driver's best valid lap so far, the tyre it was on, the gap to the quickest, and the ideal lap from their best sectors. In a race, also by race pace: clean laps in clear air with fuel, tyre age and compound taken out.",
    version: "1.0.0",
    // Fills its column and scrolls inside.
    height: { min: 200 },
    width: { min: 24, default: 32, max: 60 },
    sessions: ["race", "practice", "qualifying"],
    settings: { show: "drivers" as Show, by: "pace" as By },
    fields: {
        by: {
            kind: "choice",
            label: "Rank by (races)",
            options: [
                {
                    value: "pace",
                    label: "Race pace (fuel and tyres taken out)"
                },
                { value: "best", label: "Best lap" }
            ]
        },
        show: {
            kind: "choice",
            label: "Show",
            options: [
                { value: "drivers", label: "Every driver" },
                { value: "teams", label: "Each team's quicker driver" }
            ]
        }
    },
    Component: PaceOrder
})
