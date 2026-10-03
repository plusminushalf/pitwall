// The system's buttons and labels (DESIGN.md) as class lists, apart from Home's common.tsx (which loads the replay
// app), so pages without the app (Called It, src/predictions/) look like the rest of Pitwall.

export const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-300";
export const BUTTON = `whitespace-nowrap rounded-md px-2.5 py-1 text-xs font-semibold transition-colors disabled:opacity-50 ${FOCUS}`;
/** The page's one filled button: whatever can be done right now. */
export const PRIMARY = `${BUTTON} bg-zinc-100 text-zinc-950 hover:bg-white`;
export const SECONDARY = `${BUTTON} bg-zinc-800 text-zinc-100 hover:bg-zinc-700 hover:text-white`;
/** Column headers and small labels, as on the replay screen. */
export const LABEL = "text-[11px] font-semibold uppercase tracking-wider text-zinc-400";
