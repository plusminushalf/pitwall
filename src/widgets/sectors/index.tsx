import {
    type DriverSetting,
    defineWidget,
    Label,
    type Lap,
    MiniSectors,
    sectorTime,
    useBestSectors,
    useDriver,
    useLaps,
    useSelectedDriver
} from "widget-kit"

const EPS = 1e-6
/** A sector's line (the label and the time, both 16 px lines) and its mini-sector bar 4 px under it. */
const CELL_H = 16 + 4 + 4

/** The driver's fastest time in each sector over laps finished by the end of `upTo`. */
function personalBestSectors(laps: readonly Lap[], upTo: Lap | null): number[] {
    const best = [Infinity, Infinity, Infinity]
    if (!upTo || upTo.end == null) return best
    for (const l of laps) {
        if (l.end == null || l.end > upTo.end) continue
        for (let k = 0; k < 3; k++) {
            const v = l.sectors[k]
            if (v != null && v < best[k]) best[k] = v
        }
    }
    return best
}

function SectorCell({
    index,
    lap,
    personal,
    overall
}: {
    index: number
    lap: Lap | null
    personal: number
    overall: number
}) {
    const v = lap?.sectors[index] ?? null
    const color =
        v == null
            ? "text-zinc-600"
            : v <= overall + EPS
              ? "text-fuchsia-400"
              : v <= personal + EPS
                ? "text-emerald-400"
                : "text-yellow-400"
    return (
        <div className="min-w-0">
            <div className="flex items-center justify-between gap-1 leading-4">
                <Label>S{index + 1}</Label>
                <span className={`text-xs font-semibold tabular-nums ${color}`}>
                    {sectorTime(v)}
                </span>
            </div>
            <MiniSectors
                codes={lap?.segments[index] ?? []}
                className="mt-1 h-1"
            />
        </div>
    )
}

/** The last lap's sectors and mini-sectors: purple for the best by anyone so far, green for a personal best. */
function Sectors() {
    const n = useSelectedDriver()
    const last = useDriver(n, (d) => d.lastLap) ?? null
    // Just the three personal bests, not the laps: a new lap re-renders only if it changes them.
    const personal = useLaps(n, (laps) => personalBestSectors(laps, last))
    const overall = useBestSectors()
    return (
        <div className="grid h-full grid-cols-3 content-start gap-3 px-3 py-2 text-sm">
            {[0, 1, 2].map((k) => (
                <SectorCell
                    key={k}
                    index={k}
                    lap={last}
                    personal={personal[k]}
                    overall={overall[k] ?? Infinity}
                />
            ))}
        </div>
    )
}

export default defineWidget({
    id: "sectors",
    name: "Sectors",
    group: "driver",
    description:
        "The driver's last lap by sector and mini-sector: purple for the fastest, green for a personal best.",
    version: "1.0.0",
    height: 8 + CELL_H + 8,
    width: { min: 12, default: 21, max: 40 },
    sessions: ["race", "practice", "qualifying"],
    settings: { driver: "follow-selection" as DriverSetting },
    Component: Sectors
})
