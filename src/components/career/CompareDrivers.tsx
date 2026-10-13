// A team page's drivers side by side: up to three of everyone who raced for it, each one's record in its cars (seasons,
// wins, podiums, points, average grid and finish…) with the best of each row in bold, and, for those who were
// teammates, how they did against each other. Picked by the visitor (the latest race's drivers until they do), kept
// in the address (../../url.ts) so a link shows the same comparison.

import { useMemo, useState } from "react"
import {
    type TeamDriverRecord,
    teamDriverRecord,
    teamHeadToHeads
} from "../../history/careerStats"
import type { TeamHistory } from "../../history/types"
import { readCompared, withCompared } from "../../url"
import { Icon } from "../../widgetkit/ui/Icon"
import { FOCUS, LABEL } from "../controls"
import { Block, NameLink, points, Section } from "./common"
import { Score } from "./Highlights"

export const MAX_COMPARED = 3

const TH = `px-2 py-2 sm:px-3 font-[inherit] ${LABEL}`
const NUM = "px-2 py-2 sm:px-3 text-right tabular-nums"

/** "29%": a share of starts, or nothing with none. */
const share = (n: number, of: number) =>
    of > 0 && n > 0 ? `${Math.round((n / of) * 100)}%` : null

const span = ([a, b]: [number, number]) => (a === b ? `${a}` : `${a}–${b}`)

interface Row {
    label: string
    title?: string
    value: (r: TeamDriverRecord) => number | null
    show?: (n: number) => string
    note?: (r: TeamDriverRecord) => string | null
    /** Which way is better, for marking the leader; absent, none is. */
    better?: "high" | "low"
}

const ROWS: Row[] = [
    { label: "Seasons", value: (r) => r.seasons },
    { label: "Grands Prix", value: (r) => r.races },
    {
        label: "Wins",
        value: (r) => r.wins,
        note: (r) => share(r.wins, r.races),
        better: "high"
    },
    {
        label: "Podiums",
        value: (r) => r.podiums,
        note: (r) => share(r.podiums, r.races),
        better: "high"
    },
    {
        label: "Poles",
        value: (r) => r.poles,
        note: (r) => share(r.poles, r.races),
        better: "high"
    },
    { label: "Fastest laps", value: (r) => r.fastestLaps, better: "high" },
    {
        label: "GP points",
        title: "Points from Grands Prix (sprints aren't counted here)",
        value: (r) => r.points,
        show: points,
        better: "high"
    },
    {
        label: "Points a race",
        title: "Grand Prix points per start. Points systems changed over the years: compare drivers of the same era",
        value: (r) => (r.races > 0 ? r.points / r.races : null),
        show: (n) => n.toFixed(1),
        better: "high"
    },
    {
        label: "Avg grid",
        title: "Average starting position",
        value: (r) => r.avgGrid,
        show: (n) => n.toFixed(1),
        better: "low"
    },
    {
        label: "Avg finish",
        title: "Average finishing position, when classified",
        value: (r) => r.avgFinish,
        show: (n) => n.toFixed(1),
        better: "low"
    },
    {
        label: "Best finish",
        value: (r) => r.best?.pos ?? null,
        show: (n) => `P${n}`,
        better: "low"
    },
    {
        label: "Retired",
        title: "Races not classified at the finish",
        value: (r) => r.retirements,
        note: (r) => share(r.retirements, r.races)
    }
]

/** The columns leading a row: the best value, when not everyone has it (and, counting up, it isn't nothing). */
function leaders(values: (number | null)[], better?: "high" | "low") {
    const known = values.filter((v): v is number => v != null)
    if (!better || known.length < 2) return new Set<number>()
    const best = better === "high" ? Math.max(...known) : Math.min(...known)
    if ((better === "high" && best <= 0) || known.every((v) => v === best))
        return new Set<number>()
    return new Set(values.flatMap((v, i) => (v === best ? [i] : [])))
}

/** Everyone who raced for the team, the latest first: who can be picked. */
function everyone(h: TeamHistory) {
    const by = new Map<
        string,
        { id: string; first: number; last: number; starts: number }
    >()
    for (const r of h.races)
        for (const c of r.cars) {
            const d = by.get(c.driverId) ?? {
                id: c.driverId,
                first: r.year,
                last: r.year,
                starts: 0
            }
            d.last = r.year
            d.starts++
            by.set(c.driverId, d)
        }
    return [...by.values()].sort(
        (a, b) => b.last - a.last || b.starts - a.starts
    )
}

/** Who to show first: the drivers of its latest race, and with only one there, that season's others too. */
function latest(h: TeamHistory): string[] {
    const ids = new Set((h.races.at(-1)?.cars ?? []).map((c) => c.driverId))
    if (ids.size < 2)
        for (const id of h.seasons.at(-1)?.drivers ?? []) ids.add(id)
    return [...ids].slice(0, MAX_COMPARED)
}

function Picker({
    h,
    picked,
    set
}: {
    h: TeamHistory
    picked: string[]
    set: (ids: string[]) => void
}) {
    const all = useMemo(() => everyone(h), [h])
    const left = all.filter((d) => !picked.includes(d.id))
    return (
        <div
            data-shot-control=""
            className="flex flex-wrap items-center gap-2 px-3"
        >
            {picked.map((id) => (
                <span
                    key={id}
                    className="flex items-center gap-1 rounded-md border border-zinc-800 bg-zinc-900 py-0.5 pl-2 pr-0.5 text-sm font-semibold text-zinc-100"
                >
                    {h.names.drivers[id]?.name ?? id}
                    <button
                        type="button"
                        onClick={() => set(picked.filter((x) => x !== id))}
                        className={`flex h-6 w-6 items-center justify-center rounded text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 ${FOCUS}`}
                        aria-label={`Remove ${h.names.drivers[id]?.name ?? id}`}
                        title="Remove from the comparison"
                    >
                        <Icon name="close" size={12} />
                    </button>
                </span>
            ))}
            {picked.length < MAX_COMPARED && left.length > 0 && (
                <select
                    value=""
                    onChange={(e) => {
                        e.currentTarget.blur()
                        if (e.target.value) set([...picked, e.target.value])
                    }}
                    aria-label="Add a driver to the comparison"
                    className={`h-8 max-w-64 cursor-pointer rounded-md bg-zinc-800 px-2 text-sm text-zinc-100 hover:bg-zinc-700 ${FOCUS}`}
                >
                    <option value="">
                        {picked.length === 0
                            ? "Pick a driver…"
                            : "Add a driver…"}
                    </option>
                    {left.map((d) => (
                        <option key={d.id} value={d.id} className="bg-zinc-900">
                            {`${h.names.drivers[d.id]?.name ?? d.id} (${span([d.first, d.last])})`}
                        </option>
                    ))}
                </select>
            )}
        </div>
    )
}

/** Up to three of the team's drivers: their records with it side by side, and against each other as teammates. */
export function CompareDrivers({ h }: { h: TeamHistory }) {
    const known = useMemo(
        () => new Set(h.races.flatMap((r) => r.cars.map((c) => c.driverId))),
        [h]
    )
    const [picked, setPicked] = useState<string[]>(() =>
        (readCompared(location.search) ?? latest(h))
            .filter((id) => known.has(id))
            .slice(0, MAX_COMPARED)
    )
    const set = (ids: string[]) => {
        setPicked(ids)
        history.replaceState(
            history.state,
            "",
            location.pathname + withCompared(location.search, ids)
        )
    }
    const records = useMemo(
        () =>
            picked.flatMap((id) => {
                const r = teamDriverRecord(h.races, id)
                return r ? [r] : []
            }),
        [h, picked]
    )
    const titles = (id: string) =>
        h.seasons.filter((s) => s.driversTitle === id).length
    const pairs = useMemo(() => teamHeadToHeads(h.races, picked), [h, picked])
    const name = (id: string) => h.names.drivers[id]?.lastName ?? id
    const rows: Row[] = [
        ...ROWS.slice(0, 2),
        {
            label: "Drivers' titles",
            title: "Drivers' championships won in its cars",
            value: (r) => titles(r.driverId),
            better: "high"
        },
        ...ROWS.slice(2)
    ]

    return (
        <Section
            title="Compare drivers"
            aside={`up to ${MAX_COMPARED}, their Grands Prix for ${h.team.name}`}
        >
            <Picker h={h} picked={picked} set={set} />
            {records.length === 0 ? (
                <p className="mt-4 px-3 text-sm text-zinc-400">
                    Pick drivers who raced for {h.team.name} to set their
                    records side by side.
                </p>
            ) : (
                <div className="mt-4 overflow-x-auto">
                    {/* A column a driver, no wider than reads across: the label column and 14rem each. */}
                    <table
                        className="w-full table-fixed text-left text-sm"
                        style={{ maxWidth: `${10 + records.length * 14}rem` }}
                    >
                        <colgroup>
                            <col className="w-28 sm:w-40" />
                            {records.map((r) => (
                                <col key={r.driverId} />
                            ))}
                        </colgroup>
                        <thead>
                            <tr className="border-y border-zinc-800">
                                <th className={TH}>
                                    <span className="sr-only">Figure</span>
                                </th>
                                {records.map((r) => (
                                    <th
                                        key={r.driverId}
                                        scope="col"
                                        className="px-2 py-2 text-right font-normal sm:px-3"
                                    >
                                        <span className="block truncate font-semibold text-zinc-50">
                                            <NameLink
                                                kind="driver"
                                                id={r.driverId}
                                                className="text-right"
                                            >
                                                <span className="sm:hidden">
                                                    {name(r.driverId)}
                                                </span>
                                                <span className="hidden sm:inline">
                                                    {h.names.drivers[r.driverId]
                                                        ?.name ?? r.driverId}
                                                </span>
                                            </NameLink>
                                        </span>
                                        <span className="block text-xs tabular-nums text-zinc-400">
                                            {span(r.years)}
                                        </span>
                                    </th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {rows.map((row) => {
                                const values = records.map(row.value)
                                const lead = leaders(values, row.better)
                                return (
                                    <tr
                                        key={row.label}
                                        className="border-b border-zinc-800/70 hover:bg-zinc-900"
                                    >
                                        <th
                                            scope="row"
                                            className="truncate px-2 py-2 font-normal text-zinc-400 sm:px-3"
                                            title={row.title}
                                        >
                                            {row.label}
                                        </th>
                                        {records.map((r, i) => {
                                            const v = values[i]
                                            const note = row.note?.(r)
                                            return (
                                                <td
                                                    key={r.driverId}
                                                    className={`${NUM} ${lead.has(i) ? "font-semibold text-zinc-50" : "text-zinc-300"}`}
                                                >
                                                    {v == null
                                                        ? "—"
                                                        : (row.show?.(v) ?? v)}
                                                    {note && (
                                                        <span className="ml-1.5 hidden text-xs font-normal text-zinc-400 sm:inline">
                                                            {note}
                                                        </span>
                                                    )}
                                                </td>
                                            )
                                        })}
                                    </tr>
                                )
                            })}
                        </tbody>
                    </table>
                </div>
            )}
            {records.length > 1 && (
                <Block
                    title="As teammates"
                    aside="races together: qualified and finished ahead – behind"
                >
                    {pairs.length === 0 ? (
                        <p className="px-3 text-sm text-zinc-400">
                            None of them raced for {h.team.name} at the same
                            time.
                        </p>
                    ) : (
                        <div className="overflow-x-auto">
                            <table className="w-full text-left text-sm">
                                <thead>
                                    <tr className="border-y border-zinc-800">
                                        <th className={TH}>Drivers</th>
                                        <th
                                            className={`${TH} hidden sm:table-cell`}
                                        >
                                            Years
                                        </th>
                                        <th className={`${TH} text-right`}>
                                            Races
                                        </th>
                                        <th
                                            className={`${TH} text-right`}
                                            title="Qualified ahead – behind"
                                        >
                                            Quali
                                        </th>
                                        <th
                                            className={`${TH} text-right`}
                                            title="Finished ahead – behind"
                                        >
                                            Race
                                        </th>
                                        <th
                                            className={`${TH} hidden text-right md:table-cell`}
                                            title="Points from Grands Prix (sprints aren't counted here)"
                                        >
                                            GP points
                                        </th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {pairs.map((p) => (
                                        <tr
                                            key={`${p.driverId}-${p.mateId}`}
                                            className="border-b border-zinc-800/70 hover:bg-zinc-900"
                                        >
                                            <td className="px-2 py-2 sm:px-3 text-zinc-100">
                                                {name(p.driverId)}
                                                <span className="text-zinc-500">
                                                    {" "}
                                                    v{" "}
                                                </span>
                                                {name(p.mateId)}
                                            </td>
                                            <td className="hidden px-2 py-2 sm:px-3 tabular-nums text-zinc-400 sm:table-cell">
                                                {span(p.years)}
                                            </td>
                                            <td
                                                className={`${NUM} text-zinc-400`}
                                            >
                                                {p.races}
                                            </td>
                                            <td className={NUM}>
                                                <Score
                                                    a={p.quali[0]}
                                                    b={p.quali[1]}
                                                />
                                            </td>
                                            <td className={NUM}>
                                                <Score
                                                    a={p.race[0]}
                                                    b={p.race[1]}
                                                />
                                            </td>
                                            <td
                                                className={`${NUM} hidden md:table-cell`}
                                            >
                                                <Score
                                                    a={p.points[0]}
                                                    b={p.points[1]}
                                                    show={points}
                                                />
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </Block>
            )}
        </Section>
    )
}
