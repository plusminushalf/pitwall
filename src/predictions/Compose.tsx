// The page's one job: who leads into Turn 1 at the next race, from the top five on its starting grid, picked from a
// timing list like Home's rows. The card fills in as you pick; Lock it in keeps the call in this browser (saved.ts),
// one per race, and the card stops at its time to go. Then post it: a phone shares the card itself, a computer copies
// it and the text. The post's own time is the proof. Before qualifying and after lights out there's nothing to pick.

import { useEffect, useRef, useState } from "react";
import { LABEL, PRIMARY, SECONDARY } from "../components/controls";
import { useNow } from "./App";
import { ScaledCard } from "./Card";
import { DriverList } from "./DriverList";
import { lead, localTz, stamp } from "./format";
import { canShareImage, cardPng, copy, copyImage, shareImage } from "./image";
import { driverIn, nextRace, openRace } from "./model";
import { readCalls, saveCall } from "./saved";

export function Compose() {
  const now = useNow();
  const race = openRace(now);
  const [chosen, setChosen] = useState<number | null>(null);
  const [calls, setCalls] = useState(readCalls);
  const [toast, setToast] = useState<string | null>(null);
  const [phone] = useState(canShareImage);
  const cardRef = useRef<HTMLDivElement>(null);
  const tz = localTz();

  // This browser's call for the race, once locked: it can't change, and the card keeps its time.
  // One for a driver a grid penalty has since moved out of the five doesn't count: pick again.
  const stored = race ? calls[race.id] : undefined;
  const saved = race && stored && driverIn(race.id, stored.driver) ? stored : undefined;
  const pick = saved?.driver ?? chosen;
  const driver = race && pick != null && driverIn(race.id, pick) ? pick : null;
  const at = saved?.at ?? now;
  const toGo = race ? lead(race.start - at) : "";

  // The locked card's PNG is made ahead, so the tap that shares or copies it still counts.
  const png = useRef<Promise<Blob> | null>(null);
  const [blob, setBlob] = useState<Blob | null>(null);
  useEffect(() => {
    png.current = null;
    setBlob(null);
    if (!saved) return;
    let live = true;
    const t = setTimeout(() => {
      if (!cardRef.current) return;
      png.current = cardPng(cardRef.current);
      png.current.then((b) => live && setBlob(b)).catch(() => (png.current = null));
    }, 300);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [saved]);
  const image = () => (png.current ??= cardPng(cardRef.current!));

  if (!race) {
    const next = nextRace(now);
    return (
      <div className="max-w-[75ch]">
        <Intro />
        <p className="mt-6 border-y border-zinc-800 px-4 py-3 text-sm text-zinc-300">
          {next ? `Calls for the ${next.name} open once qualifying is done.` : "That's the season. Calls open again next year."}
        </p>
      </div>
    );
  }

  const say = (s: string) => {
    setToast(s);
    setTimeout(() => setToast((t) => (t === s ? null : t)), 2400);
  };
  const lights = stamp(race.start, tz);
  const lock = () => {
    if (driver == null || saved) return;
    setCalls(saveCall(race.id, { driver, at: Date.now() }));
  };
  const lockButton = (wide: boolean) => (
    <button type="button" disabled={driver == null} onClick={lock} className={`${PRIMARY} ${wide ? "h-11 w-full text-sm" : "px-4 py-2 text-sm"}`}>
      {name ? `Lock in ${name}` : "Pick a driver"}
    </button>
  );
  const name = driver != null ? driverIn(race.id, driver)?.last : null;
  // The text to post with the card, a line each: the call, how early, then the tags and where to make one.
  const caption = [`My call: ${name} leads into Turn 1.`, `Called with ${toGo} to go.`, "", `#F1 #${race.short.replace(/\W/g, "")}`, `${location.origin}/predictions`].join("\n");

  const shareButton = (
    <button
      type="button"
      disabled={!blob}
      className={`${PRIMARY} flex h-11 w-full items-center justify-center gap-2 text-sm`}
      onClick={async () => {
        if (!blob) return;
        if ((await shareImage(blob, caption, `called-it-${race.short.toLowerCase().replace(/\W+/g, "-")}.png`)) === "failed") say("Couldn't share it. Try again.");
      }}
    >
      <svg viewBox="0 0 24 24" className="size-4 fill-none stroke-current stroke-2" aria-hidden>
        <path d="M12 3v12M7 8l5-5 5 5M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {blob ? "Share" : "Getting it ready…"}
    </button>
  );

  return (
    <div className={`grid gap-8 lg:grid-cols-[minmax(0,1fr)_320px] lg:gap-12 ${phone ? "pb-28" : ""}`}>
      <div className="min-w-0">
        <Intro />

        <section aria-label="The top five on the grid" className="mt-8">
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <h2 className="text-2xl font-bold tracking-tight text-zinc-50">{race.name}</h2>
            <span className="text-xs tabular-nums text-zinc-400">
              Lights out {lights.date.replace(/ \d{4}$/, "")}, {lights.time} {lights.zone}
            </span>
          </div>
          <DriverList race={race.id} value={driver} onChange={setChosen} label="Who leads into Turn 1" locked={!!saved} />
          <p className="mt-3 px-3 text-xs text-zinc-400">
            {saved ? `Your call: ${name}, locked with ${toGo} to go. One call per race.` : "The top five on the starting grid, after penalties. It's whoever's ahead coming out of Turn 1."}
          </p>
        </section>

        {!phone && !saved && (
          <div className="mt-6 flex items-center gap-4 px-3">
            {lockButton(false)}
            <span className="text-xs text-zinc-400">One call per race: once it's locked, it stays.</span>
          </div>
        )}

        {!phone && saved && (
          <section aria-label="Post it" className="mt-6 border-y border-zinc-800 px-3 py-3">
            <div className={LABEL}>Text to post</div>
            <p className="mt-1.5 select-all whitespace-pre-wrap break-words text-sm text-zinc-100">{caption}</p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                type="button"
                className={PRIMARY}
                onClick={async () => {
                  try {
                    say((await copyImage(image)) ? "Card copied. Paste it into your post." : "This browser can't copy images.");
                  } catch {
                    png.current = null;
                    say("Couldn't copy the card. Try again.");
                  }
                }}
              >
                Copy image
              </button>
              <button
                type="button"
                className={SECONDARY}
                onClick={async () => {
                  await copy(caption);
                  say("Text copied");
                }}
              >
                Copy text
              </button>
              <span aria-live="polite" className="text-xs text-zinc-300">
                {toast}
              </span>
            </div>
          </section>
        )}
      </div>

      <div className="lg:sticky lg:top-[76px] lg:self-start">
        <ScaledCard race={race} call={{ kind: "turn1-leader", driver }} at={at} host={location.host} tz={tz} cardRef={cardRef} className="mx-auto max-w-[280px] rounded-md border border-zinc-800 lg:max-w-none" />
      </div>

      {/* A phone locks and shares from a bar at the bottom of the screen. */}
      {phone && (
        <div className="fixed inset-x-0 bottom-0 z-20 border-t border-zinc-800 bg-zinc-950 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3">
          {saved ? shareButton : lockButton(true)}
          <p aria-live="polite" className="mt-2 h-4 text-center text-xs text-zinc-400">
            {toast ?? (saved ? "Post it before lights out: your post's time is the proof." : "One call per race: once it's locked, it stays.")}
          </p>
        </div>
      )}
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
