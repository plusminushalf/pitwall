// Called It's page, in Pitwall's look (DESIGN.md): its header, then /predictions makes a call (who leads into Turn 1
// at the next race) and /predictions/<id> is one (worker/index.ts serves both). The card is the one thing in its
// own broadcast style: it's the picture people post.

import { useEffect, useState } from "react";
import { LABEL, SECONDARY } from "../components/controls";
import { Logo } from "../components/Logo";
import { Compose } from "./Compose";
import { span } from "./format";
import { ID_PATTERN, nextRace, predictionPath, topFive, type Prediction } from "./model";
import { Permalink } from "./Permalink";

const idIn = (path: string) => {
  const id = /^\/predictions\/([^/]+)\/?$/.exec(path)?.[1];
  return id && ID_PATTERN.test(id) ? id : id ? "missing" : null;
};

export function useNow(every = 30_000) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), every);
    return () => clearInterval(t);
  }, [every]);
  return now;
}

export function App() {
  const [path, setPath] = useState(location.pathname);
  // The call just locked in this tab: shown at once, with its "Locked in" moment.
  const [fresh, setFresh] = useState<Prediction | null>(null);
  useEffect(() => {
    const pop = () => {
      setFresh(null);
      setPath(location.pathname);
    };
    addEventListener("popstate", pop);
    return () => removeEventListener("popstate", pop);
  }, []);
  const go = (to: string, p: Prediction | null = null) => {
    history.pushState(null, "", to);
    setFresh(p);
    setPath(to);
    scrollTo({ top: 0 });
  };
  const id = idIn(path);

  return (
    <div className="flex min-h-full flex-col">
      <header className="sticky top-0 z-20 border-b border-zinc-800 bg-zinc-950 pt-[env(safe-area-inset-top)]">
        <div className="mx-auto grid h-[52px] max-w-6xl grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-6 px-4 sm:px-6">
          <a href="/" className="text-zinc-100" aria-label="Pitwall">
            <Logo className="h-6 w-auto" />
          </a>
          {/* Its column stays when a phone hides it, so the button stays right (as on Home). */}
          <div className="flex min-w-0 justify-center">
            <div className="hidden min-w-0 sm:block">
              <Moment />
            </div>
          </div>
          <div className="flex justify-end">
            {id && (
              <button type="button" onClick={() => go("/predictions")} className={SECONDARY}>
                Make a call
              </button>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 pb-16 pt-6 sm:px-6">
        {id ? <Permalink key={id} id={id} fresh={fresh?.id === id ? fresh : null} onNew={() => go("/predictions")} /> : <Compose onLocked={(p) => go(predictionPath(p.id), p)} />}
      </main>
    </div>
  );
}

/** The header's centre, as on Home: the race calls are open for, over its countdown to lights out. */
function Moment() {
  const now = useNow();
  const race = nextRace(now);
  if (!race) return <div />;
  const open = topFive(race.id).length > 0;
  return (
    <div className="flex min-w-0 flex-col items-center leading-tight">
      <span className={`${LABEL} truncate`}>Called it · {race.short}</span>
      <span className="truncate text-sm tabular-nums text-zinc-100">
        {open ? (
          <>
            Locks in <span className="font-bold text-zinc-50">{span(race.start - now)}</span>
          </>
        ) : (
          "Opens after qualifying"
        )}
      </span>
    </div>
  );
}
