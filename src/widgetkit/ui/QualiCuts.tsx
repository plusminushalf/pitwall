import type { QualiPhase } from "../../engine/qualiPhase"

/**
 * Live qualifying's cut lines over a timing list of `rowH` rows: the drop zone (the cars under it go out at the end of
 * the segment, red), and a line above the cars knocked out in each earlier segment.
 */
export function QualiCuts({
    phase,
    rowH
}: {
    phase: QualiPhase | null
    rowH: number
}) {
    const seg = phase?.segment
    if (!phase || !seg) return null
    const cut =
        seg.advance != null && phase.field > seg.advance ? seg.advance : null
    return (
        <>
            {cut != null && (
                <CutLine
                    top={cut * rowH}
                    label={
                        phase.settled
                            ? `Knocked out in ${seg.name}`
                            : "Drop zone"
                    }
                    red
                />
            )}
            {phase.out.map((o) => (
                <CutLine
                    key={o.segment.number}
                    top={(o.from - 1) * rowH}
                    label={`Knocked out in ${o.segment.name}`}
                />
            ))}
        </>
    )
}

/** A cut line across a list, at `top` px (0 in a zero-height list item: drawn there, in flow). */
export function CutLine({
    top,
    label,
    red = false
}: {
    top: number
    label: string
    red?: boolean
}) {
    return (
        <div
            aria-hidden
            className={`pointer-events-none absolute inset-x-0 z-10 border-t border-dashed ${red ? "border-red-500/70" : "border-zinc-500/70"}`}
            style={{ top }}
        >
            <span
                className={`absolute right-1 top-0 -translate-y-1/2 bg-zinc-950 px-1 text-[9px] font-bold uppercase tracking-wider ${red ? "text-red-400" : "text-zinc-400"}`}
            >
                {label}
            </span>
        </div>
    )
}
