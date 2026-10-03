// A call's link: the locked card for anyone, and for its caller (who has its token) the reveal once lights are out.
// Revealed, all three right is the trophy (CALLED IT), some right a softer stamp; none right fades quietly, with
// nothing to share.

import { useEffect, useRef, useState } from "react";
import { adoptTokenFromHash, ApiError, getPrediction, revealLink, revealPrediction, tokenFor } from "./api";
import { ScaledCard } from "./Card";
import { span, stamp } from "./format";
import { cardPng, copy, download, share } from "./image";
import { raceById, verdict, type Prediction, type TeamId } from "./model";
import { RankList } from "./RankList";

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
  const kind = p.result ? verdict(p, p.result) : null;
  const started = Date.now() >= race.start;
  const cardRef = useRef<HTMLDivElement>(null);
  const png = useRef<Promise<Blob> | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const url = `${location.origin}/predictions/${p.id}`;
  const shareable = kind !== "missed";
  const when = stamp(p.lockedAt, p.tz);

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
  const text = kind === "called" ? "Called it. Before lights out." : kind === "partial" ? "Half the receipts are still receipts." : `“${p.hook}” Locked before lights out.`;

  return (
    <div className="grid gap-10 lg:grid-cols-[380px_minmax(0,1fr)] lg:gap-14">
      <div className="mx-auto w-full max-w-[380px] lg:max-w-none">
        <div className={kind === "missed" ? "opacity-35 grayscale-[0.7]" : ""}>
          <ScaledCard
            race={race}
            teams={p.teams}
            hook={p.hook}
            locked={p}
            host={location.host}
            cardRef={cardRef}
            className={`rounded-xl shadow-2xl ring-1 ${kind === "called" ? "shadow-emerald-950/60 ring-emerald-400/30" : "shadow-black ring-white/10"}`}
          />
        </div>
        {shareable && (
          <div className="mt-5 grid grid-cols-2 gap-2">
            <button
              type="button"
              className="ci-btn bg-white text-zinc-950 hover:bg-zinc-200"
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
        {owner && !p.result && started && <Reveal p={p} onRevealed={onRevealed} />}
        {owner && !p.result && !started && (
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-4">
            <p className="text-sm text-zinc-300">This browser remembers it's your call. To reveal it from another phone or laptop, keep this link to yourself:</p>
            <button
              type="button"
              className="ci-btn mt-3 w-full bg-zinc-800 text-white hover:bg-zinc-700"
              onClick={async () => {
                await copy(revealLink(p.id));
                say("Reveal link copied. Keep it private.");
              }}
            >
              Copy my reveal link
            </button>
          </div>
        )}
        <NewCall onNew={onNew} label={owner ? "Make another call" : "Make your own call"} />
      </div>
    </div>
  );
}

function Status({ p, owner, justLocked, started, when }: { p: Prediction; owner: boolean; justLocked: boolean; started: boolean; when: ReturnType<typeof stamp> }) {
  const race = raceById(p.race)!;
  const kind = p.result ? verdict(p, p.result) : null;
  const locked = `${when.date}, ${when.time} ${when.zone}`;
  const early = span(race.start - p.lockedAt);
  let title: string;
  let body: string;
  if (kind === "called") {
    title = owner ? "You called it." : "They called it.";
    body = `All three, in order. Locked ${locked}, ${early} before lights out. Go collect.`;
  } else if (kind === "partial") {
    title = "Partly called.";
    body = `Not all three, but the ticks are real, locked ${early} before lights out. Still a receipt.`;
  } else if (kind === "missed") {
    title = owner ? "Not this one." : "This call is closed.";
    body = owner ? "It happens to real pit walls too. The receipt stays locked, quietly. On to the next race." : "Make your own for the next race.";
  } else if (justLocked) {
    title = "Locked in.";
    body = `Stamped by our server at ${when.time} ${when.zone}, ${early} before lights out. Nobody can change it now, not even you. Post it, then come back after the race.`;
  } else if (owner) {
    title = started ? "Lights out." : "Your call is locked.";
    body = started ? "Enter the pit order once your three teams have all stopped." : `Locked ${locked}. Come back after the race to reveal it.`;
  } else {
    title = started ? "Lights out. Result pending." : "Locked before lights out.";
    body = `Locked ${locked}, ${early} before the ${race.name}. Can't be edited.`;
  }
  return (
    <div>
      <h1 className={`ci-display text-5xl font-black uppercase italic leading-[0.9] ${kind === "called" ? "text-[#19e68c]" : "text-white"}`}>{title}</h1>
      <p className="mt-3 max-w-prose text-zinc-400">{body}</p>
    </div>
  );
}

function Reveal({ p, onRevealed }: { p: Prediction; onRevealed: (p: Prediction) => void }) {
  const [order, setOrder] = useState<TeamId[]>(p.teams);
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);

  const submit = async () => {
    if (!armed) return setArmed(true);
    setBusy(true);
    setError(null);
    try {
      onRevealed(await revealPrediction(p.id, order));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Something went wrong. Try again.");
      setBusy(false);
      setArmed(false);
    }
  };

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-4">
      <h2 className="ci-display text-2xl font-extrabold uppercase italic text-white">The real pit order</h2>
      <p className="mb-4 mt-1 text-sm text-zinc-400">Put your three teams in the order they actually made their first stop. You get one go at this.</p>
      <RankList teams={order} onChange={setOrder} label={(i) => ["pitted first", "pitted second", "pitted third"][i]!} />
      <button type="button" disabled={busy} onClick={submit} className={`ci-btn mt-4 w-full ${armed ? "bg-[#ff1e28] text-white hover:bg-[#ff3a43]" : "bg-white text-zinc-950 hover:bg-zinc-200"}`}>
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
