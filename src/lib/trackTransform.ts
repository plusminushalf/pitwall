import type { TrackGeometry } from "../types";

export interface TrackTransform {
  (x: number, y: number): [number, number];
  scale: number; // screen px per track unit
}

/**
 * Map track coordinates to canvas pixels: rotate by the circuit's rotation
 * (counter-clockwise, y up), fit into the box with padding, and flip y for the screen.
 */
export function makeTrackTransform(track: TrackGeometry, width: number, height: number, padding: number): TrackTransform {
  const rad = (track.rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const rotate = (x: number, y: number): [number, number] => [x * cos - y * sin, x * sin + y * cos];

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  const extend = (xs: number[], ys: number[]) => {
    for (let i = 0; i < xs.length; i++) {
      const [rx, ry] = rotate(xs[i], ys[i]);
      minX = Math.min(minX, rx);
      maxX = Math.max(maxX, rx);
      minY = Math.min(minY, ry);
      maxY = Math.max(maxY, ry);
    }
  };
  extend(track.outline.x, track.outline.y);
  if (track.pitLane) extend(track.pitLane.x, track.pitLane.y);

  const scale = Math.min((width - 2 * padding) / (maxX - minX), (height - 2 * padding) / (maxY - minY));
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;

  const fn = ((x: number, y: number) => {
    const [rx, ry] = rotate(x, y);
    return [width / 2 + (rx - cx) * scale, height / 2 - (ry - cy) * scale];
  }) as TrackTransform;
  fn.scale = scale;
  return fn;
}
