// Making a call: who leads lap 1 of the next race, from the top five in its qualifying. The card fills in as you
// pick; lock it in and it's stored with the server's time, for good. Before qualifying, there's nothing to pick.

import { useEffect, useState } from "react";
import { ApiError, lockPrediction } from "./api";
import { ScaledCard } from "./Card";
import { localTz, span, stamp } from "./format";
import { driverIn, lockProblem, nextRace, team, topFive, type Prediction } from "./model";

export function Compose({ hero, onLocked }: { hero: React.ReactNode; onLocked: (p: Prediction) => void }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  const race = nextRace(now);
  const [chosen, setChosen] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tz = localTz();

  if (!race || !topFive(race.id).length)
    return (
      <div className="flex flex-col gap-8">
        {hero}
        <p className="max-w-xl rounded-lg border border-zinc-800 bg-zinc-900/60 p-5 text-zinc-300">
          {race ? `Calls for the ${race.name} open once qualifying is done. Come back then.` : "That's the season. Calls open again next year."}
        </p>
      </div>
    );

  const driver = chosen != null && driverIn(race.id, chosen) ? chosen : null;
  const call = { kind: "lap1-leader" as const, driver };
  const problem = lockProblem({ race: race.id, call }, now);
  const lights = stamp(race.start, tz);

  const lock = async () => {
    if (problem || busy) return;
    setBusy(true);
    setError(null);
    try {
      onLocked(await lockPrediction({ race: race.id, call, tz }));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Something went wrong. Try again.");
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_380px] lg:gap-14">
      <div className="flex min-w-0 flex-col gap-8">
        {hero}
        <section>
          <div className="mb-1 flex items-baseline gap-3">
            <h2 className="ci-display text-3xl font-black uppercase italic text-white">{race.name}</h2>
          </div>
          <p className="mb-5 text-sm text-zinc-400">
            Locks at lights out: {lights.date.replace(/ \d{4}$/, "")}, {lights.time} {lights.zone} · <span className="text-zinc-200">in {span(race.start - now)}</span>
          </p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {topFive(race.id).map((d) => {
              const t = team(d.team);
              const on = driver === d.number;
              return (
                <button
                  key={d.number}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setChosen(d.number)}
                  className={`relative flex h-[4.5rem] items-stretch overflow-hidden rounded-md border text-left transition-colors ${on ? "border-white bg-zinc-800" : "border-zinc-800 bg-zinc-900 hover:border-zinc-600"}`}
                >
                  <span className="flex-none transition-[width]" style={{ background: t.colour, width: on ? 10 : 6 }} />
                  <span className="ci-display flex w-12 flex-none items-center justify-center text-2xl font-black italic text-zinc-500">P{d.quali}</span>
                  <span className="flex min-w-0 flex-1 flex-col justify-center pr-3">
                    <span className="ci-display truncate text-2xl font-black uppercase italic leading-tight text-white">{d.last}</span>
                    <span className="text-xs font-semibold uppercase tracking-wider text-zinc-400">{t.name}</span>
                  </span>
                  <span className="ci-display absolute -bottom-3 right-2 text-6xl font-black italic text-white/[0.07]">{d.number}</span>
                </button>
              );
            })}
          </div>
          <p className="mt-3 text-sm text-zinc-500">The top five from qualifying. Whoever's ahead when lap 1 is done.</p>
        </section>
      </div>

      <div className="lg:sticky lg:top-6 lg:self-start">
        <div className="mx-auto max-w-[380px]">
          <ScaledCard race={race} call={call} host={location.host} tz={tz} className="rounded-xl shadow-2xl shadow-black ring-1 ring-white/10" />
          <button
            type="button"
            onClick={lock}
            disabled={!!problem || busy}
            className="ci-display mt-5 flex h-16 w-full items-center justify-center gap-3 rounded-md bg-[#ff1e28] text-3xl font-black uppercase italic tracking-wide text-white shadow-lg shadow-red-950/50 transition hover:bg-[#ff3a43] active:scale-[0.99] disabled:bg-zinc-800 disabled:text-zinc-500 disabled:shadow-none"
          >
            <svg viewBox="0 0 24 24" className="size-6 fill-none stroke-current stroke-[2.5]">
              <rect x="5" y="11" width="14" height="10" rx="2" />
              <path d="M8 11V8a4 4 0 0 1 8 0v3" />
            </svg>
            {busy ? "Locking…" : "Lock it in"}
          </button>
          <p className={`mt-3 text-center text-sm ${error ? "text-[#ff6467]" : "text-zinc-500"}`}>
            {error ?? (driver == null ? "Pick a driver." : "Once it's locked, nobody can change it. Not even you.")}
          </p>
        </div>
      </div>
    </div>
  );
}
