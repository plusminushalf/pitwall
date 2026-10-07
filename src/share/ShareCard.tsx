// The share card: the widgets picked, mounted again in a column of their own (CARD_WIDTH), under a heading that says
// what they're of and over Pitwall's name and address, then drawn to a PNG at CARD_SCALE. Cropped from the screen, a
// widget is as wide as it is there, and in a feed shrunk to a phone's width its type is a few pixels tall; laid out
// narrower and drawn bigger, the same type is twice the size and more.

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { create } from "zustand";
import { useReplay } from "../store";
import { sessionKind } from "../widgetkit/select";
import { hostedIn, WidgetHost, type HostedWidget } from "../widgetkit/WidgetHost";
import { Flag } from "../components/Flag";
import { captureCard } from "./capture";

/** The card's width, in CSS px. */
const CARD_WIDTH = 480;
/** Image px per CSS px: 1200 px wide. */
const CARD_SCALE = 2.5;
/** The longest the widgets get to load their data before the card is drawn anyway. */
const READY_MS = 4000;

export interface ShareHeading {
  title: string;
  detail?: string;
  /** For the flag before the title. */
  country?: string;
}

/** The heading a page gives its share cards (a circuit's page); a session's comes from the session. */
export const useShareHeading = create<{ heading: ShareHeading | null }>(() => ({ heading: null }));

/** The heading for a card made now: the session's, at the lap it's at, or else the page's. */
export function shareHeading(): ShareHeading | null {
  const s = useReplay.getState();
  const meta = s.view === "replay" ? s.session?.meta : undefined;
  if (!s.session || !meta) return useShareHeading.getState().heading;
  const lap = sessionKind(s.session) === "race" && s.race && s.race.leaderLap > 0 ? `Lap ${s.race.leaderLap} of ${meta.totalLaps}` : null;
  return { title: meta.meetingName, detail: [meta.year, meta.sessionName, lap].filter(Boolean).join(" · "), country: meta.country };
}

export interface CardPanel extends HostedWidget {
  /** As tall as it is on screen (CSS px). */
  height: number;
}

/**
 * The panels picked as a card's widgets, in reading order (top to bottom, then left to right); null if any isn't a
 * widget (a section of a page: the screen is cropped instead) or none is. A page's title panel (data-shot="title") is
 * left out: the card's heading says it.
 */
export function cardPanels(els: readonly Element[]): CardPanel[] | null {
  const placed: { panel: CardPanel; top: number; left: number }[] = [];
  for (const el of els) {
    if (el.getAttribute("data-shot") === "title") continue;
    const hosted = hostedIn(el);
    if (!hosted) return null;
    const r = el.getBoundingClientRect();
    placed.push({ panel: { ...hosted, height: Math.round(r.height) }, top: r.top, left: r.left });
  }
  if (placed.length === 0) return null;
  return placed.sort((a, b) => a.top - b.top || a.left - b.left).map((p) => p.panel);
}

export interface CardJob {
  panels: CardPanel[];
  heading: ShareHeading | null;
  host: string;
  done: (blob: Blob) => void;
  fail: (error: unknown) => void;
}

const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));

/** Resolves once nothing in `el` is a loading placeholder, or after READY_MS; a few frames on, so canvases have drawn. */
async function settled(el: HTMLElement) {
  const until = performance.now() + READY_MS;
  await frame();
  while (el.querySelector('[class*="animate-pulse"]') && performance.now() < until) await new Promise((r) => setTimeout(r, 100));
  await frame();
  await frame();
}

/**
 * The card, out of sight while it's drawn: on the page (a widget off screen holds still), but transparent and under
 * everything. The picture is made of its copy, which is opaque.
 */
export function ShareCard({ job }: { job: CardJob }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let live = true;
    void settled(ref.current!)
      .then(() => captureCard(ref.current!, CARD_SCALE))
      .then(
        (blob) => live && job.done(blob),
        (e) => live && job.fail(e),
      );
    return () => {
      live = false;
    };
  }, [job]);

  const { heading, panels, host } = job;
  return createPortal(
    <div
      ref={ref}
      aria-hidden
      inert
      className="pointer-events-none fixed left-0 top-0 -z-10 bg-zinc-950 px-6 pb-5 pt-6 text-zinc-100 opacity-0"
      style={{ width: CARD_WIDTH }}
    >
      {heading && (
        <header className="mb-4">
          <h1 className="flex items-center gap-2.5 text-2xl font-bold tracking-tight text-zinc-50">
            {heading.country && <Flag country={heading.country} className="h-5" />}
            {heading.title}
          </h1>
          {heading.detail && <p className="mt-0.5 text-sm text-zinc-400">{heading.detail}</p>}
        </header>
      )}
      {/* Framed and divided by hairlines, as on the page. */}
      <div className="border-l border-t border-zinc-800">
        {panels.map((p, i) => (
          <div key={i} className="border-b border-r border-zinc-800" style={{ height: p.height }}>
            <WidgetHost widget={p.widget} settings={p.settings} circuit={p.circuit} pixelRatio={CARD_SCALE} className="h-full w-full overflow-hidden" />
          </div>
        ))}
      </div>
      <footer className="mt-5 flex items-center justify-between">
        <img src="/pitwall-logo.svg" alt="Pitwall" className="h-4" />
        <span className="text-[13px] font-medium text-zinc-300">{host}</span>
      </footer>
    </div>,
    document.body,
  );
}
