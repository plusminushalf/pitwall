// The way to Called It (/predictions) from the replay app: while calls for the next race are open (after its
// qualifying, until lights out), a strip across the top of Home, or a button on a phone's screen.

import { useEffect, useState } from "react";
import { openRace, type Race } from "../predictions/model";

/** The race calls are open for now, or null; checked again every minute. */
function useOpenRace(): Race | null {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  return openRace(now);
}

export function CallBanner() {
  const race = useOpenRace();
  if (!race) return null;
  return (
    <a href="/predictions" className="group block bg-[#e7000b] text-white transition-colors hover:bg-[#fb2c36]">
      <div className="mx-auto flex h-9 max-w-6xl items-center justify-center gap-2 px-6 text-sm">
        <span className="font-semibold uppercase tracking-wider text-white/80">{race.short}</span>
        <span className="text-white/50">·</span>
        <span className="font-bold">Call your Turn 1 leader here</span>
        <span aria-hidden className="transition-transform group-hover:translate-x-0.5">
          →
        </span>
      </div>
    </a>
  );
}

export function CallButton() {
  const race = useOpenRace();
  if (!race) return null;
  return (
    <a href="/predictions" className="mt-8 block rounded bg-[#e7000b] px-4 py-3 text-base font-bold text-white transition-colors hover:bg-[#fb2c36]">
      {race.short}: call your Turn 1 leader here →
    </a>
  );
}
