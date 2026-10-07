// The screenshot: the app drawn to a canvas from its DOM (canvases included) at the screen's pixel ratio, then an
// area of it cut out with Pitwall's name and address in a strip underneath. Scrolled areas (Home, a circuit's page, a
// widget's table) are drawn as scrolled, their sticky headers where they're stuck.

/** On an element that mustn't be in screenshots (the picker, toasts). */
export const IGNORE = "data-shot-ignore";

const PIT_BLACK = "#09090b";
const HAIRLINE = "#27272a";
const TEXT = "#d4d4d8";
const FONT = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';
/** The strip's height, in CSS px. */
const STRIP = 32;
const PAD = 12;
/** Narrower areas are centred on a strip this wide, so the logo and the address fit. */
const MIN_WIDTH = 300;
const LOGO_HEIGHT = 14;
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
        if (!(cloned instanceof HTMLElement) || !cloned.hasAttribute(STUCK)) return;
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
    return { canvas, scale, bounds: { left, top, width, height } };
  } finally {
    marked.forEach((o) => o.removeAttribute("selected"));
    stuck.forEach((el) => el.removeAttribute(STUCK));
  }
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

/** The PNG to share: `area` of the shot over a strip with the logo and `host`. */
export async function brandedImage(shot: Shot, area: Rect, host: string): Promise<Blob> {
  const { canvas, scale } = shot;
  const width = Math.max(area.width, MIN_WIDTH);
  const out = document.createElement("canvas");
  out.width = Math.round(width * scale);
  out.height = Math.round((area.height + STRIP) * scale);
  const ctx = out.getContext("2d")!;
  ctx.scale(scale, scale);
  ctx.fillStyle = PIT_BLACK;
  ctx.fillRect(0, 0, width, area.height + STRIP);
  ctx.drawImage(canvas, area.left * scale, area.top * scale, area.width * scale, area.height * scale, (width - area.width) / 2, 0, area.width, area.height);
  ctx.fillStyle = HAIRLINE;
  ctx.fillRect(0, area.height, width, 1);
  const mid = area.height + 1 + (STRIP - 1) / 2;
  try {
    ctx.drawImage(await loadLogo(), PAD, mid - LOGO_HEIGHT / 2, LOGO_HEIGHT * LOGO_ASPECT, LOGO_HEIGHT);
  } catch {
    // Without the logo, the address still says where it's from.
  }
  ctx.font = `500 12px ${FONT}`;
  ctx.fillStyle = TEXT;
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  ctx.fillText(host, width - PAD, mid);
  return new Promise((resolve, reject) => out.toBlob((b) => (b ? resolve(b) : reject(new Error("The image couldn't be made"))), "image/png"));
}
