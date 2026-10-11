import { type ReactNode, useRef } from "react"

/**
 * A value that lights up for a moment when it changes, so a new time is seen as it comes in (live, a sector or a lap
 * time changes in place). Not when it first shows, and not when it clears.
 */
export function Flash({
    value,
    className = "",
    title,
    children
}: {
    /** What's compared: a new one (not null) lights the cell up. */
    value: unknown
    className?: string
    title?: string
    children: ReactNode
}) {
    const last = useRef(value)
    const changes = useRef(0)
    if (!Object.is(last.current, value)) {
        last.current = value
        if (value != null) changes.current++
    }
    return (
        // A new key restarts the animation.
        <span
            key={changes.current}
            title={title}
            className={`${changes.current > 0 ? "pw-flash" : ""} ${className}`}
        >
            {children}
        </span>
    )
}
