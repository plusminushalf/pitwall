// A call's link: the locked card for anyone, and for its caller (who has its token) the reveal once lights are out.
// Called right, it's the trophy (CALLED IT); wrong, it fades quietly, with nothing to share.

import { useEffect, useRef, useState } from "react";
import { LABEL, PRIMARY, SECONDARY } from "../components/controls";
import { adoptTokenFromHash, ApiError, getPrediction, revealLink, revealPrediction, tokenFor } from "./api";
import { ScaledCard } from "./Card";
import { DriverList } from "./DriverList";
import { lead, span, stamp } from "./format";
import { canShareImage, cardPng, copy, copyImage, shareImage } from "./image";
import { calledIt, driverIn, raceById, SOMEONE_ELSE, type Prediction } from "./model";

type Load = { state: "loading" } | { state: "missing" } | { state: "error"; message: string } | { state: "ready"; p: Prediction };

export function Permalink({ id, fresh, onNew }: { id: string; fresh: Prediction | null; onNew: () => void }) {
  const [load, setLoad] = useState<Load>(fresh ? { state: "ready", p: fresh } : { state: "loading" });
  useEffect(() => {
    adoptTokenFromHash(id);
    if (fresh) return;
    getPrediction(id)
      .then((p) => setLoad({ state: "ready", p }))
      .catch((e) => setLoad(e instanceof ApiError && e.status === 404 ? { state: "missing" } : { state: "error", message: e.message }));
  }, [id, fresh]);

  if (load.state === "loading") return <div className="aspect-[9/16] w-full max-w-[320px] animate-pulse rounded-md bg-zinc-900" />;
  if (load.state !== "ready")
    return (
      <div className="max-w-[75ch]">
        <h1 className="text-2xl font-bold tracking-tight text-zinc-50">{load.state === "missing" ? "No call here" : "Couldn't load it"}</h1>
        <p className="mt-2 text-sm text-zinc-400">{load.state === "missing" ? "Check the link, or make a call of your own." : load.message}</p>
        <button type="button" onClick={onNew} className={`${PRIMARY} mt-6 px-4 py-2 text-sm`}>
          Make a call
        </button>
      </div>
    );
  return <Locked p={load.p} justLocked={!!fresh} onRevealed={(p) => setLoad({ state: "ready", p })} />;
}

function Locked({ p, justLocked, onRevealed }: { p: Prediction; justLocked: boolean; onRevealed: (p: Prediction) => void }) {
  const race = raceById(p.race)!;
  const owner = !!tokenFor(p.id);
  const right = p.result ? calledIt(p.call, p.result) : null;
  const started = Date.now() >= race.start;
  const cardRef = useRef<HTMLDivElement>(null);
  const png = useRef<Promise<Blob> | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const url = `${location.origin}/predictions/${p.id}`;
  const shareable = right !== false;
  const when = stamp(p.lockedAt, p.tz);
  const d = driverIn(p.race, p.call.driver);

  // Phones share the card itself; elsewhere, copy the caption and the card.
  const [phone] = useState(canShareImage);
  // The PNG is made ahead, so Share and Copy image still have the tap's permission when they hand it on.
  const [blob, setBlob] = useState<Blob | null>(null);
  useEffect(() => {
    png.current = null;
    setBlob(null);
    if (!shareable) return;
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
  }, [p, shareable]);
  const image = () => (png.current ??= cardPng(cardRef.current!));

  const say = (s: string) => {
    setToast(s);
    setTimeout(() => setToast((t) => (t === s ? null : t)), 2400);
  };
  // The caption to post with the card, a line each: the call, how early, then the tags and the link.
  const caption = [
    right ? `Called it: ${d?.last} led into Turn 1.` : `My call: ${d?.last} leads into Turn 1.`,
    `Locked with ${lead(race.start - p.lockedAt)} to go.`,
    "",
    `#F1 #${race.short.replace(/\W/g, "")}`,
    url,
  ].join("\n");
  // The page's one white button: Reveal while the caller has a result to enter, else posting the card.
  const revealing = owner && !p.result && started;

  return (
    <div className="grid gap-8 lg:grid-cols-[320px_minmax(0,1fr)] lg:gap-12">
      <div className="mx-auto w-full max-w-[320px] lg:max-w-none">
        <div className={right === false ? "opacity-35 grayscale-[0.7]" : ""}>
          <ScaledCard
            race={race}
            call={p.call}
            locked={p}
            host={location.host}
            cardRef={cardRef}
            className="rounded-md border border-zinc-800"
          />
        </div>
        {shareable && phone && (
          <>
            <button
              type="button"
              disabled={!blob}
              className={`${revealing ? SECONDARY : PRIMARY} mt-4 flex h-11 w-full items-center justify-center gap-2 text-sm`}
              onClick={async () => {
                if (!blob) return;
                const r = await shareImage(blob, caption, `called-it-${p.id}.png`);
                if (r === "failed") say("Couldn't share it. Try again.");
              }}
            >
              <svg viewBox="0 0 24 24" className="size-4 fill-none stroke-current stroke-2" aria-hidden>
                <path d="M12 3v12M7 8l5-5 5 5M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              {blob ? "Share" : "Getting it ready…"}
            </button>
            <div aria-live="polite" className="mt-2 h-4 text-center text-xs text-zinc-300">
              {toast}
            </div>
          </>
        )}
      </div>

      <div className="flex min-w-0 flex-col gap-6">
        <Status p={p} owner={owner} justLocked={justLocked} started={started} when={when} />
        {shareable && !phone && (
          <section aria-label="Post it" className="border-y border-zinc-800 px-3 py-3">
            <div className={LABEL}>Text to post</div>
            <p className="mt-1.5 select-all whitespace-pre-wrap break-words text-sm text-zinc-100">{caption}</p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                type="button"
                className={revealing ? SECONDARY : PRIMARY}
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
        {owner && !p.result && started && <Reveal p={p} onRevealed={onRevealed} />}
        {owner && !p.result && (
          // Only this browser holds the call's token (api.ts); the private link carries it to another device.
          <p className="px-3 text-xs text-zinc-400">
            Revealing from another device?{" "}
            <button
              type="button"
              className="rounded-sm text-zinc-200 underline decoration-zinc-500 underline-offset-2 hover:text-white"
              onClick={async () => {
                await copy(revealLink(p.id));
                say("Private link copied. Don't post this one.");
              }}
            >
              Copy your private link
            </button>
          </p>
        )}
      </div>
    </div>
  );
}

function Status({ p, owner, justLocked, started, when }: { p: Prediction; owner: boolean; justLocked: boolean; started: boolean; when: ReturnType<typeof stamp> }) {
  const race = raceById(p.race)!;
  const right = p.result ? calledIt(p.call, p.result) : null;
  const name = driverIn(p.race, p.call.driver)?.last;
  const locked = `${when.date}, ${when.time} ${when.zone}`;
  const early = span(race.start - p.lockedAt);
  let title: string;
  let body: string;
  if (right) {
    title = owner ? "You called it" : "They called it";
    body = `${name} led into Turn 1. Locked ${locked}, ${early} before lights out. Go collect.`;
  } else if (right === false) {
    title = owner ? "Not this one" : "This call is closed";
    body = owner ? "It happens to real pit walls too. The receipt stays locked, quietly. On to the next race." : "Make your own for the next race.";
  } else if (justLocked) {
    title = "Locked in";
    body = `Stamped by our server at ${when.time} ${when.zone}, ${early} before lights out. Nobody can change it now, not even you. Post it, then come back after the start.`;
  } else if (owner) {
    title = started ? "Lights out" : "Your call is locked";
    body = started ? "Enter who led out of Turn 1." : `Locked ${locked}. Come back after the start to reveal it.`;
  } else {
    title = started ? "Lights out, result pending" : "Locked before lights out";
    body = `${name} to lead into Turn 1 at the ${race.name}. Locked ${locked}, ${early} before lights out. Can't be edited.`;
  }
  return (
    <div>
      <h1 className={`text-2xl font-bold tracking-tight ${right ? "text-emerald-400" : "text-zinc-50"}`}>{title}</h1>
      <p className="mt-2 max-w-[75ch] text-sm leading-relaxed text-zinc-400">{body}</p>
    </div>
  );
}

function Reveal({ p, onRevealed }: { p: Prediction; onRevealed: (p: Prediction) => void }) {
  const [leader, setLeader] = useState<number | null>(null);
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);

  const submit = async () => {
    if (leader == null) return;
    if (!armed) return setArmed(true);
    setBusy(true);
    setError(null);
    try {
      onRevealed(await revealPrediction(p.id, { kind: "turn1-leader", driver: leader }));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Something went wrong. Try again.");
      setBusy(false);
      setArmed(false);
    }
  };

  const leaderName = leader == null ? null : leader === SOMEONE_ELSE ? "Someone else" : driverIn(p.race, leader)?.last;
  return (
    <section aria-label="Reveal">
      <h2 className="text-2xl font-bold tracking-tight text-zinc-50">Who led into Turn 1?</h2>
      <p className="mb-3 mt-1 text-sm text-zinc-400">Whoever was ahead coming out of Turn 1. You get one go at this.</p>
      <DriverList race={p.race} value={leader} onChange={setLeader} label="Who led into Turn 1" someoneElse />
      <div className="mt-4 flex flex-wrap items-center gap-3 px-3">
        {armed ? (
          <>
            <span className="text-xs text-zinc-300">{leaderName} led? This is final.</span>
            <button type="button" disabled={busy} onClick={submit} className={PRIMARY}>
              {busy ? "Revealing…" : "Reveal"}
            </button>
            <button type="button" disabled={busy} onClick={() => setArmed(false)} className={SECONDARY}>
              Cancel
            </button>
          </>
        ) : (
          <button type="button" disabled={leader == null} onClick={submit} className={`${PRIMARY} px-4 py-2 text-sm`}>
            Reveal my call
          </button>
        )}
        {error && <span className="text-xs text-red-400">{error}</span>}
      </div>
    </section>
  );
}
