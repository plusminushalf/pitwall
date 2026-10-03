import type { ReactNode } from "react";

/**
 * The label type (DESIGN.md): 11 px semibold uppercase in zinc-400, the same as Home's column headers. For a
 * label that is its own element (a column title, a toggle) rather than a <Label>.
 */
export const LABEL_CLASS = "text-[11px] font-semibold uppercase tracking-wider text-zinc-400";

/**
 * The small uppercase label over or beside a value (LAP, S1, TYRES). It sets no line height: it takes the
 * widget's, which widgets with a fixed height count on (a line of it in a text-sm widget is 11 × 20/14 px).
 */
export function Label({ children, as: As = "span", title, className = "" }: { children: ReactNode; as?: "span" | "div" | "h2"; title?: string; className?: string }) {
  return (
    <As className={`${LABEL_CLASS} ${className}`} title={title}>
      {children}
    </As>
  );
}

/** A label over its value; the value brings its own size and colour (`className` styles the pair: `leading-tight`, `items-end`). */
export function Stat({ label, children, title, className = "" }: { label: ReactNode; children: ReactNode; title?: string; className?: string }) {
  return (
    <div className={`flex min-w-0 flex-col ${className}`} title={title}>
      <Label>{label}</Label>
      {children}
    </div>
  );
}
