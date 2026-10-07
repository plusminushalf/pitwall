// The share card: the widgets picked (and sections of a page that can be, useCardSection), mounted again in a column of
// their own (CARD_WIDTH), under a heading that says what they're of and over Pitwall's name and address, then drawn to
// a PNG IMAGE_WIDTH wide. Cropped from the screen, a widget is as wide as it is there, and in a feed shrunk to a
// phone's width its type is a few pixels tall; laid out narrower and drawn bigger, the same type is twice the size.

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal, flushSync } from "react-dom";
import { create } from "zustand";
import { useReplay } from "../store";
import { sessionKind } from "../widgetkit/select";
import { hostedIn, WidgetHost, type HostedWidget } from "../widgetkit/WidgetHost";
import { Flag } from "../components/Flag";
import { captureCard } from "./capture";

/** A card of widgets' width, in CSS px; a section's may be wider (useCardSection). */
const CARD_WIDTH = 480;
/** The image's width: drawn 2.5 times over, a card of widgets. */
const IMAGE_WIDTH = 1200;
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

/** A section of a page a card can show (useCardSection). */
interface CardSection {
  render: () => ReactNode;
  width: number;
}

const SECTIONS = new WeakMap<Element, { current: CardSection }>();

/**
 * Makes the panel `ref` is on (a data-shot section of a page) one a share card can show: `render` mounts it again
 * there, in a card `width` wide. What it lays out by its width should go by its own (container queries), not the
 * screen's, so that it takes its narrow layout in the card.
 */
export function useCardSection(ref: RefObject<Element | null>, render: () => ReactNode, width = CARD_WIDTH) {
  const latest = useRef<CardSection>({ render, width });
  latest.current = { render, width };
  // Every render: the panel may come and go.
  useLayoutEffect(() => {
    if (ref.current) SECTIONS.set(ref.current, latest);
  });
}

export interface CardPanel {
  /** The panel mounted again, its canvases drawn at `scale` device px per CSS px. */
  render: (scale: number) => ReactNode;
  /** The card's width it needs (CSS px). */
  width: number;
  /** A widget: as tall as it is on screen (CSS px), and framed by hairlines. A section is as tall as it lays out. */
  height?: number;
}

const widgetPanel = (hosted: HostedWidget, height: number): CardPanel => ({
  render: (scale) => <WidgetHost widget={hosted.widget} settings={hosted.settings} circuit={hosted.circuit} pixelRatio={scale} className="h-full w-full overflow-hidden" />,
  width: CARD_WIDTH,
  height,
});

/**
 * The panels picked as a card's, in reading order (top to bottom, then left to right); null if any is neither a
 * widget nor a section a card can show (the screen is cropped instead), or there are none. A page's title panel
 * (data-shot="title") is left out: the card's heading says it.
 */
export function cardPanels(els: readonly Element[]): CardPanel[] | null {
  const placed: { panel: CardPanel; top: number; left: number }[] = [];
  for (const el of els) {
    if (el.getAttribute("data-shot") === "title") continue;
    const r = el.getBoundingClientRect();
    const section = SECTIONS.get(el)?.current;
    const hosted = section ? null : hostedIn(el);
    if (!section && !hosted) return null;
    placed.push({ panel: section ? { render: section.render, width: section.width } : widgetPanel(hosted!, Math.round(r.height)), top: r.top, left: r.left });
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

/** The sources credited in `el` (a section's credit line), once each. */
const creditsIn = (el: Element) => [...new Set([...el.querySelectorAll("[data-shot-credit]")].map((c) => c.getAttribute("data-shot-credit")!))].join(" · ");

/**
 * The card, out of sight while it's drawn: on the page (a widget off screen holds still), but transparent and under
 * everything. The picture is made of its copy, which is opaque. A section's credit line is left out, its source named
 * in the footer instead.
 */
export function ShareCard({ job }: { job: CardJob }) {
  const ref = useRef<HTMLDivElement>(null);
  const [credits, setCredits] = useState("");
  const { heading, panels, host } = job;
  const width = Math.max(...panels.map((p) => p.width));
  const scale = IMAGE_WIDTH / width;
  useEffect(() => {
    let live = true;
    void settled(ref.current!)
      .then(() => {
        flushSync(() => setCredits(creditsIn(ref.current!)));
        return captureCard(ref.current!, scale);
      })
      .then(
        (blob) => live && job.done(blob),
        (e) => live && job.fail(e),
      );
    return () => {
      live = false;
    };
  }, [job, scale]);

  return createPortal(
    <div
      ref={ref}
      aria-hidden
      inert
      className="pointer-events-none fixed left-0 top-0 -z-10 bg-zinc-950 px-6 pb-5 pt-6 text-zinc-100 opacity-0 [&_[data-shot-credit]]:hidden"
      style={{ width }}
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
      {panels.map((p, i) => {
        // Widgets framed and divided by hairlines, as on the page; a section after anything is spaced from it.
        const prev = panels[i - 1];
        if (p.height == null) return <div key={i} className={prev ? "mt-6" : ""}>{p.render(scale)}</div>;
        return (
          <div key={i} className={`border-x border-b border-zinc-800 ${prev?.height == null ? "border-t" : ""} ${prev && prev.height == null ? "mt-6" : ""}`} style={{ height: p.height }}>
            {p.render(scale)}
          </div>
        );
      })}
      <footer className="mt-5 flex items-center gap-4">
        <img src="/pitwall-logo.svg" alt="Pitwall" className="h-4 shrink-0" />
        <span className="min-w-0 flex-1 text-xs text-zinc-400">{credits}</span>
        <span className="shrink-0 text-[13px] font-medium text-zinc-300">{host}</span>
      </footer>
    </div>,
    document.body,
  );
}
