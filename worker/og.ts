// A call's link-preview image (og:image): the card turned sideways to 1200×630, the size X and others show under a
// link. Drawn here, on the server, from the stored call, so a preview can't claim more than the call does: the
// CALLED IT stamp only when the result says so (a wrong call previews as it was locked). An SVG, then a PNG by
// resvg (WebAssembly) with the card's fonts (worker/fonts/, OFL).

import { initWasm, Resvg } from "@resvg/resvg-wasm";
import { shortSpan, stamp, dayMonth } from "../src/predictions/format";
import { calledIt, driverIn, raceById, team, topFive, type Prediction } from "../src/predictions/model";

export const OG_W = 1200;
export const OG_H = 630;

const RED = "#ff1e28";
const GREEN = "#19e68c";
const BG = "#08080b";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Dark ink on light team colours, white on dark ones (as on the card). */
function inkOn(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b! > 0.3 ? "#0a0a0d" : "#ffffff";
}

/** Surname size by length, so VERSTAPPEN fits the slab as well as NORRIS shouts. */
function surnameSize(n: number): number {
  if (n <= 6) return 124;
  if (n <= 8) return 104;
  if (n <= 10) return 86;
  return 74;
}

/** Which version of the image a call has: what the preview's URL carries, so a new one replaces a cached one. */
export const ogState = (p: Prediction) => (p.result && calledIt(p.call, p.result) ? "called" : "locked");

export function ogSvg(p: Prediction, host: string): string {
  const race = raceById(p.race)!;
  const d = driverIn(p.race, p.call.driver)!;
  const t = team(d.team);
  const ink = inkOn(t.colour);
  const called = ogState(p) === "called";
  const when = stamp(p.lockedAt, p.tz);
  const others = topFive(p.race).filter((o) => o.number !== d.number);
  const text = (x: number, y: number, size: number, weight: number, body: string, extra = "") =>
    `<text x="${x}" y="${y}" font-family="Barlow Condensed" font-size="${size}" font-weight="${weight}" ${extra}>${esc(body)}</text>`;
  const italic = 'font-style="italic"';

  // The slab: a parallelogram on the right, like the card's.
  const [sx, sy, sw, sh, skew] = [636, 150, 500, 310, 44];
  const slab = `${sx + skew},${sy} ${sx + sw},${sy} ${sx + sw - skew},${sy + sh} ${sx},${sy + sh}`;

  const chips = others
    .map((o, i) => {
      const x = sx + 78 + i * 106;
      return `<g>
        <rect x="${x}" y="488" width="96" height="40" fill="#ffffff" fill-opacity="0.06" stroke="#ffffff" stroke-opacity="0.08" stroke-width="1.5"/>
        <rect x="${x}" y="488" width="7" height="40" fill="${team(o.team).colour}"/>
        ${text(x + 17, 516, 24, 800, o.code, `${italic} fill="#f7f7f8" fill-opacity="0.85"`)}
        ${text(x + 64, 516, 17, 600, `P${o.quali}`, `${italic} fill="#f7f7f8" fill-opacity="0.45"`)}
      </g>`;
    })
    .join("");

  const headline = called
    ? text(64, 214, 76, 900, "WHO LEADS LAP 1?", `${italic} fill="#ffffff"`)
    : `${text(64, 248, 112, 900, "WHO LEADS", `${italic} fill="#ffffff"`)}${text(64, 350, 112, 900, "LAP 1?", `${italic} fill="#ffffff"`)}`;

  const stampSvg = called
    ? `<g transform="translate(0 -16) rotate(-7 330 330)">
        <rect x="70" y="246" width="520" height="176" rx="16" fill="${BG}" fill-opacity="0.6" stroke="${GREEN}" stroke-width="9"/>
        <rect x="84" y="260" width="492" height="148" rx="9" fill="none" stroke="${GREEN}" stroke-width="3"/>
        ${text(330, 360, 112, 900, "CALLED IT", `${italic} fill="${GREEN}" text-anchor="middle"`)}
        <rect x="128" y="372" width="404" height="3" fill="${GREEN}"/>
        ${text(330, 398, 20, 800, `CALLED THIS AT ${when.time}, BEFORE LIGHTS OUT`, `${italic} fill="${GREEN}" text-anchor="middle" letter-spacing="1"`)}
      </g>`
    : "";

  const tick = called
    ? `<g transform="translate(${sx + sw - 22} ${sy + 12})">
        <circle r="34" fill="${GREEN}" stroke="${BG}" stroke-width="6"/>
        <path d="M-14 1 L-4 11 L15 -9" fill="none" stroke="#04140c" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
      </g>`
    : "";

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${OG_W}" height="${OG_H}" viewBox="0 0 ${OG_W} ${OG_H}">
  <defs>
    <radialGradient id="glow" cx="1" cy="0" r="0.75">
      <stop offset="0" stop-color="${t.colour}" stop-opacity="0.38"/>
      <stop offset="1" stop-color="${t.colour}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="ember" cx="0" cy="1" r="0.6">
      <stop offset="0" stop-color="${RED}" stop-opacity="0.18"/>
      <stop offset="1" stop-color="${RED}" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="lineFade" gradientUnits="userSpaceOnUse" x1="1200" y1="0" x2="640" y2="460">
      <stop offset="0" stop-color="#fff" stop-opacity="0.07"/>
      <stop offset="1" stop-color="#fff" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="slabFill" x1="0" y1="0" x2="1" y2="0.3">
      <stop offset="0" stop-color="${t.colour}"/>
      <stop offset="1" stop-color="${t.colour}" stop-opacity="0.78"/>
    </linearGradient>
    <linearGradient id="sheen" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#fff" stop-opacity="0.22"/>
      <stop offset="0.35" stop-color="#fff" stop-opacity="0"/>
    </linearGradient>
    <clipPath id="slabClip"><polygon points="${slab}"/></clipPath>
  </defs>

  <rect width="${OG_W}" height="${OG_H}" fill="${BG}"/>
  <rect width="${OG_W}" height="${OG_H}" fill="url(#glow)"/>
  <rect width="${OG_W}" height="${OG_H}" fill="url(#ember)"/>
  <path d="${SPEED_LINES}" stroke="url(#lineFade)" stroke-width="2"/>
  <rect x="0" y="0" width="744" height="8" fill="${RED}"/>
  <rect x="768" y="0" width="72" height="8" fill="${RED}"/>
  <rect x="864" y="0" width="36" height="8" fill="${RED}"/>

  <polygon points="72,60 84,60 76,92 64,92" fill="${RED}"/>
  ${text(96, 88, 26, 700, "LAP 1 CALL", 'fill="#ffffff" letter-spacing="4"')}
  ${text(1136, 86, 38, 800, race.short.toUpperCase(), `${italic} fill="#ffffff" text-anchor="end"`)}
  ${text(1136, 116, 19, 600, `${race.place} · ${dayMonth(race.start, p.tz)}`.toUpperCase(), 'fill="#f7f7f8" fill-opacity="0.55" text-anchor="end" letter-spacing="2.5"')}

  ${headline}

  <g clip-path="url(#slabClip)">
    <polygon points="${slab}" fill="url(#slabFill)"/>
    <polygon points="${slab}" fill="url(#sheen)"/>
    ${text(sx + sw - 40, sy + sh + 58, 290, 900, String(d.number), `${italic} fill="${ink}" fill-opacity="0.14" text-anchor="end"`)}
  </g>
  ${text(sx + 74, sy + 82, 40, 700, d.first.toUpperCase(), `${italic} fill="${ink}" fill-opacity="0.8" letter-spacing="1.5"`)}
  ${text(sx + 70, sy + 82 + surnameSize(d.last.length) * 0.9 + 4, surnameSize(d.last.length), 900, d.last.toUpperCase(), `${italic} fill="${ink}"`)}
  ${text(sx + 62, sy + sh - 34, 22, 700, `${t.name} · Qualified P${d.quali}`.toUpperCase(), `fill="${ink}" fill-opacity="0.75" letter-spacing="2.5"`)}
  ${tick}

  ${text(sx, 516, 18, 700, "OVER", 'fill="#f7f7f8" fill-opacity="0.45" letter-spacing="3"')}
  ${chips}

  <rect x="64" y="${called ? 448 : 420}" width="70" height="2" fill="${RED}"/>
  <rect x="134" y="${called ? 448 : 420}" width="430" height="2" fill="#ffffff" fill-opacity="0.12"/>
  ${text(64, called ? 480 : 456, 18, 700, "LOCKED IN", `fill="${RED}" letter-spacing="3.5"`)}
  ${text(564, called ? 480 : 456, 18, 700, `${shortSpan(race.start - p.lockedAt)} EARLY`, 'fill="#f7f7f8" fill-opacity="0.62" letter-spacing="3" text-anchor="end"')}
  <text x="64" y="${called ? 518 : 500}" font-family="JetBrains Mono" font-size="28" font-weight="500" fill="#ffffff">${esc(`${when.date} · ${when.time}`.toUpperCase())}<tspan dx="14" fill="#ffffff" fill-opacity="0.6">${esc(when.zone)}</tspan></text>
  <text x="64" y="${called ? 550 : 536}" font-family="Barlow Condensed" font-size="19" font-weight="800" fill="#ffffff" letter-spacing="1.5">BEFORE LIGHTS OUT<tspan dx="10" font-weight="600" fill="#f7f7f8" fill-opacity="0.62">${esc(`· ${race.name}`.toUpperCase())}</tspan></text>

  <polygon points="72,572 102,572 95,598 65,598" fill="${RED}"/>
  <path d="M74 585 L80 591 L92 579" fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/>
  ${text(112, 597, 32, 900, "CALLED IT", `${italic} fill="#ffffff"`)}
  <text x="1136" y="594" font-family="JetBrains Mono" font-size="17" font-weight="500" fill="#ffffff" fill-opacity="0.5" text-anchor="end">${esc(`${host}/predictions/${p.id}`)}</text>
  ${stampSvg}
</svg>`;
}

/** Broadcast speed lines across the top right (a masked pattern costs resvg ~0.5 s; plain lines don't). */
const SPEED_LINES = Array.from({ length: 50 }, (_, i) => {
  const x = 560 + i * 24;
  return `M${x} 0L${x - 340} 640`;
}).join("");

let ready: Promise<void> | null = null;

/** The SVG as a PNG. `wasm`: resvg's module (the Worker imports it compiled; Bun reads the file). */
export async function ogPng(svg: string, wasm: WebAssembly.Module | ArrayBuffer | Uint8Array, fonts: Uint8Array[]): Promise<Uint8Array> {
  ready ??= initWasm(wasm as WebAssembly.Module);
  await ready;
  const r = new Resvg(svg, { font: { fontBuffers: fonts, loadSystemFonts: false, defaultFontFamily: "Barlow Condensed" } });
  return r.render().asPng();
}
