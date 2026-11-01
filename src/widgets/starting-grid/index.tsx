import { useMemo } from "react"
import {
    type DriverInfo,
    defineWidget,
    Label,
    lapTime,
    teamColor,
    useAllLaps,
    useCoarsePointer,
    useDrivers,
    useQualiPhase,
    useRunningOrder,
    useSelection,
    useTime,
    useWidgetSize
} from "widget-kit"
import { gridOf, lastDeletion, nameParts, type Slot } from "./grid"

/** A grid slot's height, and the room between two in a column (the other column's slot sits half way). */
const SLOT_H = 44
const GAP = 12
const PITCH = SLOT_H + GAP
const HEAD_H = 31
const FOOT_H = 34
/** Under this many px a slot shows the surname only. */
const NARROW = 560

function GridSlot({
    slot,
    info,
    narrow,
    selected,
    onToggle
}: {
    slot: Slot
    info: DriverInfo | undefined
    narrow: boolean
    selected: boolean
    onToggle: (n: number) => void
}) {
    const { first, last } = nameParts(
        info?.fullName ?? "",
        info?.acronym ?? `#${slot.driver}`
    )
    const time = slot.time != null ? lapTime(slot.time) : "No time"
    return (
        <button
            type="button"
            onClick={() => onToggle(slot.driver)}
            title={`P${slot.position}: ${info?.fullName ?? `#${slot.driver}`}${info ? `, ${info.team}` : ""}, ${slot.time != null ? `${time}${slot.segment ? ` in ${slot.segment}` : ""}` : "no time set"}. Click to ${selected ? "stop showing" : "show"} only the drivers picked on the track map.`}
            className={`flex w-full items-stretch gap-1.5 text-left ${selected ? "bg-zinc-800/70" : "hover:bg-zinc-900"}`}
            style={{ height: SLOT_H }}
        >
            <span className="flex w-9 shrink-0 items-center justify-center bg-zinc-100 text-lg font-bold tabular-nums text-zinc-950">
                {slot.position}
            </span>
            <span className="flex min-w-0 flex-1 flex-col justify-center border-r border-t border-zinc-500 px-2">
                <span className="flex min-w-0 items-baseline gap-2">
                    <span
                        className="w-5 shrink-0 text-right text-xs font-bold tabular-nums"
                        style={{
                            color: info ? teamColor(info.teamColour) : undefined
                        }}
                    >
                        {slot.driver}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[13px] text-zinc-50">
                        {!narrow && first && (
                            <span className="font-medium">{first} </span>
                        )}
                        <span className="font-bold">{last}</span>
                    </span>
                    <span
                        className={`shrink-0 text-xs tabular-nums ${slot.time != null ? "text-zinc-200" : "text-zinc-500"}`}
                    >
                        {time}
                    </span>
                </span>
                <span className="truncate pl-7 text-[11px] text-zinc-400">
                    {info?.team ?? ""}
                </span>
            </span>
        </button>
    )
}

/**
 * Qualifying's order laid out as the starting grid: odd places on the left, even ones on the right half a slot back,
 * each with the time that put the car there (its best in the segment it was classified in).
 */
function StartingGrid() {
    const drivers = useDrivers()
    const order = useRunningOrder()
    const { selected, toggle } = useSelection()
    const { width } = useWidgetSize()
    const coarse = useCoarsePointer()
    // (Without its clock, so the grid isn't redone as it counts down.)
    const phase = useQualiPhase((p) =>
        p
            ? {
                  segment: p.segment,
                  running: p.running,
                  settled: p.settled,
                  out: p.out
              }
            : null
    )
    const laps = useAllLaps()
    const deletedBy = useTime((t) => lastDeletion(laps, t))
    const grid = useMemo(
        () =>
            gridOf(
                order,
                laps,
                phase?.segment ?? null,
                phase?.out ?? [],
                deletedBy
            ),
        [order, laps, deletedBy, phase?.segment, phase?.out]
    )
    const info = useMemo(
        () => new Map(drivers.map((d) => [d.number, d])),
        [drivers]
    )
    const narrow = width < NARROW
    const seg = phase?.segment
    const final = seg != null && seg.advance == null && phase?.settled
    const status = !seg
        ? "Before qualifying"
        : final
          ? "Qualifying's final order"
          : `As it stands in ${seg.name}`
    const odd = grid.filter((s) => s.position % 2 === 1)
    const even = grid.filter((s) => s.position % 2 === 0)
    const column = (slots: Slot[]) => (
        <div className="flex min-w-0 flex-1 flex-col" style={{ gap: GAP }}>
            {slots.map((s) => (
                <GridSlot
                    key={s.driver}
                    slot={s}
                    info={info.get(s.driver)}
                    narrow={narrow}
                    selected={selected.includes(s.driver)}
                    onToggle={toggle}
                />
            ))}
        </div>
    )

    return (
        <section className="flex h-full flex-col text-sm">
            <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-1.5">
                <Label as="h2" className="shrink-0 whitespace-nowrap">
                    Starting grid
                </Label>
                <span className="truncate text-[11px] text-zinc-400">
                    {status}
                </span>
            </div>
            <div className="flex min-h-0 flex-1 gap-5 overflow-y-auto px-4 pt-3">
                {column(odd)}
                <div
                    className="flex min-w-0 flex-1"
                    style={{ paddingTop: PITCH / 2 }}
                >
                    {column(even)}
                </div>
            </div>
            <p className="border-t border-zinc-800 px-3 py-2 text-[11px] text-zinc-400">
                By qualifying: grid penalties aren't in the timing data.{" "}
                {coarse ? "Tap" : "Click"} a car to show it on the track map.
            </p>
        </section>
    )
}

export default defineWidget({
    id: "starting-grid",
    name: "Starting grid",
    group: "session",
    description:
        "Qualifying's order as the starting grid, two by two, with the lap time that put each car there.",
    version: "1.0.0",
    height: ({ drivers }) =>
        HEAD_H +
        12 +
        Math.ceil(drivers.length / 2) * PITCH +
        PITCH / 2 +
        FOOT_H,
    width: { min: 30, default: 47, max: 70 },
    sessions: ["qualifying"],
    settings: {},
    Component: StartingGrid
})
