// The card: 1080×1920 (a 9:16 story), drawn in CSS at full size and scaled down on screen (ScaledCard), so the
// PNG (image.ts) is the very thing on screen. The question up top (ASK, by the call's kind), the answer under it (the
// driver, and the rest of the top five they were picked over), then how long before it's decided it was made, the race
// and where to make one.

import { useLayoutEffect, useRef, useState, type CSSProperties, type Ref } from "react";
import { dayMonth } from "./format";
import { ASK, driverIn, team, timing, topFive, type Call, type Race } from "./model";
import "./card.css";

export const CARD_W = 1080;
export const CARD_H = 1920;

export interface CardProps {
  race: Race;
  call: Call;
  /** When it's made, ms since the epoch: how long before lights out. */
  at: number;
  /** Where to make one, without the scheme. */
  host: string;
  /** The caller's zone, for the race's date. */
  tz: string;
}

/** Dark ink on light team colours, white on dark ones. */
function inkOn(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b! > 0.3 ? "#0a0a0d" : "#ffffff";
}

export function Card({ race, call, at, host, tz, ref }: CardProps & { ref?: Ref<HTMLDivElement> }) {
  const leadTeam = call.driver != null ? driverIn(race.id, call.driver)?.team : undefined;
  const p1 = leadTeam ? team(leadTeam).colour : "#e7000b";
  const ask = ASK[call.kind];
  const when = timing(race, at);
  return (
    <div ref={ref} className="ci-card" style={{ "--p1": p1 } as CSSProperties}>
      <div className="ci-bg" aria-hidden />
      <div className="ci-ghost" aria-hidden>
        {ask.ghost[0]}
        <br />
        {ask.ghost[1]}
      </div>

      <header className="ci-top">
        <div className="ci-tag">
          <span className="ci-tag-bar" />
          {ask.tag}
        </div>
        <div className="ci-race">
          <div className="ci-race-name">{race.short}</div>
          <div className="ci-race-meta">
            {race.place} · {dayMonth(race.start, tz)}
          </div>
        </div>
      </header>

      <div className="ci-headline-wrap">
        <p className="ci-headline" style={{ fontSize: 192 }}>
          {ask.title}
        </p>
      </div>

      <Pick race={race} driver={call.driver} />

      <footer className="ci-strip">
        <div className="ci-locked-label">{when.unit === "to go" ? "Called with" : "Called"}</div>
        <div className="ci-togo">
          {when.n} <span>{when.unit}</span>
        </div>
        <div className="ci-locked-meta">
          <b>Before {ask.deadline}</b>
          <span className="ci-dot">·</span>
          {race.name}
        </div>
        <div className="ci-sign">
          <Wordmark />
          <span className="ci-url">{host}/predictions</span>
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
function Pick({ race, driver }: { race: Race; driver: number | null }) {
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
              {t.name} · Starts P{d.grid}
            </span>
          </div>
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
            <em>P{o.grid}</em>
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
