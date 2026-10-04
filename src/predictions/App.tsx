// Called It's page (/predictions), in Pitwall's look (DESIGN.md): its header over the one thing it does, a call on
// the race made into a card to post (Compose). The card is the one thing in its own broadcast style: it's the picture
// people post. A static page like the rest of the site: nothing leaves the browser.

import { useEffect, useState } from "react";
import { LABEL } from "../components/controls";
import { Logo } from "../components/Logo";
import { Compose } from "./Compose";
import { span } from "./format";
import { closes, nextRace, topFive } from "./model";

export function useNow(every = 30_000) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), every);
    return () => clearInterval(t);
  }, [every]);
  return now;
}

export function App() {
  return (
    <div className="flex min-h-full flex-col">
      <header className="sticky top-0 z-20 border-b border-zinc-800 bg-zinc-950 pt-[env(safe-area-inset-top)]">
        <div className="mx-auto grid h-[52px] max-w-6xl grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-6 px-4 sm:px-6">
          <a href="/" className="text-zinc-100" aria-label="Pitwall">
            <Logo className="h-6 w-auto" />
          </a>
          {/* Its column stays when a phone hides it (as on Home). */}
          <div className="flex min-w-0 justify-center">
            <div className="hidden min-w-0 sm:block">
              <Moment />
            </div>
          </div>
          <div />
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 pb-16 pt-6 sm:px-6">
        <Compose />
      </main>
    </div>
  );
}

/** The header's centre, as on Home: the race calls are open for, over its countdown to when they close. */
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
            Locks in <span className="font-bold text-zinc-50">{span(closes(race) - now)}</span>
          </>
        ) : (
          "Opens after qualifying"
        )}
      </span>
    </div>
  );
}
