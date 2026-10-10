// A driver's page (/driver/<F1DB id>, ../../url.ts): who they are, their career in figures, and every season: team,
// championship position, points, wins, podiums, poles. From F1DB (../../history/drivers.ts). This season's figures
// count only once shown (./common.tsx): until then the totals stop at the end of last season and its row is hidden.
// Reached from Home's Drivers tab; its back button goes back to where it was opened from, as a circuit's page does.

import { useEffect, useState, type ReactNode } from "react";
import { fetchDriverHistory, sumTotals } from "../../history/drivers";
import type { DriverHistory, DriverSeason, DriverTotals } from "../../history/types";
import { currentYear } from "../../library";
import { useShareHeading } from "../../share/ShareCard";
import { Flag } from "../Flag";
import { RacesButton } from "../Navigation";
import { LABEL } from "../controls";
import { Attribution } from "../home/common";
import { Settings } from "../home/Settings";
import { F1dbCredit, points, SeasonNote, useCounts } from "./common";

/** The driver's seasons; null while loading, "none" if there's no such driver (or the deploy built none). */
function useDriverHistory(id: string): DriverHistory | "none" | null {
  const [history, setHistory] = useState<{ id: string; h: DriverHistory | "none" } | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    fetchDriverHistory(id, abort.signal)
      .then((h) => setHistory({ id, h: h ?? "none" }))
      .catch(() => {
        if (!abort.signal.aborted) setHistory({ id, h: "none" });
      });
    return () => abort.abort();
  }, [id]);
  return history?.id === id ? history.h : null;
}

const NONE: DriverTotals = { starts: 0, wins: 0, podiums: 0, poles: 0, fastestLaps: 0, points: 0, titles: 0 };

const longDate = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

/** Whole years from `from` to `to` (ISO dates). */
function age(from: string, to: string): number {
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  return ty - fy - (tm < fm || (tm === fm && td < fd) ? 1 : 0);
}

/** "29%": a share of starts, or nothing with none. */
const share = (n: number, of: number) => (of > 0 && n > 0 ? `${Math.round((n / of) * 100)}%` : null);

function Fact({ label, children, note }: { label: string; children: ReactNode; note?: string | null }) {
  return (
    <div className="min-w-0">
      <dt className={LABEL}>{label}</dt>
      <dd className="mt-1 text-2xl font-bold tabular-nums tracking-tight text-zinc-50">
        {children}
        {note && <span className="ml-1.5 text-sm font-normal text-zinc-400">{note}</span>}
      </dd>
    </div>
  );
}

/** Newest first; the season under way hidden until it counts. */
function Seasons({ seasons, counts }: { seasons: DriverSeason[]; counts: boolean }) {
  const cell = "px-3 py-2 text-right tabular-nums";
  return (
    <table className="w-full text-left text-sm">
      <caption className={`${LABEL} px-3 pb-2 text-left`}>Seasons</caption>
      <thead>
        <tr className={`${LABEL} border-b border-zinc-800`}>
          <th className="w-16 px-3 py-2 font-[inherit]">Year</th>
          <th className="px-3 py-2 font-[inherit]">Team</th>
          <th className={`${cell} font-[inherit]`} title="Championship position">
            Pos
          </th>
          <th className={`${cell} font-[inherit]`}>Points</th>
          <th className={`${cell} font-[inherit]`}>Wins</th>
          <th className={`${cell} hidden font-[inherit] sm:table-cell`}>Podiums</th>
          <th className={`${cell} hidden font-[inherit] sm:table-cell`}>Poles</th>
          <th className={`${cell} hidden font-[inherit] md:table-cell`} title="Grands Prix started">
            Starts
          </th>
        </tr>
      </thead>
      <tbody>
        {[...seasons].reverse().map((s) => {
          const hidden = s.year === currentYear() && !counts;
          return (
            <tr key={s.year} className="border-b border-zinc-800/70">
              <td className="px-3 py-2 tabular-nums text-zinc-400">{s.year}</td>
              <td className="px-3 py-2 text-zinc-100">{s.teams.join(", ") || "—"}</td>
              {hidden ? (
                <td colSpan={6} className="px-3 py-2 text-right text-xs text-zinc-500">
                  Hidden: spoilers
                </td>
              ) : (
                <>
                  <td className={`${cell} ${s.titles ? "font-bold text-zinc-50" : "text-zinc-200"}`} title={s.titles ? "Champion" : undefined}>
                    {s.position ?? "—"}
                    {s.titles > 0 && <span className="ml-1 text-[11px] font-semibold uppercase tracking-wider text-zinc-300">Champion</span>}
                  </td>
                  <td className={`${cell} text-zinc-200`}>{points(s.points)}</td>
                  <td className={`${cell} ${s.wins ? "text-zinc-50" : "text-zinc-500"}`}>{s.wins}</td>
                  <td className={`${cell} hidden sm:table-cell ${s.podiums ? "text-zinc-200" : "text-zinc-500"}`}>{s.podiums}</td>
                  <td className={`${cell} hidden sm:table-cell ${s.poles ? "text-zinc-200" : "text-zinc-500"}`}>{s.poles}</td>
                  <td className={`${cell} hidden text-zinc-400 md:table-cell`}>{s.starts}</td>
                </>
              )}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function Career({ h }: { h: DriverHistory }) {
  const year = currentYear();
  const counts = useCounts(year);
  const counted = h.seasons.filter((s) => s.year !== year || counts);
  const t = counted.reduce<DriverTotals>(sumTotals, NONE);
  const first = h.seasons[0]?.year;
  const last = h.seasons.at(-1)?.year;
  const underWay = last === year;
  const through = underWay && counts ? "the latest race weekend F1DB has" : null;
  return (
    <>
      <dl data-shot="" className="mt-8 grid grid-cols-2 gap-x-6 gap-y-5 border-y border-zinc-800 px-3 py-4 sm:grid-cols-4 lg:grid-cols-7">
        <Fact label="Titles">{t.titles}</Fact>
        <Fact label="Grands Prix">{t.starts}</Fact>
        <Fact label="Wins" note={share(t.wins, t.starts)}>
          {t.wins}
        </Fact>
        <Fact label="Podiums" note={share(t.podiums, t.starts)}>
          {t.podiums}
        </Fact>
        <Fact label="Poles">{t.poles}</Fact>
        <Fact label="Fastest laps">{t.fastestLaps}</Fact>
        <Fact label="Points">{points(t.points)}</Fact>
      </dl>
      {underWay ? (
        <SeasonNote year={year} through={through} source={h.source} className="mt-3 px-3" />
      ) : (
        <p data-shot-credit={`History: F1DB (${h.source.license})`} className="mt-3 px-3 text-xs text-zinc-400">
          {first === last ? `${first}` : `${first}–${last}`}, {h.seasons.length} {h.seasons.length === 1 ? "season" : "seasons"}. <F1dbCredit source={h.source} />.
        </p>
      )}
      <div data-shot="" className="mt-8">
        <Seasons seasons={h.seasons} counts={counts} />
      </div>
    </>
  );
}

export function DriverPage({ id }: { id: string }) {
  const h = useDriverHistory(id);
  useEffect(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  }, []);

  const d = h && h !== "none" ? h.driver : null;
  // The team now, for a driver racing this season; a career's span otherwise.
  const last = h && h !== "none" ? h.seasons.at(-1) : undefined;
  const first = h && h !== "none" ? h.seasons[0]?.year : undefined;
  const team = last?.year === currentYear() ? last.teams.at(-1) : last && first != null ? (first === last.year ? `${first}` : `${first}–${last.year}`) : undefined;
  const today = new Date().toISOString().slice(0, 10);
  const born = d ? `Born ${longDate(d.dateOfBirth)} in ${d.placeOfBirth}, ${d.countryOfBirth}` : "";
  const lived = d ? (d.dateOfDeath ? ` · died ${longDate(d.dateOfDeath)}, aged ${age(d.dateOfBirth, d.dateOfDeath)}` : ` · age ${age(d.dateOfBirth, today)}`) : "";
  const detail = d ? [d.number ? `#${d.number}` : null, team, d.nationality].filter(Boolean).join(" · ") : "";
  const name = d?.name ?? id;
  useEffect(() => {
    useShareHeading.setState({ heading: { title: name, detail, country: d?.nationality } });
    return () => useShareHeading.setState({ heading: null });
  }, [name, detail, d?.nationality]);

  return (
    <div className="flex h-full flex-col">
      <div className="h-[env(safe-area-inset-top)] shrink-0 bg-zinc-950" aria-hidden />
      <div className="relative min-h-0 flex-1 overflow-y-auto">
        <header className="sticky top-0 z-20 border-b border-zinc-800 bg-zinc-950">
          <div className="mx-auto flex h-[52px] max-w-6xl items-center gap-3 px-4 md:px-6">
            <RacesButton />
            <span className="flex-1" />
            <Settings />
          </div>
        </header>

        <main className="mx-auto max-w-6xl px-4 pb-16 pt-8 md:px-6">
          {h == null ? (
            <p className="px-3 text-sm text-zinc-400">Loading…</p>
          ) : h === "none" ? (
            <p className="px-3 text-sm text-zinc-400">No driver “{id}” in this build's history.</p>
          ) : (
            <>
              <div data-shot="title" className="px-3">
                <h1 className="flex items-center gap-3 text-3xl font-bold tracking-tight text-zinc-50">
                  <Flag country={h.driver.nationalityCode} code className="h-6" />
                  {h.driver.name}
                </h1>
                <p className="mt-1 text-sm text-zinc-300">{detail}</p>
                <p className="mt-0.5 text-sm text-zinc-400">
                  {born}
                  {lived}
                </p>
              </div>
              <Career h={h} />
            </>
          )}
        </main>

        <footer className="mx-auto max-w-6xl px-4 md:px-6">
          <div className="border-t border-zinc-800 py-5">
            <Attribution />
          </div>
        </footer>
      </div>
    </div>
  );
}
