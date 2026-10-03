import type { TrackGeometry } from "../types";
import type { TrackTransform } from "./trackTransform";

export interface CornerLabelStyle {
  /** From the racing line to the number's centre, CSS px. */
  offset: number;
  /** Font size, CSS px. */
  size: number;
  color: string;
  /** The map's background, drawn around names so a name across the track still reads. */
  background: string;
  /** Names too, where corners have them. */
  names: boolean;
}

/** Text drawn at x (left edge), y (middle), w wide. */
type Box = { x: number; y: number; w: number };

/**
 * Corner numbers on a track map, pushed off the racing line along each corner's label angle. With `names`, a corner's
 * name goes on the number's far side from the track: beside it where the label points sideways, else above or below
 * it. A complex's name is shown once, by the first of its corners where it clears the other labels and fits in the
 * map's `width` (CSS px), else by its first corner. Numbers are drawn last, so a name never hides one.
 */
export function drawCornerLabels(
  ctx: CanvasRenderingContext2D,
  tf: TrackTransform,
  corners: TrackGeometry["corners"],
  width: number,
  { offset, size, color, background, names }: CornerLabelStyle,
) {
  const away = offset / tf.scale;
  ctx.font = `500 ${size}px ui-sans-serif, system-ui`;
  const numbers: (Box & { text: string })[] = corners.map((c) => {
    const a = (c.angle * Math.PI) / 180;
    const [x, y] = tf(c.x + away * Math.cos(a), c.y + away * Math.sin(a));
    const text = `${c.number}${c.letter ?? ""}`;
    const w = ctx.measureText(text).width;
    return { x: x - w / 2, y, w, text };
  });
  ctx.fillStyle = color;
  ctx.textBaseline = "middle";

  if (names) {
    ctx.font = `400 ${size}px ui-sans-serif, system-ui`;
    ctx.textAlign = "left";
    ctx.lineJoin = "round";
    ctx.lineWidth = 3;
    ctx.strokeStyle = background;
    const taken: Box[] = [...numbers];
    const fits = (b: Box) => b.x >= 2 && b.x + b.w <= width - 2;
    const clear = (b: Box) => fits(b) && !taken.some((t) => Math.abs(t.y - b.y) < size && t.x < b.x + b.w + 2 && b.x < t.x + t.w + 2);
    /** Where a name w wide can go by corner k: beside its number if the label points sideways, then above or below. */
    const spots = (k: number, w: number): Box[] => {
      const n = numbers[k];
      const [px, py] = tf(corners[k].x, corners[k].y);
      const ux = (n.x + n.w / 2 - px) / offset;
      const under = { x: Math.min(Math.max(n.x + n.w / 2 - w / 2, 2), width - 2 - w), y: n.y + (n.y >= py ? 1 : -1) * (size + 2), w };
      return Math.abs(ux) >= 0.5 ? [{ x: ux > 0 ? n.x + n.w + 4 : n.x - 4 - w, y: n.y, w }, under] : [under];
    };
    for (let i = 0; i < corners.length; i++) {
      const name = corners[i].name;
      if (!name || name === corners[i - 1]?.name) continue;
      let last = i;
      while (corners[last + 1]?.name === name) last++;
      const w = ctx.measureText(name).width;
      const all = Array.from({ length: last - i + 1 }, (_, k) => spots(i + k, w)).flat();
      const spot = all.find(clear) ?? spots(i, w).find(fits) ?? spots(i, w).at(-1)!;
      ctx.strokeText(name, spot.x, spot.y);
      ctx.fillText(name, spot.x, spot.y);
      taken.push(spot);
    }
  }

  ctx.font = `500 ${size}px ui-sans-serif, system-ui`;
  ctx.textAlign = "left";
  for (const n of numbers) ctx.fillText(n.text, n.x, n.y);
}
