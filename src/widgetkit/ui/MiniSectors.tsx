/** Mini-sector status codes (Lap.segments): 2048 yellow (no improvement), 2049 green (personal best), 2051 purple (fastest), 2064 pit lane. */
const SEGMENT_COLOR: Record<number, string> = {
    2048: "#eab308",
    2049: "#10b981",
    2051: "#d946ef",
    2064: "#3b82f6"
}
/** A mini-sector not passed yet (or with no status). */
const NOT_YET = "#3f3f46"

/**
 * One sector's mini-sectors as a strip of bars in the timing screen's colours, null ones (not passed yet) grey; a
 * plain grey bar when the timing has none. `className` sets the height (h-1 by default).
 */
export function MiniSectors({
    codes,
    className = "h-1"
}: {
    codes: readonly (number | null)[]
    className?: string
}) {
    return (
        <span className={`flex gap-px ${className}`}>
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
