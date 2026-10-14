// Home's drivers: the season's championship as a timing sheet, from F1DB's index (built at deploy,
// ../../history/careers.ts). A row opens the driver's page (../career/DriverPage.tsx): their season and career. Each
// reads position, the team's colour, name and car number, team, the season's wins, podiums and poles, points and the gap to the
// leader. Drivers who raced this season but not the latest round (stand-ins, drivers replaced) follow, quieter.
// Ticking up to three opens them compared (../career/ComparePage.tsx), from the bar that comes up under the sheet.

import { type ReactNode, useState } from "react"
import { byStanding, fetchDriverIndex } from "../../history/careers"
import type { SeasonDriver } from "../../history/types"
import { useReplay } from "../../store"
import { MAX_COMPARED } from "../career/ComparePage"
import { SeasonNote, TeamStripe, useHistoryFile } from "../career/common"
import { FOCUS } from "../controls"
import {
    AT_40,
    AT_52,
    Figure,
    PointsCells,
    Sheet,
    SheetRow,
    SheetTitle,
    Spoken,
    STANDINGS_GRID,
    StandingsColumns
} from "./sheet"

const loadIndex = (_: string, signal: AbortSignal) => fetchDriverIndex(signal)

/** "1–3, 15–16": the rounds raced, as ranges. */
function rounds(list: number[]): string {
    const out: string[] = []
    for (let i = 0; i < list.length; ) {
        let j = i
        while (j + 1 < list.length && list[j + 1] === list[j] + 1) j++
        out.push(i === j ? `${list[i]}` : `${list[i]}–${list[j]}`)
        i = j + 1
    }
    return out.join(", ")
}

/** The drivers ticked to compare, and ticking one (or not). */
interface Ticks {
    picked: string[]
    toggle: (id: string) => void
}

function Row({
    d,
    leader,
    quiet,
    ticks
}: {
    d: SeasonDriver
    leader: number
    quiet: boolean
    ticks: Ticks
}) {
    const ticked = ticks.picked.includes(d.id)
    const full = ticks.picked.length >= MAX_COMPARED
    const openDriver = useReplay((s) => s.openDriver)
    const team = (
        <>
            {d.team}
            {quiet && (
                <span className="text-zinc-400"> · R{rounds(d.rounds)}</span>
            )}
        </>
    )
    return (
        <SheetRow
            grid={STANDINGS_GRID}
            onOpen={() => openDriver(d.id)}
            title={`${d.name}: the season and the career`}
            raised={ticked}
            lead={
                <input
                    type="checkbox"
                    checked={ticked}
                    disabled={!ticked && full}
                    onChange={() => ticks.toggle(d.id)}
                    aria-label={`Compare ${d.name}`}
                    title={
                        !ticked && full
                            ? `Up to ${MAX_COMPARED} drivers at a time`
                            : `Compare ${d.name}`
                    }
                    className={`h-4 w-4 cursor-pointer accent-zinc-100 disabled:cursor-not-allowed disabled:opacity-40 pointer-coarse:h-5 pointer-coarse:w-5 ${FOCUS}`}
                />
            }
        >
            <span
                className={`font-bold tabular-nums ${quiet ? "text-zinc-400" : "text-zinc-50"}`}
            >
                {d.season.position != null ? (
                    <Spoken text={`P${d.season.position} in the championship`}>
                        {d.season.position}
                    </Spoken>
                ) : (
                    "–"
                )}
            </span>
            <span className="min-w-0">
                <span className="flex items-center gap-2">
                    <TeamStripe
                        team={d.teamId}
                        hold
                        className={quiet ? "h-4 opacity-50" : "h-4"}
                    />
                    <span
                        className={`min-w-0 truncate font-semibold ${quiet ? "text-zinc-300" : "text-zinc-50"}`}
                    >
                        {d.name}
                    </span>
                    {d.number && (
                        <span className="shrink-0 text-xs tabular-nums text-zinc-400">
                            {d.number}
                        </span>
                    )}
                </span>
                {/* Narrowest: the team under the name. */}
                <span className="block truncate text-xs text-zinc-300 @[40rem]:hidden">
                    {team}
                </span>
            </span>
            <span
                className={`${AT_40} truncate ${quiet ? "text-zinc-300" : "text-zinc-200"}`}
            >
                {team}
            </span>
            <Figure n={d.season.wins} className={AT_52} />
            <Figure n={d.season.podiums} className={AT_52} />
            <Figure n={d.season.poles} className={AT_52} />
            <PointsCells
                points={d.season.points}
                leader={leader}
                quiet={quiet}
            />
        </SheetRow>
    )
}

/** Under the sheet while drivers are ticked: who, and the button that compares them. */
function CompareBar({
    picked,
    names,
    clear
}: {
    picked: string[]
    names: (id: string) => string
    clear: () => void
}) {
    const openCompare = useReplay((s) => s.openCompare)
    if (picked.length === 0) return null
    return (
        <div
            data-shot-control=""
            className="sticky bottom-4 z-10 mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-zinc-700 bg-zinc-900/95 px-4 py-3 shadow-lg backdrop-blur"
        >
            <span className="min-w-0 flex-1 text-sm text-zinc-200">
                {picked.map(names).join(" v ")}
                {picked.length < 2 && (
                    <span className="text-zinc-400"> · tick another</span>
                )}
            </span>
            <button
                type="button"
                onClick={clear}
                className={`h-8 rounded-md px-3 text-sm text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100 ${FOCUS}`}
            >
                Clear
            </button>
            <button
                type="button"
                disabled={picked.length < 2}
                onClick={() => openCompare(picked)}
                className={`h-8 rounded-md bg-zinc-100 px-3 text-sm font-semibold text-zinc-950 hover:bg-white disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400 ${FOCUS}`}
            >
                Compare {picked.length > 1 ? picked.length : ""} drivers
            </button>
        </div>
    )
}

export function Drivers({ heading }: { heading: ReactNode }) {
    const index = useHistoryFile("index", loadIndex)
    const [picked, setPicked] = useState<string[]>([])
    const ticks: Ticks = {
        picked,
        toggle: (id) =>
            setPicked((p) =>
                p.includes(id)
                    ? p.filter((x) => x !== id)
                    : p.length < MAX_COMPARED
                      ? [...p, id]
                      : p
            )
    }

    let body: ReactNode
    if (index == null)
        body = (
            <p className="border-y border-zinc-800 px-3 py-4 text-sm text-zinc-400">
                Loading the drivers…
            </p>
        )
    else if (index === "none")
        body = (
            <p className="border-y border-zinc-800 px-3 py-4 text-sm text-zinc-400">
                No driver history in this build of the site.
            </p>
        )
    else {
        const grid = byStanding(index.drivers.filter((d) => d.current))
        const leader = Math.max(0, ...index.drivers.map((d) => d.season.points))
        const others = byStanding(index.drivers.filter((d) => !d.current))
        const through =
            index.throughRound != null
                ? `round ${index.throughRound}, the ${index.throughGrandPrix}`
                : null
        body = (
            <>
                <SeasonNote
                    through={through}
                    source={index.source}
                    className="px-3"
                />
                <p className="mb-3 mt-1 px-3 text-xs text-zinc-400">
                    Tick up to {MAX_COMPARED} drivers to compare them.
                </p>
                <Sheet
                    label={`${index.year} drivers' championship`}
                    grid={STANDINGS_GRID}
                    columns={<StandingsColumns who="Driver" with="Team" />}
                    lead={<span className="sr-only">Compare</span>}
                >
                    {grid.map((d) => (
                        <Row
                            key={d.id}
                            d={d}
                            leader={leader}
                            quiet={false}
                            ticks={ticks}
                        />
                    ))}
                </Sheet>
                {others.length > 0 && (
                    <>
                        <SheetTitle>Also raced in {index.year}</SheetTitle>
                        <Sheet
                            label={`Other ${index.year} drivers`}
                            grid={STANDINGS_GRID}
                            columns={
                                <StandingsColumns
                                    who="Driver"
                                    with="Team · rounds"
                                />
                            }
                            lead={<span className="sr-only">Compare</span>}
                        >
                            {others.map((d) => (
                                <Row
                                    key={d.id}
                                    d={d}
                                    leader={leader}
                                    quiet
                                    ticks={ticks}
                                />
                            ))}
                        </Sheet>
                    </>
                )}
                <CompareBar
                    picked={picked}
                    names={(id) =>
                        index.drivers.find((d) => d.id === id)?.lastName ?? id
                    }
                    clear={() => setPicked([])}
                />
            </>
        )
    }

    return (
        <section data-shot="" aria-label="Drivers" className="mt-12">
            <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2">
                {heading}
            </div>
            {body}
        </section>
    )
}
