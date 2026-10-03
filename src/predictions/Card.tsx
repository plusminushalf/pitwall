// The card: 1080×1920 (a 9:16 story), drawn in CSS at full size and scaled down on screen (ScaledCard), so the
// PNG (image.ts) is the very thing on screen. The hook up top, the three teams in the order they'll pit, and the
// credibility strip: when the server locked it, how long before lights out, the race and the link.
// Revealed, it gets a stamp under the hook (all three right: CALLED IT; some: N OUT OF 3) and ticks on the right
// places; the stamp sits in the layout, not over the teams, so the order it vouches for stays readable.

import { useLayoutEffect, useRef, useState, type CSSProperties, type Ref } from "react";
import { dayMonth, shortSpan, stamp } from "./format";
import { hits, hookLength, team, verdict, type Prediction, type Race, type TeamId } from "./model";
import "./card.css";

export const CARD_W = 1080;
export const CARD_H = 1920;

export interface CardProps {
  race: Race;
  /** In the order they'll pit; fewer than three while composing. */
  teams: TeamId[];
  hook: string;
  /** Absent: not locked yet (the composer's preview). */
  locked?: Pick<Prediction, "id" | "lockedAt" | "tz" | "result">;
  /** Where the link on the card points, without the scheme. */
  host: string;
  /** Composing: the caller's zone, for the race's date. */
  tz?: string;
}

/** Hook size by length: short claims shout, long ones still fit in five lines. Revealed, it makes room for the stamp. */
function hookSize(n: number, revealed: boolean): number {
  return Math.round(baseHookSize(n) * (revealed ? 0.72 : 1));
}
function baseHookSize(n: number): number {
  if (n <= 14) return 212;
  if (n <= 24) return 184;
  if (n <= 36) return 158;
  if (n <= 48) return 138;
  return 122;
}

/** Dark ink on light team colours, white on dark ones. */
function inkOn(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b! > 0.3 ? "#0a0a0d" : "#ffffff";
}

export function Card({ race, teams, hook, locked, host, tz, ref }: CardProps & { ref?: Ref<HTMLDivElement> }) {
  const zone = locked?.tz ?? tz ?? "UTC";
  const result = locked?.result ?? null;
  const right = result ? hits({ teams: teams as Prediction["teams"] }, result) : null;
  const kind = result ? verdict({ teams: teams as Prediction["teams"] }, result) : null;
  const shownHook = hook.trim() || "Your hook goes here.";
  const p1 = teams[0] ? team(teams[0]).colour : "#e7000b";
  const when = locked ? stamp(locked.lockedAt, zone) : null;
  const revealed = kind === "called" || kind === "partial";

  // The hook's size by its length, then smaller until everything above the teams fits (long words, the stamp).
  const base = hookSize(hookLength(shownHook), revealed);
  const [size, setSize] = useState(base);
  const wrap = useRef<HTMLDivElement>(null);
  const hookEl = useRef<HTMLParagraphElement>(null);
  useLayoutEffect(() => {
    const fit = () => {
      const w = wrap.current;
      const h = hookEl.current;
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
  }, [base, shownHook, kind]);

  return (
    <div ref={ref} className={`ci-card${revealed ? " ci-revealed" : ""}`} style={{ "--p1": p1 } as CSSProperties} data-verdict={kind ?? undefined}>
      <div className="ci-bg" aria-hidden />
      <div className="ci-ghost" aria-hidden>
        BOX
        <br />
        BOX
      </div>

      <header className="ci-top">
        <div className="ci-tag">
          <span className="ci-tag-bar" />
          Pit call
        </div>
        <div className="ci-race">
          <div className="ci-race-name">{race.short}</div>
          <div className="ci-race-meta">
            {race.place} · {dayMonth(race.start, zone)}
          </div>
        </div>
      </header>

      <div ref={wrap} className="ci-hook-wrap">
        {!revealed && (
          <div className="ci-quote" aria-hidden>
            “
          </div>
        )}
        <p ref={hookEl} className={`ci-hook${hook.trim() ? "" : " ci-hook-empty"}`} style={{ fontSize: size }}>
          {shownHook}
        </p>
        {kind === "called" && when && (
          <div className="ci-stamp-slot">
            <div className="ci-stamp ci-stamp-called">
              <div>Called it</div>
              <div className="ci-stamp-date">
                Called this at {when.time}, before lights out
              </div>
            </div>
          </div>
        )}
        {kind === "partial" && right && (
          <div className="ci-stamp-slot">
            <div className="ci-stamp ci-stamp-partial">
              <div>{right.filter(Boolean).length} out of 3</div>
              {when && <div className="ci-stamp-date">Locked {when.time}, before lights out</div>}
            </div>
          </div>
        )}
      </div>

      <section className="ci-order">
        <div className="ci-order-label">
          <span>First to pit</span>
          <span className="ci-order-rule" />
        </div>
        {[0, 1, 2].map((i) => {
          const id = teams[i];
          if (!id)
            return (
              <div key={i} className="ci-row ci-row-empty">
                <div className="ci-pos">{i + 1}</div>
                <div className="ci-slab">
                  <span className="ci-name">Pick a team</span>
                </div>
              </div>
            );
          const t = team(id);
          const miss = right && !right[i];
          return (
            <div key={i} className={`ci-row${miss ? " ci-row-miss" : ""}`} style={{ "--team": t.colour, "--ink": inkOn(t.colour) } as CSSProperties}>
              <div className="ci-pos">{i + 1}</div>
              <div className="ci-slab">
                <span className="ci-name">{t.name}</span>
              </div>
              {right?.[i] && (
                <div className="ci-tick" aria-label="Right">
                  <svg viewBox="0 0 24 24">
                    <path d="M5 12.5l4.5 4.5L19 7.5" />
                  </svg>
                </div>
              )}
            </div>
          );
        })}
      </section>

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
