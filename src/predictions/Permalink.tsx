// A call's link: the locked card for anyone, and for its caller (who has its token) the reveal once lights are out.
// Called right, it's the trophy (CALLED IT); wrong, it fades quietly, with nothing to share.

import { useEffect, useRef, useState } from "react";
import { adoptTokenFromHash, ApiError, getPrediction, revealLink, revealPrediction, tokenFor } from "./api";
import { ScaledCard } from "./Card";
import { span, stamp } from "./format";
import { cardPng, copy, copyImage, download, share } from "./image";
import { calledIt, driverIn, raceById, SOMEONE_ELSE, team, topFive, type Prediction } from "./model";

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

  if (load.state === "loading") return <div className="mx-auto aspect-[9/16] w-full max-w-[420px] animate-pulse rounded-xl bg-zinc-900" />;
  if (load.state !== "ready")
    return (
      <div className="mx-auto max-w-md py-16 text-center">
        <p className="ci-display text-4xl font-black uppercase italic text-white">{load.state === "missing" ? "No call here" : "Couldn't load it"}</p>
        <p className="mt-3 text-zinc-400">{load.state === "missing" ? "Check the link, or make a call of your own." : load.message}</p>
        <NewCall onNew={onNew} className="mt-8" />
      </div>
    );
  return <Locked p={load.p} justLocked={!!fresh} onRevealed={(p) => setLoad({ state: "ready", p })} onNew={onNew} />;
}

function Locked({ p, justLocked, onRevealed, onNew }: { p: Prediction; justLocked: boolean; onRevealed: (p: Prediction) => void; onNew: () => void }) {
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

  // The PNG is made ahead, so Share still has the tap's permission when it hands the file on.
  useEffect(() => {
    png.current = null;
    if (!shareable) return;
    const t = setTimeout(() => {
      if (cardRef.current) png.current = cardPng(cardRef.current);
    }, 300);
    return () => clearTimeout(t);
  }, [p, shareable]);
  const image = () => (png.current ??= cardPng(cardRef.current!));

  const say = (s: string) => {
    setToast(s);
    setTimeout(() => setToast((t) => (t === s ? null : t)), 2400);
  };
  const name = `called-it-${race.short.toLowerCase().replace(/\W+/g, "-")}-${p.id}.png`;
  const text = right ? `Called it: ${d?.last} led into Turn 1. Locked before lights out.` : `${d?.last} leads into Turn 1. Locked before lights out.`;
  // The caption to post with the card: the call, the tags, the link.
  const caption = `${text} #F1 #${race.short.replace(/\W/g, "")}\n${url}`;

  return (
    <div className="grid gap-10 lg:grid-cols-[380px_minmax(0,1fr)] lg:gap-14">
      <div className="mx-auto w-full max-w-[380px] lg:max-w-none">
        <div className={right === false ? "opacity-35 grayscale-[0.7]" : ""}>
          <ScaledCard
            race={race}
            call={p.call}
            locked={p}
            host={location.host}
            cardRef={cardRef}
            className={`rounded-xl shadow-2xl ring-1 ${right ? "shadow-emerald-950/60 ring-emerald-400/30" : "shadow-black ring-white/10"}`}
          />
        </div>
        {shareable && (
          <div className="mt-5 grid grid-cols-2 gap-2">
            <button
              type="button"
              className="ci-btn col-span-2 bg-white text-zinc-950 hover:bg-zinc-200"
              onClick={async () => {
                try {
                  say((await copyImage(image)) ? "Card copied. Paste it into your post." : "This browser can't copy images: download it instead.");
                } catch {
                  png.current = null;
                  say("Couldn't copy the card. Try Download.");
                }
              }}
            >
              Copy image
            </button>
            <button
              type="button"
              className="ci-btn bg-zinc-800 text-white hover:bg-zinc-700"
              onClick={async () => {
                try {
                  download(await image(), name);
                } catch {
                  png.current = null;
                  say("Couldn't make the image. Try again.");
                }
              }}
            >
              Download image
            </button>
            <button
              type="button"
              className="ci-btn bg-zinc-800 text-white hover:bg-zinc-700"
              onClick={async () => {
                const r = await share({ url, text, image, name });
                if (r === "copied") say("Link copied");
              }}
            >
              Share
            </button>
          </div>
        )}
        <div aria-live="polite" className="mt-3 h-5 text-center text-sm text-zinc-300">
          {toast}
        </div>
      </div>

      <div className="flex min-w-0 flex-col gap-6 lg:pt-4">
        <Status p={p} owner={owner} justLocked={justLocked} started={started} when={when} />
        {shareable && (
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-4">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">Text to post with it</div>
            <p className="select-all whitespace-pre-wrap break-words text-zinc-100">{caption}</p>
            <button
              type="button"
              className="ci-btn mt-3 w-full bg-zinc-800 text-white hover:bg-zinc-700"
              onClick={async () => {
                await copy(caption);
                say("Text copied");
              }}
            >
              Copy text
            </button>
          </div>
        )}
        {owner && !p.result && started && <Reveal p={p} onRevealed={onRevealed} />}
        {owner && !p.result && (
          // Only this browser holds the call's token (api.ts); the private link carries it to another device.
          <p className="text-sm text-zinc-500">
            Revealing from another device?{" "}
            <button
              type="button"
              className="text-zinc-300 underline decoration-zinc-600 underline-offset-4 hover:text-white"
              onClick={async () => {
                await copy(revealLink(p.id));
                say("Private link copied. Don't post this one.");
              }}
            >
              Copy your private link
            </button>
          </p>
        )}
        {!owner && <NewCall onNew={onNew} />}
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
    title = owner ? "You called it." : "They called it.";
    body = `${name} led into Turn 1. Locked ${locked}, ${early} before lights out. Go collect.`;
  } else if (right === false) {
    title = owner ? "Not this one." : "This call is closed.";
    body = owner ? "It happens to real pit walls too. The receipt stays locked, quietly. On to the next race." : "Make your own for the next race.";
  } else if (justLocked) {
    title = "Locked in.";
    body = `Stamped by our server at ${when.time} ${when.zone}, ${early} before lights out. Nobody can change it now, not even you. Post it, then come back after the start.`;
  } else if (owner) {
    title = started ? "Lights out." : "Your call is locked.";
    body = started ? "Enter who led out of Turn 1." : `Locked ${locked}. Come back after the start to reveal it.`;
  } else {
    title = started ? "Lights out. Result pending." : "Locked before lights out.";
    body = `${name} to lead into Turn 1 at the ${race.name}. Locked ${locked}, ${early} before lights out. Can't be edited.`;
  }
  return (
    <div>
      <h1 className={`ci-display text-5xl font-black uppercase italic leading-[0.9] ${right ? "text-[#19e68c]" : "text-white"}`}>{title}</h1>
      <p className="mt-3 max-w-prose text-zinc-400">{body}</p>
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

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-4">
      <h2 className="ci-display text-2xl font-extrabold uppercase italic text-white">Who led into Turn 1?</h2>
      <p className="mb-4 mt-1 text-sm text-zinc-400">Whoever was ahead coming out of Turn 1. You get one go at this.</p>
      <div className="grid grid-cols-2 gap-2">
        {[...topFive(p.race), null].map((d) => {
          const n = d?.number ?? SOMEONE_ELSE;
          const on = leader === n;
          return (
            <button
              key={n}
              type="button"
              aria-pressed={on}
              onClick={() => setLeader(n)}
              className={`flex h-12 items-center gap-3 overflow-hidden rounded-md border pr-3 text-left ${on ? "border-white bg-zinc-800" : "border-zinc-800 bg-zinc-900 hover:border-zinc-600"}`}
            >
              <span className="h-full w-1.5 flex-none" style={{ background: d ? team(d.team).colour : "#3f3f46" }} />
              <span className="ci-display truncate text-lg font-bold uppercase italic text-zinc-100">{d ? d.last : "Someone else"}</span>
            </button>
          );
        })}
      </div>
      <button
        type="button"
        disabled={busy || leader == null}
        onClick={submit}
        className={`ci-btn mt-4 w-full ${armed ? "bg-[#ff1e28] text-white hover:bg-[#ff3a43]" : "bg-white text-zinc-950 hover:bg-zinc-200"}`}
      >
        {busy ? "Revealing…" : armed ? "Sure? This is final" : "Reveal my call"}
      </button>
      {error && <p className="mt-2 text-sm text-[#ff6467]">{error}</p>}
    </div>
  );
}

function NewCall({ onNew, label = "Make your own call", className = "" }: { onNew: () => void; label?: string; className?: string }) {
  return (
    <button type="button" onClick={onNew} className={`ci-display self-start text-xl font-extrabold uppercase italic text-white hover:text-[#ff6467] ${className}`}>
      {label} →
    </button>
  );
}
