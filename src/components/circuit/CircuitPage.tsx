// A circuit's page (/circuit/<slug>, ../../url.ts): every weekend OpenF1 has there, newest first, each session with
// its action as on Home's season sheet; above them its earlier races (the circuit widgets: safety cars, strategies)
// and its past from F1DB (../../history): its lap records, the last winners and pole sitters, and who wins there.
// Reached from a circuit's name on Home and on the replay's header. Its back button goes back to where it was opened
// from (Home), as the Races button does from a session.

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { rowsAt } from "../../circuit";
import { fetchCircuitHistory } from "../../history/circuits";
import { currentLayout, lastPodiums, leaders, poleLapRecord, poleToWin, raceLapRecord } from "../../history/insights";
import type { CircuitHistory, HistoryEntry } from "../../history/types";
import { currentYear, useLibrary, YEARS } from "../../library";
import { FOCUS, LABEL, SECONDARY } from "../controls";
import { Attribution, shortGp } from "../home/common";
import { Settings } from "../home/Settings";
import { byMeeting, WeekendSheet } from "../home/Season";
import { RacesButton } from "../Navigation";
import { Flag } from "../Flag";
import { useReplay } from "../../store";
import { BUILTIN_WIDGETS } from "../../grid/builtins";
import { usePastRaces } from "../../history/pastRacesStore";
import { WidgetHost } from "../../widgetkit/WidgetHost";

/** The circuit's F1DB history; null while it loads, and if there's none (not mapped, or not built). */
function useCircuitHistory(circuitKey: number | null): CircuitHistory | null {
  const [history, setHistory] = useState<{
    key: number;
    h: CircuitHistory | null;
  } | null>(null);
  useEffect(() => {
    if (circuitKey == null) return;
    const abort = new AbortController();
    fetchCircuitHistory(circuitKey, abort.signal)
      .then((h) => setHistory({ key: circuitKey, h }))
      .catch(() => {
        if (!abort.signal.aborted) setHistory({ key: circuitKey, h: null });
      });
    return () => abort.abort();
  }, [circuitKey]);
  return history?.key === circuitKey ? history.h : null;
}

const TYPE: Record<CircuitHistory["circuit"]["type"], string> = {
  RACE: "Race circuit",
  ROAD: "Road circuit",
  STREET: "Street circuit",
};

function Fact({ label, children, title }: { label: string; children: ReactNode; title?: string }) {
  return (
    <div className="min-w-0" title={title}>
      <dt className={LABEL}>{label}</dt>
      <dd className="mt-1 text-sm text-zinc-100 md:truncate">{children}</dd>
    </div>
  );
}

/**
 * The circuit's past: what it is, its records, who wins there, and the last few races. Results are spoilers (PRODUCT.md:
 * no surface gives away how a race ended): unless spoilers are shown (Settings), they wait behind Show results.
 */
function History({ h, slug }: { h: CircuitHistory; slug: string }) {
  const spoilers = useReplay((s) => s.spoilerPref === "show");
  // One reveal for the circuit: these records and its widgets (Past races) together.
  const revealed = usePastRaces((s) => s.revealed[slug] === true);
  const driver = (e: HistoryEntry | null | undefined) => (e ? (h.drivers[e.driverId]?.name ?? e.driverId) : "—");
  const team = (e: HistoryEntry) => h.constructors[e.constructorId]?.name ?? e.constructorId;
  const layout = currentLayout(h);
  const lap = raceLapRecord(h);
  const pole = poleLapRecord(h);
  const wins = leaders(h, "wins").slice(0, 3);
  const since = currentYear() - 10;
  const conversion = poleToWin(h, since);
  const recent = lastPodiums(h, 6);
  const { circuit } = h;
  const sameLayout = layout && layout.firstYear !== h.races[0]?.year ? ` (layout since ${layout.firstYear})` : "";

  return (
    <section data-shot="" aria-labelledby="history-title" className="mt-8">
      <h2 id="history-title" className="sr-only">
        History
      </h2>
      {!spoilers && !revealed ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-y border-zinc-800 px-3 py-4 text-sm text-zinc-300">
          <p className="max-w-[75ch]">Results are hidden: lap records, winners and podiums give away how races ended.</p>
          <button onClick={() => usePastRaces.getState().reveal(slug)} className={SECONDARY}>
            Show results
          </button>
        </div>
      ) : (
        <>
          <dl className="grid grid-cols-1 gap-x-6 gap-y-4 border-y border-zinc-800 px-3 py-4 sm:grid-cols-2 md:grid-cols-4">
            <Fact label="Race lap record" title={lap ? `Fastest race lap on this layout${sameLayout}` : undefined}>
              {lap ? (
                <>
                  <span className="font-semibold tabular-nums">{lap.lap.time}</span>{" "}
                  <span className="text-zinc-400">
                    · {driver(lap.lap)}, {lap.race.year}
                  </span>
                </>
              ) : (
                "—"
              )}
            </Fact>
            <Fact label="Pole record" title={pole ? `Fastest pole lap on this layout${sameLayout}` : undefined}>
              {pole ? (
                <>
                  <span className="font-semibold tabular-nums">{pole.lap.time}</span>{" "}
                  <span className="text-zinc-400">
                    · {driver(pole.lap)}, {pole.race.year}
                  </span>
                </>
              ) : (
                "—"
              )}
            </Fact>
            <Fact label="Most wins" title="Grand Prix wins here, most first">
              {wins.length ? wins.map((w) => `${h.drivers[w.id]?.lastName ?? w.id} ${w.count}`).join(" · ") : "—"}
            </Fact>
            <Fact label={`Pole to win since ${since}`} title="How often the pole sitter won">
              {conversion.races ? (
                <>
                  <span className="font-semibold tabular-nums">
                    {conversion.wins} of {conversion.races}
                  </span>
                  <span className="text-zinc-400"> races</span>
                </>
              ) : (
                "—"
              )}
            </Fact>
          </dl>

          {recent.length > 0 && (
            <div className="mt-6">
              {/* On a phone: year, winner and pole. */}
              <table className="w-full text-left text-sm">
                <caption className={`${LABEL} px-3 pb-2 text-left`}>Last {recent.length} Grands Prix here</caption>
                <thead>
                  <tr className={`${LABEL} border-b border-zinc-800`}>
                    <th className="w-16 px-3 py-2 font-[inherit]">Year</th>
                    <th className="px-3 py-2 font-[inherit]">Winner</th>
                    <th className="px-3 py-2 font-[inherit]">Pole</th>
                    <th className="hidden px-3 py-2 font-[inherit] md:table-cell">Podium</th>
                    <th className="hidden px-3 py-2 font-[inherit] md:table-cell">Fastest lap</th>
                  </tr>
                </thead>
                <tbody>
                  {recent.map((r) => {
                    const winner = r.podium[0];
                    return (
                      <tr key={r.raceId} className="border-b border-zinc-800/70">
                        <td className="px-3 py-2 tabular-nums text-zinc-400" title={r.grandPrix}>
                          {r.year}
                        </td>
                        <td className="px-3 py-2">
                          <span className="font-semibold text-zinc-50">{driver(winner)}</span>
                          <span className="hidden text-zinc-400 sm:inline"> · {team(winner)}</span>
                        </td>
                        <td className="px-3 py-2 text-zinc-200">{driver(r.pole)}</td>
                        <td className="hidden px-3 py-2 text-zinc-300 md:table-cell">
                          {r.podium
                            .slice(1)
                            .map((p) => h.drivers[p.driverId]?.lastName ?? p.driverId)
                            .join(", ")}
                        </td>
                        <td className="hidden px-3 py-2 text-zinc-300 md:table-cell">
                          {r.fastestLap ? (
                            <>
                              {h.drivers[r.fastestLap.driverId]?.lastName ?? r.fastestLap.driverId}
                              {r.fastestLap.time && <span className="tabular-nums text-zinc-400"> {r.fastestLap.time}</span>}
                            </>
                          ) : (
                            "—"
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
      <p className="mt-3 px-3 text-xs text-zinc-400">
        {circuit.fullName} · {TYPE[circuit.type]}, {circuit.lengthKm.toFixed(3)} km, {circuit.turns} turns · {circuit.racesHeld} Grands Prix. History from{" "}
        <a
          href={h.source.url}
          target="_blank"
          rel="noreferrer"
          className={`rounded-sm text-zinc-300 underline decoration-zinc-600 underline-offset-2 hover:text-zinc-100 ${FOCUS}`}
        >
          F1DB
        </a>{" "}
        (
        <a
          href={h.source.licenseUrl}
          target="_blank"
          rel="noreferrer"
          className={`rounded-sm underline decoration-zinc-600 underline-offset-2 hover:text-zinc-200 ${FOCUS}`}
        >
          {h.source.license}
        </a>
        ), {h.source.release}.
      </p>
    </section>
  );
}

/**
 * The circuit widgets (the widget picker's Circuit tab), here for this circuit with no session: the races OpenF1 has
 * here since 2023, as on a dashboard. Framed and divided by hairlines, as the replay grid's widgets are.
 */
function PastRaces({ slug }: { slug: string }) {
  const scope = useMemo(() => ({ slug }), [slug]);
  const safetyCars = BUILTIN_WIDGETS.get("safety-cars")!;
  const strategies = BUILTIN_WIDGETS.get("strategy-history")!;
  return (
    <section aria-label="Earlier races" className="mt-8 grid grid-cols-1 border-l border-t border-zinc-800 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
      <WidgetHost widget={safetyCars} circuit={scope} className="border-b border-r border-zinc-800" style={{ height: safetyCars.height as number }} />
      <WidgetHost widget={strategies} circuit={scope} className="border-b border-r border-zinc-800" style={{ height: 300 }} />
    </section>
  );
}

export function CircuitPage({ slug }: { slug: string }) {
  const years = useLibrary((s) => s.years);
  useEffect(() => {
    // Every season OpenF1 has: the circuit's weekends are spread over them (cached calendars first, as Home's).
    for (const y of YEARS) void useLibrary.getState().loadYear(y);
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  }, []);
  const rows = useMemo(
    () =>
      rowsAt(
        slug,
        YEARS.map((y) => years[y]?.catalog),
      ),
    [slug, years],
  );
  const meetings = useMemo(() => byMeeting(rows, "all"), [rows]);
  const loading = YEARS.some((y) => !years[y]?.catalog && !years[y]?.error);
  const failed = YEARS.filter((y) => years[y]?.error && !years[y]?.catalog);
  const latest = rows.at(-1);
  const circuitKey = [...rows].reverse().find((r) => r.circuitKey != null)?.circuitKey ?? null;
  const history = useCircuitHistory(circuitKey);
  // The name OpenF1 gives it, and what F1DB calls it (Sepang's "Kuala Lumpur" is "Sepang International Circuit").
  const name = latest?.circuit ?? slug;
  const gps = [...new Set(meetings.map((m) => shortGp(m.name)))];

  let sessions;
  if (rows.length) sessions = <WeekendSheet meetings={meetings} filter="all" lead="year" label={`Weekends at ${name}`} />;
  else if (loading) sessions = <p className="border-y border-zinc-800 px-3 py-4 text-sm text-zinc-400">Loading the seasons from OpenF1…</p>;
  else
    sessions = (
      <div className="border-y border-zinc-800 px-3 py-4 text-sm text-zinc-400">
        <p>OpenF1 has no sessions at a circuit called “{slug}”.</p>
      </div>
    );

  return (
    <div className="flex h-full flex-col">
      <div className="h-[env(safe-area-inset-top)] shrink-0 bg-zinc-950" aria-hidden />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <header className="sticky top-0 z-20 border-b border-zinc-800 bg-zinc-950">
          <div className="mx-auto flex h-[52px] max-w-6xl items-center gap-3 px-4 md:px-6">
            <RacesButton />
            <span className="flex-1" />
            <Settings />
          </div>
        </header>

        <main className="mx-auto max-w-6xl px-4 pb-16 pt-8 md:px-6">
          <h1 className="flex items-center gap-3 text-3xl font-bold tracking-tight text-zinc-50">
            {latest && <Flag country={latest.country} className="h-6" />}
            {name}
          </h1>
          <p className="mt-1 text-sm text-zinc-400">
            {[history?.circuit.fullName !== name ? history?.circuit.fullName : null, latest?.country, gps.length ? gps.join(" · ") : null]
              .filter(Boolean)
              .join(" · ")}
          </p>
          <PastRaces slug={slug} />
          {history && <History h={history} slug={slug} />}

          <section data-shot="" aria-labelledby="weekends-title" className="mt-12">
            <h2 id="weekends-title" className="mb-3 text-2xl font-bold tracking-tight text-zinc-50">
              Sessions here
            </h2>
            {failed.length > 0 && (
              <p className="mb-2 flex flex-wrap items-center gap-3 text-xs text-amber-300">
                Couldn't load {failed.join(", ")} from OpenF1.
                <button onClick={() => failed.forEach((y) => void useLibrary.getState().loadYear(y, { force: true }))} className={SECONDARY}>
                  Try again
                </button>
              </p>
            )}
            {sessions}
          </section>
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
