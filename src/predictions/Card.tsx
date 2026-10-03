// The card: 1080×1920 (a 9:16 story), drawn in CSS at full size and scaled down on screen (ScaledCard), so the
// PNG (image.ts) is the very thing on screen. The question up top, the answer under it (the driver, and the rest of
// the top five they were picked over), and the credibility strip: when the server locked it, how long before lights
// out, the race and the link. Called right, it gets a CALLED IT stamp between question and answer and a tick on the
// driver; the stamp sits in the layout, not over the driver, so what it vouches for stays readable. (Wrong calls
// aren't shared.)

import { useLayoutEffect, useRef, useState, type CSSProperties, type Ref } from "react";
import { dayMonth, shortSpan, stamp } from "./format";
import { calledIt, driverIn, team, topFive, type Prediction, type Race } from "./model";
import "./card.css";

export const CARD_W = 1080;
export const CARD_H = 1920;

/** A call, maybe half made (the composer's preview: no driver yet). */
export type Draft = { kind: "turn1-leader"; driver: number | null };

export interface CardProps {
  race: Race;
  call: Draft;
  /** Absent: not locked yet (the composer's preview). */
  locked?: Pick<Prediction, "id" | "lockedAt" | "tz" | "result">;
  /** Where the link on the card points, without the scheme. */
  host: string;
  /** Composing: the caller's zone, for the race's date. */
  tz?: string;
}

const QUESTION = "Who leads into Turn 1?";

/** Dark ink on light team colours, white on dark ones. */
function inkOn(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b! > 0.3 ? "#0a0a0d" : "#ffffff";
}

const TICK = (
  <div className="ci-tick" aria-label="Right">
    <svg viewBox="0 0 24 24">
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  </div>
);

export function Card({ race, call, locked, host, tz, ref }: CardProps & { ref?: Ref<HTMLDivElement> }) {
  const zone = locked?.tz ?? tz ?? "UTC";
  const result = locked?.result ?? null;
  const right = result && call.driver != null ? calledIt({ kind: call.kind, driver: call.driver }, result) : null;
  const lead = call.driver != null ? driverIn(race.id, call.driver)?.team : undefined;
  const p1 = lead ? team(lead).colour : "#e7000b";
  const when = locked ? stamp(locked.lockedAt, zone) : null;
  const revealed = right === true;

  // The question shouts, then gets smaller until everything above the driver fits (the stamp, when called).
  const base = 212;
  const [size, setSize] = useState(base);
  const wrap = useRef<HTMLDivElement>(null);
  const headlineEl = useRef<HTMLParagraphElement>(null);
  useLayoutEffect(() => {
    const fit = () => {
      const w = wrap.current;
      const h = headlineEl.current;
      if (!w || !h) return;
      const cs = getComputedStyle(w);
      const room = w.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
      const used = () => [...w.children].reduce((sum, c) => sum + (c as HTMLElement).offsetHeight + parseFloat(getComputedStyle(c).marginTop), 0);
      let px = base;
      h.style.fontSize = `${px}px`;
      while (used() > room && px > 56) h.style.fontSize = `${(px -= 4)}px`;
      setSize(px);
    };
    fit();
    let live = true;
    document.fonts.ready.then(() => live && fit());
    return () => {
      live = false;
    };
  }, [revealed]);

  return (
    <div ref={ref} className={`ci-card${revealed ? " ci-revealed" : ""}`} style={{ "--p1": p1 } as CSSProperties} >
      <div className="ci-bg" aria-hidden />
      <div className="ci-ghost" aria-hidden>
        TURN
        <br />
        ONE
      </div>

      <header className="ci-top">
        <div className="ci-tag">
          <span className="ci-tag-bar" />
          Turn 1 call
        </div>
        <div className="ci-race">
          <div className="ci-race-name">{race.short}</div>
          <div className="ci-race-meta">
            {race.place} · {dayMonth(race.start, zone)}
          </div>
        </div>
      </header>

      <div ref={wrap} className="ci-headline-wrap">
        <p ref={headlineEl} className="ci-headline" style={{ fontSize: size }}>
          {QUESTION}
        </p>
        {revealed && when && (
          <div className="ci-stamp-slot">
            <div className="ci-stamp ci-stamp-called">
              <div>Called it</div>
              <div className="ci-stamp-date">
                Called this at {when.time}, before lights out
              </div>
            </div>
          </div>
        )}
      </div>

      <Turn1 race={race} driver={call.driver} right={right} />

      <footer className="ci-strip">
        {when && locked ? (
          <>
            <div className="ci-locked-label">
              <span>Locked in</span>
              <span className="ci-lead">{shortSpan(race.start - locked.lockedAt)} early</span>
            </div>
            <div className="ci-locked-time">
              {when.date} · {when.time} <span className="ci-zone">{when.zone}</span>
            </div>
            <div className="ci-locked-meta">
              <b>Before lights out</b>
              <span className="ci-dot">·</span>
              {race.name}
            </div>
          </>
        ) : (
          <>
            <div className="ci-locked-label ci-pending">Not locked yet</div>
            <div className="ci-locked-time ci-pending-time">—— ——— ———— · ——:——</div>
            <div className="ci-locked-meta">
              <b>Before lights out</b>
              <span className="ci-dot">·</span>
              {race.name}
            </div>
          </>
        )}
        <div className="ci-sign">
          <Wordmark />
          <span className="ci-url">{locked ? `${host}/predictions/${locked.id}` : `${host}/predictions`}</span>
        </div>
      </footer>

    </div>
  );
}

/** Surname size by length, so VERSTAPPEN fits as well as NORRIS shouts. */
function surnameSize(n: number): number {
  if (n <= 6) return 232;
  if (n <= 8) return 196;
  if (n <= 10) return 160;
  return 136;
}

/** The pick: the driver big on their team's colour, and the rest of the top five they were picked over. */
function Turn1({ race, driver, right }: { race: Race; driver: number | null; right: boolean | null }) {
  const d = driver != null ? driverIn(race.id, driver) : undefined;
  const others = topFive(race.id).filter((o) => o.number !== driver);
  const t = d && team(d.team);
  return (
    <section className="ci-order ci-turn1">
      <div className="ci-order-label">
        <span>My call</span>
        <span className="ci-order-rule" />
      </div>
      {d && t ? (
        <div className="ci-hero" style={{ "--team": t.colour, "--ink": inkOn(t.colour) } as CSSProperties}>
          <div className="ci-slab ci-hero-slab">
            <span className="ci-hero-num" aria-hidden>
              {d.number}
            </span>
            <span className="ci-hero-first">{d.first}</span>
            <span className="ci-hero-last" style={{ fontSize: surnameSize(d.last.length) }}>
              {d.last}
            </span>
            <span className="ci-hero-meta">
              {t.name} · Qualified P{d.quali}
            </span>
          </div>
          {right && TICK}
        </div>
      ) : (
        <div className="ci-hero ci-row-empty">
          <div className="ci-slab ci-hero-slab">
            <span className="ci-name">Pick a driver</span>
          </div>
        </div>
      )}
      <div className="ci-over">
        <span className="ci-over-label">Over</span>
        {others.map((o) => (
          <span key={o.number} className="ci-chip" style={{ "--team": team(o.team).colour } as CSSProperties}>
            <i />
            {o.code}
            <em>P{o.quali}</em>
          </span>
        ))}
      </div>
    </section>
  );
}

/** The Called It wordmark: a tick in a red slanted box, then the name. */
export function Wordmark({ className = "ci-wordmark" }: { className?: string }) {
  return (
    <span className={className}>
      <svg viewBox="0 0 34 24" aria-hidden>
        <path className="ci-wm-box" d="M7 0H34L27 24H0Z" />
        <path className="ci-wm-tick" d="M9.5 12.5l4 4 9-9" />
      </svg>
      Called it
    </span>
  );
}

/** The card at the width it's given. Its node (for the PNG) is the unscaled card. */
export function ScaledCard({ cardRef, className = "", ...props }: CardProps & { cardRef?: Ref<HTMLDivElement>; className?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0);
  useLayoutEffect(() => {
    const el = box.current!;
    const ro = new ResizeObserver(() => setScale(el.clientWidth / CARD_W));
    ro.observe(el);
    setScale(el.clientWidth / CARD_W);
    return () => ro.disconnect();
  }, []);
  return (
    <div ref={box} className={`relative w-full overflow-hidden ${className}`} style={{ aspectRatio: `${CARD_W} / ${CARD_H}` }}>
      <div className="absolute left-0 top-0 origin-top-left" style={{ transform: `scale(${scale})`, visibility: scale ? "visible" : "hidden" }}>
        <Card {...props} ref={cardRef} />
      </div>
    </div>
  );
}
