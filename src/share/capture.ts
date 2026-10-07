// The screenshot: the app drawn to a canvas from its DOM (canvases included) at the screen's pixel ratio, then an
// area of it cut out, framed by a margin, with Pitwall's name and address in a strip underneath. Scrolled areas (Home, a circuit's page, a
// widget's table) are drawn as scrolled, their sticky headers where they're stuck.

/** On an element that mustn't be in screenshots (the picker, toasts). */
export const IGNORE = "data-shot-ignore";
/**
 * On a source's credit line under a section: in a screenshot it's left blank (too small to read in a feed) and its
 * text, this attribute's value ("Forecast: Open-Meteo (CC BY 4.0)"), is in the strip instead when the area holds it.
 */
const CREDIT = "data-shot-credit";

const PIT_BLACK = "#09090b";
const HAIRLINE = "#27272a";
const TEXT = "#d4d4d8";
const MUTED = "#a1a1aa";
const FONT = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';
/** The strip's height, in CSS px. */
const STRIP = 44;
/**
 * The margin round the area, in CSS px: a share of its longer side, so a big area isn't cramped and a small one isn't
 * lost in black. Seen small in a feed, an area cut flush to its text reads as a crop of a page rather than a picture.
 */
const MARGIN = { share: 0.05, min: 28, max: 72 };
/** Narrower areas are centred on a strip this wide, so the logo and the address fit. */
const MIN_WIDTH = 300;
const LOGO_HEIGHT = 16;
/** Between the logo, the credits and the address; and a credits line's height when they're under the logo. */
const GAP = 16;
const CREDIT_LINE = 20;
/** public/pitwall-logo.svg's aspect ratio (its viewBox). */
const LOGO_ASPECT = 712 / 170;

/** An area in CSS px, from the app's top left. */
export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Shot {
  canvas: HTMLCanvasElement;
  /** Canvas px per CSS px. */
  scale: number;
  /** Where the app is on the page (CSS px). */
  bounds: Rect;
  /** The credit lines on screen, where they are (CSS px, from the app's top left) and where the space above them starts. */
  credits: { text: string; rect: Rect; above: number }[];
}

/** On a sticky element stuck away from where it would be, while the copy is made: how far (CSS px, "x y"). */
const STUCK = "data-shot-stuck";

/**
 * Marks the sticky elements in scrolled areas with how far they're stuck from where they'd be. The copy draws an area
 * unscrolled and then moves what's in it by the scroll, which takes a stuck header up with the rest: it's moved back.
 */
function markStuck(root: HTMLElement): HTMLElement[] {
  const marked: HTMLElement[] = [];
  for (const area of root.querySelectorAll<HTMLElement>("*")) {
    if (area.scrollTop === 0 && area.scrollLeft === 0) continue;
    for (const el of area.querySelectorAll<HTMLElement>("*")) {
      if (el.hasAttribute(STUCK) || getComputedStyle(el).position !== "sticky") continue;
      const stuck = el.getBoundingClientRect();
      // Where it would be, unstuck: read and put back in one task, so it's never painted.
      const inline = el.style.position;
      el.style.position = "static";
      const free = el.getBoundingClientRect();
      el.style.position = inline;
      const dx = stuck.left - free.left;
      const dy = stuck.top - free.top;
      if (dx === 0 && dy === 0) continue;
      el.setAttribute(STUCK, `${dx} ${dy}`);
      marked.push(el);
    }
  }
  return marked;
}

/** The app as it's drawn now. */
export async function captureApp(): Promise<Shot> {
  const root = document.getElementById("root")!;
  const scale = window.devicePixelRatio || 1;
  const { left, top, width, height } = root.getBoundingClientRect();
  // A copied <select> shows the option marked selected, not the one picked (a property): mark those for the copy.
  const marked = [...root.querySelectorAll("select")].flatMap((s) => [...s.selectedOptions]).filter((o) => !o.hasAttribute("selected"));
  marked.forEach((o) => o.setAttribute("selected", ""));
  const stuck = markStuck(root);
  const credits = [...root.querySelectorAll<HTMLElement>(`[${CREDIT}]`)].map((el) => {
    const r = el.getBoundingClientRect();
    const above = r.top - top - parseFloat(getComputedStyle(el).marginTop);
    return { text: el.getAttribute(CREDIT)!, rect: { left: r.left - left, top: r.top - top, width: r.width, height: r.height }, above };
  });
  try {
    // Loaded on the first share, not with the app.
    const { domToCanvas } = await import("modern-screenshot");
    const canvas = await domToCanvas(root, {
      scale,
      backgroundColor: PIT_BLACK,
      // The app uses the platform's fonts: nothing to embed.
      font: false,
      filter: (node) => !(node instanceof Element && node.hasAttribute(IGNORE)),
      // Scrolled areas as they're scrolled (off by default).
      features: { restoreScrollPosition: true },
      onCloneEachNode: (cloned) => {
        if (!(cloned instanceof HTMLElement)) return;
        // Hidden, not removed: what's under it stays where the picker finds it.
        if (cloned.hasAttribute(CREDIT)) cloned.style.visibility = "hidden";
        if (!cloned.hasAttribute(STUCK)) return;
        const [dx, dy] = cloned.getAttribute(STUCK)!.split(" ");
        const own = cloned.style.transform;
        cloned.style.transform = `translate(${dx}px, ${dy}px)${own && own !== "none" ? ` ${own}` : ""}`;
        cloned.removeAttribute(STUCK);
      },
      // Scrollbars: a picture can't be scrolled, and the copy draws them even where the platform's are hidden.
      onCloneNode: (cloned) => {
        const style = document.createElement("style");
        style.textContent = "* { scrollbar-width: none !important; }";
        (cloned as Element).prepend(style);
      },
    });
    return { canvas, scale, bounds: { left, top, width, height }, credits };
  } finally {
    marked.forEach((o) => o.removeAttribute("selected"));
    stuck.forEach((el) => el.removeAttribute(STUCK));
  }
}

/** A PNG of `el` (a share card, transparent where it waits) at `scale` image px per CSS px. */
export async function captureCard(el: HTMLElement, scale: number): Promise<Blob> {
  const { domToBlob } = await import("modern-screenshot");
  return domToBlob(el, {
    scale,
    type: "image/png",
    backgroundColor: PIT_BLACK,
    font: false,
    style: { opacity: "1" },
    onCloneNode: (cloned) => {
      const style = document.createElement("style");
      style.textContent = "* { scrollbar-width: none !important; }";
      (cloned as Element).prepend(style);
    },
  });
}

let logo: Promise<HTMLImageElement> | null = null;
function loadLogo(): Promise<HTMLImageElement> {
  logo ??= new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => {
      logo = null;
      reject(new Error("The logo didn't load"));
    };
    img.src = "/pitwall-logo.svg";
  });
  return logo;
}

/** `area` (the whole app if null) clamped to the shot. */
export function clampArea(shot: Shot, area: Rect | null): Rect {
  const { width, height } = shot.bounds;
  if (!area) return { left: 0, top: 0, width, height };
  const left = Math.min(Math.max(area.left, 0), width);
  const top = Math.min(Math.max(area.top, 0), height);
  return { left, top, width: Math.min(area.width, width - left), height: Math.min(area.height, height - top) };
}

const overlaps = (a: Rect, b: Rect) => a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height;

/**
 * The PNG to share: the `picked` area of the shot in a margin, over a strip with the logo, the credits of the sources in the
 * area and `host`. Credits that don't fit between the logo and the address go on a line of their own under the logo.
 */
export async function brandedImage(shot: Shot, picked: Rect, host: string): Promise<Blob> {
  const { canvas, scale } = shot;
  const credits = shot.credits.filter((c) => overlaps(c.rect, picked));
  // A credit line the area ends with (a section's last line) is cut off with the space above it, not left blank.
  const last = credits.find((c) => c.rect.top + c.rect.height >= picked.top + picked.height - 1 && c.above > picked.top);
  const area = last ? { ...picked, height: last.above - picked.top } : picked;
  const margin = Math.round(Math.min(Math.max(Math.max(area.width, area.height) * MARGIN.share, MARGIN.min), MARGIN.max));
  const inner = Math.max(area.width, MIN_WIDTH);
  const width = inner + 2 * margin;
  const out = document.createElement("canvas");
  const ctx = out.getContext("2d")!;
  const credit = [...new Set(credits.map((c) => c.text))].join(" · ");
  const creditFont = `400 12px ${FONT}`;
  const hostFont = `500 14px ${FONT}`;
  ctx.font = hostFont;
  const room = inner - LOGO_HEIGHT * LOGO_ASPECT - ctx.measureText(host).width - 2 * GAP;
  ctx.font = creditFont;
  const inline = ctx.measureText(credit).width <= room;
  // The margin above the area, below it to the strip's hairline, and half of it under the strip.
  const rule = margin + area.height + margin;
  const height = rule + 1 + STRIP + (credit && !inline ? CREDIT_LINE : 0) + Math.round(margin / 2);
  out.width = Math.round(width * scale);
  out.height = Math.round(height * scale);
  ctx.scale(scale, scale);
  ctx.fillStyle = PIT_BLACK;
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(canvas, area.left * scale, area.top * scale, area.width * scale, area.height * scale, margin + (inner - area.width) / 2, margin, area.width, area.height);
  ctx.fillStyle = HAIRLINE;
  ctx.fillRect(margin, rule, inner, 1);
  const mid = rule + 1 + STRIP / 2;
  try {
    ctx.drawImage(await loadLogo(), margin, mid - LOGO_HEIGHT / 2, LOGO_HEIGHT * LOGO_ASPECT, LOGO_HEIGHT);
  } catch {
    // Without the logo, the address still says where it's from.
  }
  ctx.textBaseline = "middle";
  if (credit) {
    ctx.font = creditFont;
    ctx.fillStyle = MUTED;
    if (inline) ctx.fillText(credit, margin + LOGO_HEIGHT * LOGO_ASPECT + GAP, mid);
    else ctx.fillText(credit, margin, mid + STRIP / 2, inner);
  }
  ctx.font = hostFont;
  ctx.fillStyle = TEXT;
  ctx.textAlign = "right";
  ctx.fillText(host, margin + inner, mid);
  return new Promise((resolve, reject) => out.toBlob((b) => (b ? resolve(b) : reject(new Error("The image couldn't be made"))), "image/png"));
}
