// Making a call: who leads into Turn 1 at the next race, from the top five in its qualifying, picked from a timing
// list like Home's rows. The card fills in as you pick; Lock it in (the page's one white button) stores it with the
// server's time, for good. Before qualifying there's nothing to pick.

import { useState } from "react";
import { PRIMARY } from "../components/controls";
import { ApiError, lockPrediction } from "./api";
import { useNow } from "./App";
import { ScaledCard } from "./Card";
import { DriverList } from "./DriverList";
import { localTz, stamp } from "./format";
import { driverIn, lockProblem, nextRace, topFive, type Prediction } from "./model";

export function Compose({ onLocked }: { onLocked: (p: Prediction) => void }) {
  const now = useNow();
  const race = nextRace(now);
  const [chosen, setChosen] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tz = localTz();

  if (!race || !topFive(race.id).length)
    return (
      <div className="max-w-[75ch]">
        <Intro />
        <p className="mt-6 border-y border-zinc-800 px-4 py-3 text-sm text-zinc-300">
          {race ? `Calls for the ${race.name} open once qualifying is done.` : "That's the season. Calls open again next year."}
        </p>
      </div>
    );

  const driver = chosen != null && driverIn(race.id, chosen) ? chosen : null;
  const call = { kind: "turn1-leader" as const, driver };
  const problem = lockProblem({ race: race.id, call }, now);
  const lights = stamp(race.start, tz);
  const name = driver != null ? driverIn(race.id, driver)?.last : null;

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
  const note = error ?? (name ? "Once it's locked, nobody can change it, not even you." : "Pick a driver.");

  return (
    <div className="grid gap-8 pb-24 lg:grid-cols-[minmax(0,1fr)_320px] lg:gap-12 lg:pb-0">
      <div className="min-w-0">
        <Intro />

        <section aria-label="The top five from qualifying" className="mt-8">
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <h2 className="text-2xl font-bold tracking-tight text-zinc-50">{race.name}</h2>
            <span className="text-xs tabular-nums text-zinc-400">
              Lights out {lights.date.replace(/ \d{4}$/, "")}, {lights.time} {lights.zone}
            </span>
          </div>
          <DriverList race={race.id} value={driver} onChange={setChosen} label="Who leads into Turn 1" />
          <p className="mt-3 px-3 text-xs text-zinc-400">The top five from qualifying. It's whoever's ahead coming out of Turn 1.</p>
        </section>

        <div className="mt-6 hidden items-center gap-4 px-3 lg:flex">
          <button type="button" onClick={lock} disabled={!!problem || busy} className={`${PRIMARY} px-4 py-2 text-sm`}>
            {busy ? "Locking…" : name ? `Lock in ${name}` : "Lock it in"}
          </button>
          <span className={`text-xs ${error ? "text-red-400" : "text-zinc-400"}`}>{note}</span>
        </div>
      </div>

      <div className="lg:sticky lg:top-[76px] lg:self-start">
        <ScaledCard race={race} call={call} host={location.host} tz={tz} className="mx-auto max-w-[280px] rounded-md border border-zinc-800 lg:max-w-none" />
      </div>

      {/* On a phone, the button stays at the bottom of the screen. */}
      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-zinc-800 bg-zinc-950 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 lg:hidden">
        <button type="button" onClick={lock} disabled={!!problem || busy} className={`${PRIMARY} h-11 w-full text-sm`}>
          {busy ? "Locking…" : name ? `Lock in ${name}` : "Lock it in"}
        </button>
        <p className={`mt-2 text-center text-xs ${error ? "text-red-400" : "text-zinc-400"}`}>{note}</p>
      </div>
    </div>
  );
}

function Intro() {
  return (
    <div>
      <h1 className="text-2xl font-bold tracking-tight text-zinc-50">Who leads into Turn 1?</h1>
      <p className="mt-2 max-w-[75ch] text-sm leading-relaxed text-zinc-400">Call it before lights out.</p>
    </div>
  );
}
