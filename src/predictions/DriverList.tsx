// The top five from qualifying as a timing list (Home's rows, DESIGN.md), to pick one from: the call, or after the
// start, who really led (with a row for someone outside the five).

import { LABEL } from "../components/controls";
import { SOMEONE_ELSE, team, topFive } from "./model";

const COLS = "grid-cols-[3rem_minmax(0,1fr)_auto] sm:grid-cols-[3rem_minmax(0,1fr)_10rem_3rem]";

export function DriverList({ race, value, onChange, label, someoneElse = false }: { race: number; value: number | null; onChange: (n: number) => void; label: string; someoneElse?: boolean }) {
  const rows = [...topFive(race), ...(someoneElse ? [null] : [])];
  return (
    <div>
      <div className={`grid ${COLS} border-b border-zinc-800 px-3 pb-2`}>
        <span className={LABEL}>Qual</span>
        <span className={LABEL}>Driver</span>
        <span className={`${LABEL} hidden sm:block`}>Team</span>
        <span className={`${LABEL} text-right`}>No.</span>
      </div>
      <div role="radiogroup" aria-label={label}>
        {rows.map((d) => {
          const n = d?.number ?? SOMEONE_ELSE;
          const on = value === n;
          return (
            <button
              key={n}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => onChange(n)}
              className={`grid min-h-[44px] w-full ${COLS} items-center border-b border-zinc-800/70 px-3 text-left transition-colors ${on ? "bg-zinc-800/60" : "hover:bg-zinc-900"}`}
            >
              <span className="text-sm tabular-nums text-zinc-400">{d ? `P${d.quali}` : ""}</span>
              <span className="flex min-w-0 items-center gap-2.5">
                {d && <span className="h-4 w-1 flex-none rounded-full" style={{ background: team(d.team).colour }} />}
                <span className={`truncate text-sm font-semibold ${d ? "text-zinc-50" : "text-zinc-300"}`}>{d ? `${d.first} ${d.last}` : "Someone else"}</span>
                {d && <span className="text-xs font-bold tracking-wider text-zinc-400 sm:hidden">{d.code}</span>}
              </span>
              <span className="hidden truncate text-sm text-zinc-300 sm:block">{d ? team(d.team).name : ""}</span>
              <span className="flex items-center justify-end gap-3">
                <span className="text-sm tabular-nums text-zinc-400">{d?.number ?? ""}</span>
                <span className={`flex size-4 items-center justify-center rounded-full border ${on ? "border-zinc-100" : "border-zinc-600"}`}>
                  {on && <span className="size-2 rounded-full bg-zinc-100" />}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
