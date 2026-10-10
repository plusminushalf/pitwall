// A season race by race: a column per round (its number and flag), a row per driver, each cell where they finished
// and, under it, where they started. Wins, podiums and points step down in weight; retirements are marked, not
// coloured as alarms. On a narrow screen it scrolls sideways, the drivers' names staying put.

import type { ReactNode } from "react";
import type { CarResult, HistoryNames, RaceRef } from "../../history/types";
import { Flag } from "../Flag";
import { LABEL } from "../controls";

export interface StripRow {
  key: string;
  label: ReactNode;
  /** By race id. */
  results: Map<number, CarResult>;
}

function finishClass(c: CarResult): string {
  if (c.pos === 1) return "font-black text-zinc-50";
  if (c.pos != null && c.pos <= 3) return "font-bold text-zinc-50";
  if ((c.points ?? 0) > 0) return "font-semibold text-zinc-200";
  if (c.pos == null) return "text-[11px] font-semibold uppercase tracking-wide text-zinc-500";
  return "text-zinc-400";
}

function title(r: RaceRef, c: CarResult, names: HistoryNames): string {
  const gp = names.gps[r.gp]?.name ?? r.gp;
  const start = c.grid ? `started ${c.grid}` : "started from the pit lane";
  const end = c.pos != null ? `finished ${c.pos}` : `${c.text}${c.reason ? ` (${c.reason})` : ""}`;
  const pts = c.points ? `, ${c.points} ${c.points === 1 ? "point" : "points"}` : "";
  return `${gp}: ${start}, ${end}${pts}${c.pole ? ", pole" : ""}${c.fastestLap ? ", fastest lap" : ""}`;
}

export function SeasonStrip({ races, rows, names }: { races: RaceRef[]; rows: StripRow[]; names: HistoryNames }) {
  return (
    <div className="overflow-x-auto">
      <table className="border-collapse text-sm">
        <thead>
          <tr className="border-b border-zinc-800">
            <th className={`sticky left-0 z-10 bg-zinc-950 px-3 py-2 text-left font-[inherit] ${LABEL}`}>Round</th>
            {races.map((r) => (
              <th key={r.raceId} className="w-10 min-w-10 px-0.5 py-2 font-normal" title={names.gps[r.gp]?.name ?? r.gp}>
                <span className="flex flex-col items-center gap-1">
                  <span className="text-[11px] tabular-nums text-zinc-400">{r.round}</span>
                  <Flag country={names.gps[r.gp]?.code ?? ""} code className="h-2.5" />
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} className="border-b border-zinc-800/70">
              <th scope="row" className="sticky left-0 z-10 max-w-36 truncate bg-zinc-950 px-3 py-2 text-left font-semibold text-zinc-100">
                {row.label}
              </th>
              {races.map((r) => {
                const c = row.results.get(r.raceId);
                return (
                  <td key={r.raceId} className="px-0.5 py-1.5 text-center tabular-nums" title={c ? title(r, c, names) : undefined}>
                    {c ? (
                      <span className="flex flex-col items-center leading-tight">
                        <span className={finishClass(c)}>{c.pos ?? c.text}</span>
                        <span className={`text-[11px] ${c.pole ? "font-semibold text-zinc-200" : "text-zinc-500"}`}>{c.grid ? c.grid : "PL"}</span>
                      </span>
                    ) : (
                      <span className="text-zinc-700">·</span>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 px-3 text-xs text-zinc-500">Finish, and the starting grid under it (PL: pit lane). Hover a race for its details.</p>
    </div>
  );
}
