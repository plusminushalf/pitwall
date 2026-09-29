// Colours for compared drivers: their team colour, readable on the dark background. When two
// drivers' colours are too close to tell apart (teammates, or similar liveries), the later one
// gets a lighter shade and a dashed line, so identity never rests on colour alone.

import type { DriverInfo } from "../types";

export interface CompareStyle {
  color: string; // css colour
  dash: number[]; // canvas line dash ([] = solid)
  shade: boolean; // lightened to tell it apart from an earlier driver
}

const DASH = [6, 4];
const MIN_DISTANCE = 12; // OKLab ΔE × 100 below which two colours read as the same
const MIN_LIGHTNESS = 0.55; // OKLab L on zinc-950: darker team colours are lifted

type Rgb = [number, number, number];

function parse(hex: string): Rgb {
  const n = parseInt(hex.replace("#", ""), 16);
  return Number.isNaN(n) ? [161, 161, 170] : [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const toHex = (rgb: Rgb) => `#${rgb.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0")).join("")}`;

function oklab([r, g, b]: Rgb): [number, number, number] {
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const [lr, lg, lb] = [lin(r), lin(g), lin(b)];
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

const distance = (a: Rgb, b: Rgb) => {
  const [l1, a1, b1] = oklab(a);
  const [l2, a2, b2] = oklab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2) * 100;
};

const mix = (a: Rgb, b: Rgb, f: number): Rgb => [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
const WHITE: Rgb = [255, 255, 255];

/** Styles for drivers in compare order (the first keeps its team colour). */
export function compareStyles(infos: (DriverInfo | undefined)[]): CompareStyle[] {
  const used: Rgb[] = [];
  return infos.map((info) => {
    let rgb = parse(info?.teamColour ?? "a1a1aa");
    for (let i = 0; i < 6 && oklab(rgb)[0] < MIN_LIGHTNESS; i++) rgb = mix(rgb, WHITE, 0.2);
    const clash = used.some((u) => distance(u, rgb) < MIN_DISTANCE);
    if (clash) {
      let lighter = mix(rgb, WHITE, 0.45);
      for (let i = 0; i < 3 && used.some((u) => distance(u, lighter) < MIN_DISTANCE); i++) lighter = mix(lighter, WHITE, 0.4);
      rgb = lighter;
    }
    used.push(rgb);
    return { color: toHex(rgb), dash: clash ? DASH : [], shade: clash };
  });
}

/** SVG stroke-dasharray for a style (legend swatches). */
export const dashArray = (s: CompareStyle) => (s.dash.length ? s.dash.join(" ") : undefined);
