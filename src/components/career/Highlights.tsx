// A career's highlights, for a driver's page and a team's: firsts and lasts, the longest runs, where they win, and
// the tables of who with (a driver's teams and teammates, a team's drivers). Worked out by ../../history/careerStats.ts
// over the races that count (the season under way only once shown).

import { bestCircuits, longestRun, milestones, podiumStreak, pointsStreak, winStreak, type HeadToHead, type Outing } from "../../history/careerStats";
import type { HistoryNames } from "../../history/types";
import { LABEL } from "../controls";
import { NameLink, points, raceName } from "./common";

const TH = `px-3 py-2 font-[inherit] ${LABEL}`;
const NUM = "px-3 py-2 text-right tabular-nums";

/** Firsts and lasts, each with the race and who (a team's) or from where (a driver's). */
export function Milestones({ outings, names, team = false }: { outings: Outing[]; names: HistoryNames; team?: boolean }) {
  const list = milestones(outings, team);
  if (list.length === 0) return null;
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-4 border-y border-zinc-800 px-3 py-4 sm:grid-cols-2 lg:grid-cols-4">
      {list.map((m) => (
        <div key={m.label} className="min-w-0">
          <dt className={LABEL}>{m.label}</dt>
          <dd className="mt-1 text-sm text-zinc-100">
            <span className="font-semibold">{raceName(m.race, names)}</span>
            <span className="block truncate text-xs text-zinc-400">
              {team ? (
                <NameLink kind="driver" id={m.car.driverId}>
                  {names.drivers[m.car.driverId]?.name ?? m.car.driverId}
                </NameLink>
              ) : (
                <NameLink kind="team" id={m.car.constructorId}>
                  {names.teams[m.car.constructorId] ?? m.car.constructorId}
                </NameLink>
              )}
              {m.car.grid ? `, from P${m.car.grid}` : ""}
            </span>
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** The longest runs of wins, podiums and points finishes. */
export function Runs({ outings, names }: { outings: Outing[]; names: HistoryNames }) {
  const runs = [
    ["Wins in a row", winStreak(outings)],
    ["Podiums in a row", podiumStreak(outings)],
    ["Points in a row", pointsStreak(outings)],
    ["Races without retiring", longestRun(outings, (c) => c.pos != null)],
  ] as const;
  const shown = runs.filter(([, r]) => r && r.length > 1);
  if (shown.length === 0) return null;
  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-4 border-b border-zinc-800 px-3 py-4 lg:grid-cols-4">
      {shown.map(([label, r]) => (
        <div key={label} className="min-w-0">
          <dt className={LABEL}>{label}</dt>
          <dd className="mt-1 text-sm text-zinc-100">
            <span className="text-2xl font-bold tabular-nums tracking-tight text-zinc-50">{r!.length}</span>
            <span className="block truncate text-xs text-zinc-400">
              {raceName(r!.from, names)} to {r!.from.year === r!.to.year ? (names.gps[r!.to.gp]?.short ?? r!.to.gp) : raceName(r!.to, names)}
            </span>
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** Where they win: the circuits with the most wins, then poles and podiums. */
export function BestCircuits({ outings, names }: { outings: Outing[]; names: HistoryNames }) {
  const list = bestCircuits(outings, 6);
  if (list.length === 0) return null;
  return (
    <table className="w-full text-left text-sm">
      <caption className={`${LABEL} px-3 pb-2 text-left`}>Best circuits</caption>
      <thead>
        <tr className="border-b border-zinc-800">
          <th className={TH}>Circuit</th>
          <th className={`${TH} text-right`}>Races</th>
          <th className={`${TH} text-right`}>Wins</th>
          <th className={`${TH} text-right`}>Poles</th>
          <th className={`${TH} text-right`}>Podiums</th>
        </tr>
      </thead>
      <tbody>
        {list.map((c) => (
          <tr key={c.circuit} className="border-b border-zinc-800/70">
            <td className="px-3 py-2 text-zinc-100">{names.circuits[c.circuit] ?? c.circuit}</td>
            <td className={`${NUM} text-zinc-400`}>{c.races}</td>
            <td className={`${NUM} ${c.wins ? "font-semibold text-zinc-50" : "text-zinc-500"}`}>{c.wins}</td>
            <td className={`${NUM} ${c.poles ? "text-zinc-200" : "text-zinc-500"}`}>{c.poles}</td>
            <td className={`${NUM} ${c.podiums ? "text-zinc-200" : "text-zinc-500"}`}>{c.podiums}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** A driver's teams, or a team's drivers: starts, wins, podiums, poles, points with each. */
export function Tally({
  rows,
  kind,
  names,
  caption,
}: {
  rows: { id: string; starts: number; wins: number; podiums: number; poles: number; points: number }[];
  kind: "driver" | "team";
  names: HistoryNames;
  caption: string;
}) {
  if (rows.length === 0) return null;
  return (
    <table className="w-full text-left text-sm">
      <caption className={`${LABEL} px-3 pb-2 text-left`}>{caption}</caption>
      <thead>
        <tr className="border-b border-zinc-800">
          <th className={TH}>{kind === "driver" ? "Driver" : "Team"}</th>
          <th className={`${TH} text-right`}>Starts</th>
          <th className={`${TH} text-right`}>Wins</th>
          <th className={`${TH} hidden text-right sm:table-cell`}>Podiums</th>
          <th className={`${TH} hidden text-right sm:table-cell`}>Poles</th>
          <th className={`${TH} text-right`} title="Points from Grands Prix (sprints aren't counted here)">
            GP points
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id} className="border-b border-zinc-800/70">
            <td className="px-3 py-2 text-zinc-100">
              <NameLink kind={kind} id={r.id}>
                {kind === "driver" ? (names.drivers[r.id]?.name ?? r.id) : (names.teams[r.id] ?? r.id)}
              </NameLink>
            </td>
            <td className={`${NUM} text-zinc-400`}>{r.starts}</td>
            <td className={`${NUM} ${r.wins ? "font-semibold text-zinc-50" : "text-zinc-500"}`}>{r.wins}</td>
            <td className={`${NUM} hidden sm:table-cell ${r.podiums ? "text-zinc-200" : "text-zinc-500"}`}>{r.podiums}</td>
            <td className={`${NUM} hidden sm:table-cell ${r.poles ? "text-zinc-200" : "text-zinc-500"}`}>{r.poles}</td>
            <td className={`${NUM} text-zinc-300`}>{points(r.points)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** "12–4", the leader's figure bold. */
function Score({ a, b }: { a: number; b: number }) {
  return (
    <>
      <span className={a > b ? "font-semibold text-zinc-50" : "text-zinc-300"}>{a}</span>
      <span className="text-zinc-500">–</span>
      <span className={b > a ? "font-semibold text-zinc-50" : "text-zinc-300"}>{b}</span>
    </>
  );
}

/** The driver against each teammate: races together, qualifying, race, points. */
export function Teammates({ list, names, caption = "Against teammates" }: { list: HeadToHead[]; names: HistoryNames; caption?: string }) {
  if (list.length === 0) return null;
  return (
    <table className="w-full text-left text-sm">
      <caption className={`${LABEL} px-3 pb-2 text-left`}>{caption}</caption>
      <thead>
        <tr className="border-b border-zinc-800">
          <th className={TH}>Teammate</th>
          <th className={`${TH} hidden sm:table-cell`}>Years</th>
          <th className={`${TH} text-right`}>Races</th>
          <th className={`${TH} text-right`} title="Qualified ahead – behind">
            Quali
          </th>
          <th className={`${TH} text-right`} title="Finished ahead – behind">
            Race
          </th>
          <th className={`${TH} hidden text-right md:table-cell`} title="Points from Grands Prix (sprints aren't counted here)">
            GP points
          </th>
        </tr>
      </thead>
      <tbody>
        {list.map((h) => (
          <tr key={h.mateId} className="border-b border-zinc-800/70">
            <td className="px-3 py-2 text-zinc-100">
              <NameLink kind="driver" id={h.mateId}>
                {names.drivers[h.mateId]?.name ?? h.mateId}
              </NameLink>
            </td>
            <td className="hidden px-3 py-2 tabular-nums text-zinc-400 sm:table-cell">{h.years[0] === h.years[1] ? h.years[0] : `${h.years[0]}–${h.years[1]}`}</td>
            <td className={`${NUM} text-zinc-400`}>{h.races}</td>
            <td className={NUM}>
              <Score a={h.quali[0]} b={h.quali[1]} />
            </td>
            <td className={NUM}>
              <Score a={h.race[0]} b={h.race[1]} />
            </td>
            <td className={`${NUM} hidden md:table-cell`}>
              <span className="text-zinc-300">
                {points(h.points[0])} <span className="text-zinc-500">–</span> {points(h.points[1])}
              </span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
