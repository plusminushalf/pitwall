import type { DriverInfo } from "../../types";
import { teamColor, textOn } from "../../lib/format";

/** A driver's acronym on their team colour (#number on grey when the driver isn't known): a badge, in 11 px. */
export function DriverTag({ driver, number, title, className = "" }: { driver: DriverInfo | undefined; number: number; title?: string; className?: string }) {
  return (
    <span
      className={`inline-block rounded px-1 align-middle text-[11px] font-bold leading-4 ${driver ? "" : "bg-zinc-700 text-zinc-100"} ${className}`}
      style={driver ? { background: teamColor(driver.teamColour), color: textOn(driver.teamColour) } : undefined}
      title={title}
    >
      {driver?.acronym ?? `#${number}`}
    </span>
  );
}
