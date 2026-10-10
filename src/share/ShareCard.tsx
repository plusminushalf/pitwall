// The share card: the widgets picked (and sections of a page that can be, useCardSection), mounted again in a column of
// their own (CARD_WIDTH), under a heading that says what they're of and over Pitwall's name and address, then drawn to
// a PNG IMAGE_WIDTH wide. Cropped from the screen, a widget is as wide as it is there, and in a feed shrunk to a
// phone's width its type is a few pixels tall; laid out narrower and drawn bigger, the same type is twice the size.

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal, flushSync } from "react-dom";
import { create } from "zustand";
import { comparing, useReplay } from "../store";
import { cardStateIn, hostedIn, WidgetHost, type HostedWidget } from "../widgetkit/WidgetHost";
import { Flag } from "../components/Flag";
import { captureCard } from "./capture";
import { sessionMoment } from "./moment";

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

/**
 * The heading for a card made now: the session's, at the moment it's at (a race's lap, qualifying's segment and clock,
 * practice's clock; the laps compared are of the whole session), or else the page's.
 */
export function shareHeading(): ShareHeading | null {
  const s = useReplay.getState();
  const meta = s.view === "replay" ? s.session?.meta : undefined;
  if (!s.session || !meta) return useShareHeading.getState().heading;
  const moment = s.race && !comparing(s) ? sessionMoment(meta, s.race) : null;
  return { title: meta.meetingName, detail: [meta.year, meta.sessionName, moment].filter(Boolean).join(" · "), country: meta.country };
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
  /** A widget (framed by hairlines): as tall as it is on screen (CSS px). A section is as tall as it lays out. */
  height?: number;
  /**
   * A widget that's only as tall as what's in it, up to `height`: one that doesn't draw to its height (no canvas, nor
   * an element marked data-shot-fill: an SVG chart sized from useWidgetSize()).
   */
  fit?: boolean;
  /** How far each of the widget's scrolling parts was scrolled on screen (scrollers() order), to scroll its copy the same. */
  scroll?: { top: number; left: number }[];
}

/** The parts of a widget that scroll (a list in it), in document order: the same in its copy, as it's the same widget. */
const scrollers = (el: Element) => {
  const host = el.matches("[data-widget-host]") ? el : el.querySelector("[data-widget-host]");
  if (!host) return [];
  return [...host.querySelectorAll<HTMLElement>("*")].filter((e) => {
    const style = getComputedStyle(e);
    return /auto|scroll/.test(style.overflowY) || /auto|scroll/.test(style.overflowX);
  });
};

/** What each widget on screen is showing beyond its settings (its useCardState values), by its host element. */
export type CardStates = ReadonlyMap<Element, Record<string, unknown>>;

/** Every widget's useCardState values now: taken as the screen freezes, before the pointer moves off what it hovered. */
export const cardStates = (): CardStates => new Map([...document.querySelectorAll("[data-widget-host]")].map((host) => [host, cardStateIn(host)]));

const widgetPanel = (hosted: HostedWidget, el: Element, states: CardStates): CardPanel => {
  const host = el.matches("[data-widget-host]") ? el : el.querySelector("[data-widget-host]");
  const state = (host && states.get(host)) || cardStateIn(el);
  return {
    render: (scale) => (
      <WidgetHost widget={hosted.widget} settings={hosted.settings} circuit={hosted.circuit} pixelRatio={scale} cardState={state} className="h-full w-full overflow-hidden" />
    ),
    width: CARD_WIDTH,
    height: Math.round(el.getBoundingClientRect().height),
    fit: !el.querySelector("canvas, [data-shot-fill]"),
    scroll: scrollers(el).map((e) => ({ top: e.scrollTop, left: e.scrollLeft })),
  };
};

/**
 * The panels picked as a card's, in reading order (top to bottom, then left to right); null if any is neither a
 * widget nor a section a card can show (the screen is cropped instead), or there are none. A page's title panel
 * (data-shot="title") is left out: the card's heading says it. A widget's copy shows what it did in `states` (taken as
 * the screen froze), or else what it shows now.
 */
export function cardPanels(els: readonly Element[], states: CardStates = new Map()): CardPanel[] | null {
  const placed: { panel: CardPanel; top: number; left: number }[] = [];
  for (const el of els) {
    if (el.getAttribute("data-shot") === "title") continue;
    const r = el.getBoundingClientRect();
    const section = SECTIONS.get(el)?.current;
    const hosted = section ? null : hostedIn(el);
    if (!section && !hosted) return null;
    placed.push({ panel: section ? { render: section.render, width: section.width } : widgetPanel(hosted!, el, states), top: r.top, left: r.left });
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

/** Whether `panel`, or a list in it, has more in it than it shows. */
const overflows = (panel: HTMLElement) =>
  [panel, ...panel.querySelectorAll<HTMLElement>("*")].some((el) => el.scrollHeight > el.clientHeight + 1 && (el === panel || /auto|scroll/.test(getComputedStyle(el).overflowY)));

/** A panel cut short fades out at the bottom, so it doesn't end on half a row. */
const FADE = "linear-gradient(to bottom, black calc(100% - 56px), transparent)";

/** The sources credited in `el` (a section's credit line), once each. */
const creditsIn = (el: Element) => [...new Set([...el.querySelectorAll("[data-shot-credit]")].map((c) => c.getAttribute("data-shot-credit")!))].join(" · ");

/**
 * The card, out of sight while it's drawn: on the page (a widget off screen holds still), but transparent and under
 * everything. The picture is made of its copy, which is opaque. A section's credit line is left out, its source named
 * in the footer instead, and so are a widget's controls (data-shot-control: All / Selected, filters), which a
 * picture can't use.
 */
export function ShareCard({ job }: { job: CardJob }) {
  const ref = useRef<HTMLDivElement>(null);
  const [credits, setCredits] = useState("");
  const { heading, panels, host } = job;
  const width = Math.max(...panels.map((p) => p.width));
  const scale = IMAGE_WIDTH / width;
  // biome-ignore lint/correctness/useExhaustiveDependencies: panels come with the job
  useEffect(() => {
    let live = true;
    void settled(ref.current!)
      .then(() => {
        flushSync(() => setCredits(creditsIn(ref.current!)));
        // A widget's panels in order, each scrolled as it was on screen (a list scrolled down shows what was shown).
        const framed = panels.filter((p) => p.height != null);
        ref.current!.querySelectorAll<HTMLElement>("[data-card-panel]").forEach((panel, i) => {
          const scroll = framed[i]?.scroll ?? [];
          scrollers(panel).forEach((e, k) => {
            if (!scroll[k]) return;
            e.scrollTop = scroll[k].top;
            e.scrollLeft = scroll[k].left;
          });
          if (overflows(panel)) panel.style.maskImage = FADE;
        });
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
      className="pointer-events-none fixed left-0 top-0 -z-10 bg-zinc-950 px-6 pb-5 pt-6 text-zinc-100 opacity-0 [&_[data-shot-control]]:hidden [&_[data-shot-credit]]:hidden"
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
          <div
            key={i}
            data-card-panel=""
            className={`overflow-hidden border-x border-b border-zinc-800 ${prev?.height == null ? "border-t" : ""} ${prev && prev.height == null ? "mt-6" : ""}`}
            style={p.fit ? { maxHeight: p.height } : { height: p.height }}
          >
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
