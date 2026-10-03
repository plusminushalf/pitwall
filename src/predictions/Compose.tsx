// Making a call: a race, three teams, the order they'll pit, a hook; the card fills in as you go. Lock it in and
// it's stored with the server's time, for good.

import { useEffect, useState } from "react";
import { ApiError, lockPrediction } from "./api";
import { ScaledCard } from "./Card";
import { hookIdeas, localTz, span, stamp } from "./format";
import { HOOK_MAX, hookLength, lockProblem, openRaces, TEAMS, type Prediction, type TeamId } from "./model";
import { RankList } from "./RankList";

export function Compose({ hero, onLocked }: { hero: React.ReactNode; onLocked: (p: Prediction) => void }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  const races = openRaces(now);
  const [raceId, setRaceId] = useState(() => races[0]?.id ?? 0);
  const race = races.find((r) => r.id === raceId) ?? races[0];
  const [teams, setTeams] = useState<TeamId[]>([]);
  const [hook, setHook] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tz = localTz();

  if (!race)
    return (
      <Section>
        {hero}
        <p className="mt-8 text-zinc-400">That's the season. Calls open again for the first race of next year.</p>
      </Section>
    );

  const toggle = (id: TeamId) => setTeams((ts) => (ts.includes(id) ? ts.filter((t) => t !== id) : ts.length < 3 ? [...ts, id] : ts));
  const problem = lockProblem({ race: race.id, teams, hook }, now);
  const lights = stamp(race.start, tz);

  const lock = async () => {
    if (problem || busy) return;
    setBusy(true);
    setError(null);
    try {
      onLocked(await lockPrediction({ race: race.id, teams, hook, tz }));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Something went wrong. Try again.");
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_380px] lg:gap-14">
      <div className="flex min-w-0 flex-col gap-9">
        {hero}
        <Step n={1} title="The race">
          <div className="relative">
            <select
              value={race.id}
              onChange={(e) => setRaceId(Number(e.target.value))}
              className="ci-display h-14 w-full appearance-none rounded-md border border-zinc-800 bg-zinc-900 pl-4 pr-10 text-2xl font-extrabold uppercase italic text-white focus:border-zinc-500"
            >
              {races.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
            <svg viewBox="0 0 20 20" className="pointer-events-none absolute right-3 top-1/2 size-5 -translate-y-1/2 fill-none stroke-zinc-400 stroke-2">
              <path d="M5 8l5 5 5-5" />
            </svg>
          </div>
          <p className="mt-2 text-sm text-zinc-400">
            Locks at lights out: {lights.date.replace(/ \d{4}$/, "")}, {lights.time} {lights.zone} ·{" "}
            <span className="text-zinc-200">in {span(race.start - now)}</span>
          </p>
        </Step>

        <Step n={2} title="Pick three teams" aside={`${teams.length}/3`}>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {TEAMS.map((t) => {
              const at = teams.indexOf(t.id);
              const full = at < 0 && teams.length === 3;
              return (
                <button
                  key={t.id}
                  type="button"
                  aria-pressed={at >= 0}
                  onClick={() => toggle(t.id)}
                  className={`group relative flex h-12 items-center gap-3 overflow-hidden rounded-md border pr-3 text-left transition-colors ${
                    at >= 0 ? "border-zinc-400 bg-zinc-800" : full ? "border-zinc-900 bg-zinc-950 opacity-40" : "border-zinc-800 bg-zinc-900 hover:border-zinc-600"
                  }`}
                >
                  <span className="h-full w-1.5 flex-none transition-[width]" style={{ background: t.colour, width: at >= 0 ? 10 : undefined }} />
                  <span className="ci-display min-w-0 flex-1 truncate text-lg font-bold uppercase italic leading-none text-zinc-100">{t.name}</span>
                  {at >= 0 && <span className="ci-display flex size-6 flex-none items-center justify-center rounded-sm bg-white text-sm font-black italic text-zinc-950">{at + 1}</span>}
                </button>
              );
            })}
          </div>
        </Step>

        <Step n={3} title="Who pits first?">
          {teams.length ? (
            <>
              <RankList teams={teams} onChange={setTeams} label={(i) => ["pits first", "pits second", "pits third"][i]!} />
              <p className="mt-2 text-sm text-zinc-500">Drag to reorder. A team's first stop counts, whichever car makes it.</p>
            </>
          ) : (
            <p className="rounded-md border border-dashed border-zinc-800 px-4 py-5 text-sm text-zinc-500">Pick your teams first. The order you tap them is your starting order.</p>
          )}
        </Step>

        <Step n={4} title="Your hook" aside={`${hookLength(hook)}/${HOOK_MAX}`}>
          <input
            value={hook}
            onChange={(e) => setHook([...e.target.value].slice(0, HOOK_MAX).join(""))}
            placeholder="The bold claim at the top of your card"
            enterKeyHint="done"
            className="ci-display h-14 w-full rounded-md border border-zinc-800 bg-zinc-900 px-4 text-xl font-bold uppercase italic text-white placeholder:normal-case placeholder:not-italic placeholder:font-medium placeholder:text-lg placeholder:text-zinc-600 focus:border-zinc-500"
          />
          <div className="mt-3 flex flex-wrap gap-2">
            {hookIdeas(teams).map((idea) => (
              <button
                key={idea}
                type="button"
                onClick={() => setHook(idea)}
                className={`rounded-full border px-3 py-1.5 text-sm transition-colors ${hook === idea ? "border-white bg-white text-zinc-950" : "border-zinc-800 bg-zinc-900 text-zinc-300 hover:border-zinc-600 hover:text-white"}`}
              >
                {idea}
              </button>
            ))}
          </div>
        </Step>
      </div>

      <div className="lg:sticky lg:top-6 lg:self-start">
        <div className="mx-auto max-w-[380px]">
          <ScaledCard race={race} teams={teams} hook={hook} host={location.host} tz={tz} className="rounded-xl shadow-2xl shadow-black ring-1 ring-white/10" />
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
            {error ?? (problem && problem !== "Write your hook" && teams.length ? problem : "Once it's locked, nobody can change it. Not even you.")}
          </p>
        </div>
      </div>
    </div>
  );
}

function Step({ n, title, aside, children }: { n: number; title: string; aside?: string; children: React.ReactNode }) {
  return (
    <section>
      <div className="mb-3 flex items-baseline gap-3">
        <span className="ci-display text-lg font-black italic text-[#ff1e28]">0{n}</span>
        <h2 className="ci-display text-xl font-extrabold uppercase tracking-wider text-white">{title}</h2>
        {aside && <span className="ml-auto text-sm tabular-nums text-zinc-500">{aside}</span>}
      </div>
      {children}
    </section>
  );
}

function Section({ children }: { children: React.ReactNode }) {
  return <div className="py-10">{children}</div>;
}
