// Drivers compared (/compare/<id>-vs-<id>, ../../url.ts): any two or three, picked on Home's Drivers tab, from a
// driver's page or here. Their season side by side, how they did against each other in the Grands Prix both started
// (and as teammates, if they were), then their careers, the best of each row in bold. From each driver's F1DB file
// (../../history/careers.ts), the picker from the season's index.

import { type ReactNode, useEffect, useMemo, useState } from "react"
import {
    type DriverRecord,
    driverRecord,
    type HeadToHead,
    headToHeads,
    meetings
} from "../../history/careerStats"
import {
    byStanding,
    fetchDriverHistory,
    fetchDriverIndex
} from "../../history/careers"
import type {
    DriverHistory,
    DriverIndex,
    DriverRace,
    DriverSeason
} from "../../history/types"
import { currentYear } from "../../library"
import { useShareHeading } from "../../share/ShareCard"
import { useReplay } from "../../store"
import { Icon } from "../../widgetkit/ui/Icon"
import { FOCUS, LABEL } from "../controls"
import {
    Block,
    CareerPage,
    NameLink,
    points,
    Section,
    TeamStripe,
    useHistoryFile
} from "./common"
import { Score } from "./Highlights"

export const MAX_COMPARED = 3

const TH = `px-2 py-2 sm:px-3 font-[inherit] ${LABEL}`
const NUM = "px-2 py-2 sm:px-3 text-right tabular-nums"

/** "29%": a share of starts, or nothing with none. */
const share = (n: number, of: number) =>
    of > 0 && n > 0 ? `${Math.round((n / of) * 100)}%` : null

const span = ([a, b]: [number, number]) => (a === b ? `${a}` : `${a}–${b}`)

/** A driver compared: their file, and their record over the races a table covers (null: none there). */
interface Col {
    h: DriverHistory
    rec: DriverRecord | null
    season?: DriverSeason
}

interface Row {
    label: string
    title?: string
    value: (c: Col) => number | null
    show?: (n: number) => string
    note?: (c: Col) => string | null
    /** Which way is better, for marking the leader; absent, none is. */
    better?: "high" | "low"
}

/** A count from the record, with its share of starts beside it. */
const counted = (
    label: string,
    of: (r: DriverRecord) => number,
    better?: "high"
): Row => ({
    label,
    value: (c) => (c.rec ? of(c.rec) : null),
    note: (c) => (c.rec ? share(of(c.rec), c.rec.races) : null),
    better
})

const AVERAGES: Row[] = [
    {
        label: "Avg grid",
        title: "Average starting position",
        value: (c) => c.rec?.avgGrid ?? null,
        show: (n) => n.toFixed(1),
        better: "low"
    },
    {
        label: "Avg finish",
        title: "Average finishing position, when classified",
        value: (c) => c.rec?.avgFinish ?? null,
        show: (n) => n.toFixed(1),
        better: "low"
    },
    {
        label: "Best finish",
        value: (c) => c.rec?.best?.pos ?? null,
        show: (n) => `P${n}`,
        better: "low"
    }
]

const RETIRED: Row = {
    label: "Retired",
    title: "Races not classified at the finish",
    value: (c) => c.rec?.retirements ?? null,
    note: (c) => (c.rec ? share(c.rec.retirements, c.rec.races) : null)
}

const SEASON_ROWS: Row[] = [
    {
        label: "Championship",
        value: (c) => c.season?.position ?? null,
        show: (n) => `P${n}`,
        better: "low"
    },
    {
        label: "Points",
        title: "Championship points, sprints included",
        value: (c) => c.season?.points ?? null,
        show: points,
        better: "high"
    },
    { label: "Grands Prix", value: (c) => c.rec?.races ?? null },
    counted("Wins", (r) => r.wins, "high"),
    counted("Podiums", (r) => r.podiums, "high"),
    counted("Poles", (r) => r.poles, "high"),
    ...AVERAGES,
    RETIRED
]

const CAREER_ROWS: Row[] = [
    { label: "Seasons", value: (c) => c.rec?.seasons ?? null },
    { label: "Grands Prix", value: (c) => c.rec?.races ?? null },
    {
        label: "Drivers' titles",
        value: (c) => c.h.seasons.reduce((n, s) => n + s.titles, 0),
        better: "high"
    },
    counted("Wins", (r) => r.wins, "high"),
    counted("Podiums", (r) => r.podiums, "high"),
    counted("Poles", (r) => r.poles, "high"),
    {
        label: "Fastest laps",
        value: (c) => c.rec?.fastestLaps ?? null,
        better: "high"
    },
    {
        label: "GP points",
        title: "Points from Grands Prix (sprints aren't counted here)",
        value: (c) => c.rec?.points ?? null,
        show: points,
        better: "high"
    },
    {
        label: "Points a race",
        title: "Grand Prix points per start. Points systems changed over the years: compare drivers of the same era",
        value: (c) =>
            c.rec && c.rec.races > 0 ? c.rec.points / c.rec.races : null,
        show: (n) => n.toFixed(1),
        better: "high"
    },
    ...AVERAGES,
    RETIRED
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

/** The drivers' figures side by side: a column a driver, under their name and `sub` (their team, their years). */
function Sheet({
    cols,
    rows,
    sub
}: {
    cols: Col[]
    rows: Row[]
    sub: (c: Col) => ReactNode
}) {
    return (
        <div className="overflow-x-auto">
            {/* A column a driver, no wider than reads across: the label column and 14rem each. */}
            <table
                className="w-full table-fixed text-left text-sm"
                style={{ maxWidth: `${10 + cols.length * 14}rem` }}
            >
                <colgroup>
                    <col className="w-28 sm:w-40" />
                    {cols.map((c) => (
                        <col key={c.h.driver.id} />
                    ))}
                </colgroup>
                <thead>
                    <tr className="border-y border-zinc-800">
                        <th className={TH}>
                            <span className="sr-only">Figure</span>
                        </th>
                        {cols.map((c) => (
                            <th
                                key={c.h.driver.id}
                                scope="col"
                                className="px-2 py-2 text-right font-normal sm:px-3"
                            >
                                <span className="block truncate font-semibold text-zinc-50">
                                    <NameLink
                                        kind="driver"
                                        id={c.h.driver.id}
                                        className="text-right"
                                    >
                                        <span className="sm:hidden">
                                            {c.h.driver.lastName}
                                        </span>
                                        <span className="hidden sm:inline">
                                            {c.h.driver.name}
                                        </span>
                                    </NameLink>
                                </span>
                                <span className="block truncate text-xs tabular-nums text-zinc-400">
                                    {sub(c)}
                                </span>
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {rows.map((row) => {
                        const values = cols.map(row.value)
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
                                {cols.map((c, i) => {
                                    const v = values[i]
                                    const note = row.note?.(c)
                                    return (
                                        <td
                                            key={c.h.driver.id}
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
    )
}

/** A pair's head-to-head over some races: "This season", "Every race", "As teammates". */
interface Versus {
    key: string
    a: DriverHistory
    b: DriverHistory
    over: string
    h: HeadToHead
}

/** Each pair against each other: in the races both started, this season and ever, and as teammates. */
function versus(list: DriverHistory[], year: number): Versus[] {
    const thisYear = (races: DriverRace[]) =>
        races.filter((r) => r.year === year)
    return list.flatMap((a, i) =>
        list.slice(i + 1).flatMap((b) => {
            const out: Versus[] = []
            const add = (over: string, h: HeadToHead | null | undefined) => {
                if (h)
                    out.push({
                        key: `${a.driver.id}-${b.driver.id}-${over}`,
                        a,
                        b,
                        over,
                        h
                    })
            }
            const ever = meetings(a.races, b.races)
            const mates = headToHeads(a.races).find(
                (m) => m.mateId === b.driver.id
            )
            add(`${year}`, meetings(thisYear(a.races), thisYear(b.races)))
            add("Every race", ever)
            // Only teammates whenever they met: that row would say it again.
            if (mates?.races !== ever?.races) add("As teammates", mates)
            return out
        })
    )
}

function HeadToHeads({ list, year }: { list: DriverHistory[]; year: number }) {
    const rows = useMemo(() => versus(list, year), [list, year])
    const pairs = list.length > 2
    if (rows.length === 0)
        return (
            <p className="border-y border-zinc-800 px-3 py-3 text-sm text-zinc-400">
                They never started the same Grand Prix.
            </p>
        )
    return (
        <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
                <thead>
                    <tr className="border-y border-zinc-800">
                        {pairs && <th className={TH}>Drivers</th>}
                        <th className={TH}>
                            <span className="sr-only">Races</span>
                        </th>
                        <th className={`${TH} hidden sm:table-cell`}>Years</th>
                        <th className={`${TH} text-right`}>Races</th>
                        <th
                            className={`${TH} text-right`}
                            title="Qualified ahead – behind"
                        >
                            Quali
                        </th>
                        <th
                            className={`${TH} text-right`}
                            title="Finished ahead – behind (a car still running is ahead of one that retired)"
                        >
                            Race
                        </th>
                        <th
                            className={`${TH} hidden text-right md:table-cell`}
                            title="Points from these Grands Prix (sprints aren't counted here)"
                        >
                            GP points
                        </th>
                    </tr>
                </thead>
                <tbody>
                    {rows.map((r) => (
                        <tr
                            key={r.key}
                            className="border-b border-zinc-800/70 hover:bg-zinc-900"
                        >
                            {pairs && (
                                <td className="px-2 py-2 text-zinc-100 sm:px-3">
                                    {r.a.driver.lastName}
                                    <span className="text-zinc-500"> v </span>
                                    {r.b.driver.lastName}
                                </td>
                            )}
                            <td className="px-2 py-2 text-zinc-300 sm:px-3">
                                {r.over}
                            </td>
                            <td className="hidden px-2 py-2 tabular-nums text-zinc-400 sm:table-cell sm:px-3">
                                {span(r.h.years)}
                            </td>
                            <td className={`${NUM} text-zinc-400`}>
                                {r.h.races}
                            </td>
                            <td className={NUM}>
                                <Score a={r.h.quali[0]} b={r.h.quali[1]} />
                            </td>
                            <td className={NUM}>
                                <Score a={r.h.race[0]} b={r.h.race[1]} />
                            </td>
                            <td className={`${NUM} hidden md:table-cell`}>
                                <Score
                                    a={r.h.points[0]}
                                    b={r.h.points[1]}
                                    show={points}
                                />
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    )
}

/** Driver files, fetched once each for the page's life. */
const files = new Map<string, Promise<DriverHistory | null>>()
const load = (id: string) => {
    let p = files.get(id)
    if (!p) {
        p = fetchDriverHistory(id).catch(() => null)
        files.set(id, p)
    }
    return p
}

/** The picked drivers' files, by id: absent while one loads, "none" if there's no such driver. */
function useDrivers(ids: string[]) {
    const [got, setGot] = useState<Record<string, DriverHistory | "none">>({})
    const key = ids.join(",")
    useEffect(() => {
        let live = true
        for (const id of key.split(",").filter(Boolean))
            void load(id).then((h) => {
                if (live) setGot((g) => ({ ...g, [id]: h ?? "none" }))
            })
        return () => {
            live = false
        }
    }, [key])
    return got
}

const loadIndex = (_: string, signal: AbortSignal) => fetchDriverIndex(signal)

function Picker({
    picked,
    names,
    index,
    set
}: {
    picked: string[]
    names: (id: string) => string
    index: DriverIndex | null
    set: (ids: string[]) => void
}) {
    const left = byStanding(index?.drivers ?? []).filter(
        (d) => !picked.includes(d.id)
    )
    const grid = left.filter((d) => d.current)
    const others = left.filter((d) => !d.current)
    const team = (id: string) =>
        index?.drivers.find((d) => d.id === id)?.teamId ?? null
    return (
        <div
            data-shot-control=""
            className="mt-5 flex flex-wrap items-center gap-2"
        >
            {picked.map((id) => (
                <span
                    key={id}
                    className="flex items-center gap-2 rounded-md border border-zinc-800 bg-zinc-900 py-0.5 pl-2 pr-0.5 text-sm font-semibold text-zinc-100"
                >
                    <TeamStripe team={team(id)} className="h-3.5" />
                    {names(id)}
                    <button
                        type="button"
                        onClick={() => set(picked.filter((x) => x !== id))}
                        className={`flex h-6 w-6 items-center justify-center rounded text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 ${FOCUS}`}
                        aria-label={`Remove ${names(id)}`}
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
                    <optgroup label={`${index?.year ?? ""} grid`}>
                        {grid.map((d) => (
                            <option
                                key={d.id}
                                value={d.id}
                                className="bg-zinc-900"
                            >
                                {`${d.name} (${d.team})`}
                            </option>
                        ))}
                    </optgroup>
                    {others.length > 0 && (
                        <optgroup label={`Also raced in ${index?.year ?? ""}`}>
                            {others.map((d) => (
                                <option
                                    key={d.id}
                                    value={d.id}
                                    className="bg-zinc-900"
                                >
                                    {`${d.name} (${d.team})`}
                                </option>
                            ))}
                        </optgroup>
                    )}
                </select>
            )}
        </div>
    )
}

export function ComparePage() {
    const picked = useReplay((s) => s.versus).slice(0, MAX_COMPARED)
    const setVersus = useReplay((s) => s.setVersus)
    const got = useDrivers(picked)
    const indexFile = useHistoryFile("index", loadIndex)
    const index = indexFile && indexFile !== "none" ? indexFile : null
    const year = index?.year ?? currentYear()
    const list = picked.flatMap((id) => {
        const h = got[id]
        return h && h !== "none" ? [h] : []
    })
    const loading = picked.some((id) => got[id] == null)
    const missing = picked.filter((id) => got[id] === "none")
    const names = (id: string) => {
        const h = got[id]
        return h && h !== "none"
            ? h.driver.name
            : (index?.drivers.find((d) => d.id === id)?.name ?? id)
    }
    const title =
        list.length > 1
            ? list.map((h) => h.driver.lastName).join(" v ")
            : "Compare drivers"
    const teamNow = (h: DriverHistory) => {
        const last = h.races.at(-1)
        return last?.year === year ? last.car.constructorId : null
    }

    useEffect(() => {
        useShareHeading.setState({
            heading: { title, detail: list.length > 1 ? "Head to head" : "" }
        })
        return () => useShareHeading.setState({ heading: null })
    }, [title, list.length])

    const season: Col[] = list.map((h) => ({
        h,
        rec: driverRecord(
            h.races.filter((r) => r.year === year),
            h.driver.id
        ),
        season: h.seasons.find((s) => s.year === year)
    }))
    const career: Col[] = list.map((h) => ({
        h,
        rec: driverRecord(h.races, h.driver.id)
    }))
    const anyThisYear = season.some((c) => c.rec != null)

    return (
        <CareerPage source={list[0]?.source ?? index?.source}>
            <header data-shot="title" className="px-3">
                <h1 className="flex flex-wrap items-center gap-x-3 text-3xl font-bold tracking-tight text-zinc-50">
                    {list.length > 1
                        ? list.map((h, i) => (
                              <span
                                  key={h.driver.id}
                                  className="flex items-center gap-3"
                              >
                                  {i > 0 && (
                                      <span className="font-normal text-zinc-500">
                                          v
                                      </span>
                                  )}
                                  <TeamStripe
                                      team={teamNow(h)}
                                      className="h-7"
                                  />
                                  {h.driver.lastName}
                              </span>
                          ))
                        : title}
                </h1>
                <Picker
                    picked={picked}
                    names={names}
                    index={index}
                    set={setVersus}
                />
                {missing.length > 0 && (
                    <p className="mt-3 text-sm text-zinc-400">
                        No driver “{missing.join("”, “")}” in this build's
                        history.
                    </p>
                )}
            </header>
            {list.length < 2 ? (
                <p className="mt-8 px-3 text-sm text-zinc-400">
                    {loading
                        ? "Loading…"
                        : `Pick ${list.length === 0 ? "two or three drivers" : "another driver or two"} to set them side by side: their ${year} season, how they did against each other, and their careers.`}
                </p>
            ) : (
                <>
                    {anyThisYear && (
                        <Section
                            title={`${year} season`}
                            aside={
                                index?.throughRound != null
                                    ? `through round ${index.throughRound}, the ${index.throughGrandPrix}`
                                    : undefined
                            }
                        >
                            <Sheet
                                cols={season}
                                rows={SEASON_ROWS}
                                sub={(c) => {
                                    const t = teamNow(c.h)
                                    return t ? (c.h.names.teams[t] ?? t) : "—"
                                }}
                            />
                        </Section>
                    )}
                    <Section
                        title="Head to head"
                        aside="the Grands Prix both started: qualified and finished ahead – behind"
                    >
                        <HeadToHeads list={list} year={year} />
                    </Section>
                    <Section title="Career" aside="Grands Prix">
                        <Sheet
                            cols={career}
                            rows={CAREER_ROWS}
                            sub={(c) => (c.rec ? span(c.rec.years) : "")}
                        />
                        <Block title="Teams">
                            <Teams list={list} />
                        </Block>
                    </Section>
                </>
            )}
        </CareerPage>
    )
}

/** Who each drove for, in order: a line a driver. */
function Teams({ list }: { list: DriverHistory[] }) {
    return (
        <dl className="border-t border-zinc-800">
            {list.map((h) => {
                const teams = [...new Set(h.seasons.flatMap((s) => s.teams))]
                return (
                    <div
                        key={h.driver.id}
                        className="grid grid-cols-[7.5rem_minmax(0,1fr)] items-baseline gap-x-3 border-b border-zinc-800/70 px-3 py-2 text-sm sm:grid-cols-[9rem_minmax(0,1fr)]"
                    >
                        <dt className="truncate text-zinc-400">
                            {h.driver.lastName}
                        </dt>
                        <dd className="text-zinc-200">
                            {teams.map((t, i) => (
                                <span key={t}>
                                    {i > 0 && (
                                        <span className="text-zinc-500">
                                            {" · "}
                                        </span>
                                    )}
                                    <NameLink kind="team" id={t}>
                                        {h.names.teams[t] ?? t}
                                    </NameLink>
                                </span>
                            ))}
                        </dd>
                    </div>
                )
            })}
        </dl>
    )
}
