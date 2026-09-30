import { useEffect, useMemo, useRef, useState } from "react";
import { deltaAt, distanceAtTime, positionAtDistance, positionAtTime, type DecodedLap, type MiniSector } from "../../engine/compare";
import type { CompareEntry } from "../../hooks/useCompare";
import { makeTrackTransform, type TrackTransform } from "../../lib/trackTransform";
import { ghost, useQuali } from "../../qualiStore";
import type { TrackGeometry } from "../../types";

const PADDING = 26;
const HIT_PX = 18;

interface Props {
  track: TrackGeometry;
  entries: CompareEntry[];
  sectors: MiniSector[];
}

/** Stroke the reference lap's own path between two distances. */
function strokeRange(ctx: CanvasRenderingContext2D, tf: TrackTransform, lap: DecodedLap, from: number, to: number) {
  ctx.beginPath();
  const a = positionAtDistance(lap, from);
  let [px, py] = tf(a.x, a.y);
  ctx.moveTo(px, py);
  for (let i = 0; i < lap.d.length; i++) {
    if (lap.d[i] <= from || lap.d[i] >= to) continue;
    [px, py] = tf(lap.x[i], lap.y[i]);
    ctx.lineTo(px, py);
  }
  const b = positionAtDistance(lap, to);
  [px, py] = tf(b.x, b.y);
  ctx.lineTo(px, py);
  ctx.stroke();
}

/** Stroke each mini-sector in its winner's colour, clipped to [from, to]. */
function strokeSectors(ctx: CanvasRenderingContext2D, tf: TrackTransform, lap: DecodedLap, sectors: MiniSector[], withTrace: CompareEntry[], from: number, to: number) {
  ctx.lineCap = "butt";
  ctx.lineWidth = 5;
  for (const s of sectors) {
    const style = withTrace[s.winner]?.style;
    const a = Math.max(s.from, from);
    const b = Math.min(s.to, to);
    if (!style || b <= a) continue;
    ctx.strokeStyle = style.color;
    ctx.setLineDash(style.dash.length ? [5, 3] : []);
    strokeRange(ctx, tf, lap, a, b);
  }
  ctx.setLineDash([]);
}

/** Short line across the track at a distance along the lap. */
function tick(ctx: CanvasRenderingContext2D, tf: TrackTransform, lap: DecodedLap, d: number, half: number) {
  const p = positionAtDistance(lap, Math.min(d, lap.length - 8));
  const q = positionAtDistance(lap, Math.min(d, lap.length - 8) + 8);
  const [ax0, ay0] = tf(p.x, p.y);
  const [bx, by] = tf(q.x, q.y);
  const len = Math.hypot(bx - ax0, by - ay0) || 1;
  const nx = -(by - ay0) / len;
  const ny = (bx - ax0) / len;
  const at = positionAtDistance(lap, d);
  const [ax, ay] = tf(at.x, at.y);
  ctx.beginPath();
  ctx.moveTo(ax - nx * half, ay - ny * half);
  ctx.lineTo(ax + nx * half, ay + ny * half);
  ctx.stroke();
}

export function CompareMap({ track, entries, sectors }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const withTrace = useMemo(() => entries.filter((e) => e.trace != null), [entries]);
  const ref = withTrace[0]?.trace ?? null;

  useEffect(() => {
    const el = wrapRef.current!;
    const ro = new ResizeObserver(([e]) => setSize({ w: Math.floor(e.contentRect.width), h: Math.floor(e.contentRect.height) }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Static layer: track, start line, corners and the mini-sector colouring.
  const layer = useMemo(() => {
    if (size.w <= 0 || size.h <= 0) return null;
    const dpr = window.devicePixelRatio || 1;
    const canvas = document.createElement("canvas");
    canvas.width = size.w * dpr;
    canvas.height = size.h * dpr;
    const ctx = canvas.getContext("2d")!;
    ctx.scale(dpr, dpr);
    const tf = makeTrackTransform(track, size.w, size.h, PADDING);
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    const { x, y } = track.outline;
    ctx.beginPath();
    for (let i = 0; i < x.length; i++) {
      const [px, py] = tf(x[i], y[i]);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.strokeStyle = "#18181b";
    ctx.lineWidth = 13;
    ctx.stroke();
    ctx.strokeStyle = "#3f3f46";
    ctx.lineWidth = 8;
    ctx.stroke();

    if (ref && sectors.length) {
      strokeSectors(ctx, tf, ref, sectors, withTrace, 0, ref.length);
      // Mini-sector boundaries: thin dark ticks.
      ctx.strokeStyle = "#09090b";
      ctx.lineWidth = 1.5;
      for (const s of sectors) tick(ctx, tf, ref, s.from, 4);
    }

    // Start / finish line.
    const [sx, sy] = tf(x[0], y[0]);
    const [nx2, ny2] = tf(x[2], y[2]);
    const len = Math.hypot(nx2 - sx, ny2 - sy) || 1;
    const px = -(ny2 - sy) / len;
    const py = (nx2 - sx) / len;
    ctx.strokeStyle = "#fafafa";
    ctx.lineWidth = 2.5;
    ctx.lineCap = "butt";
    ctx.beginPath();
    ctx.moveTo(sx - px * 9, sy - py * 9);
    ctx.lineTo(sx + px * 9, sy + py * 9);
    ctx.stroke();

    ctx.fillStyle = "#71717a";
    ctx.font = "500 9px ui-sans-serif, system-ui";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const offset = 16 / tf.scale;
    for (const c of track.corners) {
      const a = (c.angle * Math.PI) / 180;
      const [cx, cy] = tf(c.x + offset * Math.cos(a), c.y + offset * Math.sin(a));
      ctx.fillText(String(c.number), cx, cy);
    }
    return { canvas, tf, dpr };
  }, [size, track, ref, sectors, withTrace]);

  // Dynamic layer: hover cursor and ghost cars, every frame.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !layer) return;
    canvas.width = layer.canvas.width;
    canvas.height = layer.canvas.height;
    const ctx = canvas.getContext("2d")!;
    const { tf, dpr } = layer;
    const cssW = layer.canvas.width / dpr;
    const cssH = layer.canvas.height / dpr;
    let raf = 0;
    const draw = () => {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(layer.canvas, 0, 0);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const { hover, zoom } = useQuali.getState();
      // Charts zoomed: dim the map, then redraw the zoomed stretch at full strength with an outline.
      if (zoom && ref) {
        const [z0, z1] = [Math.max(0, zoom[0]), Math.min(ref.length, zoom[1])];
        ctx.fillStyle = "rgba(9,9,11,0.6)";
        ctx.fillRect(0, 0, cssW, cssH);
        ctx.lineJoin = "round";
        ctx.lineCap = "round";
        ctx.strokeStyle = "#e4e4e7";
        ctx.lineWidth = 12;
        strokeRange(ctx, tf, ref, z0, z1);
        ctx.strokeStyle = "#18181b";
        ctx.lineWidth = 9;
        strokeRange(ctx, tf, ref, z0, z1);
        ctx.strokeStyle = "#3f3f46";
        ctx.lineWidth = 8;
        strokeRange(ctx, tf, ref, z0, z1);
        strokeSectors(ctx, tf, ref, sectors, withTrace, z0, z1);
        ctx.strokeStyle = "#09090b";
        ctx.lineWidth = 1.5;
        for (const s of sectors) if (s.from > z0 && s.from < z1) tick(ctx, tf, ref, s.from, 4);
        ctx.strokeStyle = "#fafafa";
        ctx.lineWidth = 2;
        ctx.lineCap = "butt";
        tick(ctx, tf, ref, z0, 9);
        tick(ctx, tf, ref, z1, 9);
      }
      if (hover != null) {
        for (const e of withTrace) {
          const p = positionAtDistance(e.trace!, hover);
          const [cx, cy] = tf(p.x, p.y);
          ctx.strokeStyle = e.style.color;
          ctx.lineWidth = 2.5;
          ctx.beginPath();
          ctx.arc(cx, cy, 7, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
      const t = ghost.t;
      if (t > 0 && ref) {
        ctx.font = "700 10px ui-sans-serif, system-ui";
        ctx.textBaseline = "middle";
        ctx.textAlign = "left";
        const placed: { x: number; y: number }[] = [];
        // Reference on top.
        for (let k = withTrace.length - 1; k >= 0; k--) {
          const e = withTrace[k];
          const lap = e.trace!;
          const p = positionAtTime(lap, t);
          const [cx, cy] = tf(p.x, p.y);
          ctx.fillStyle = e.style.color;
          ctx.strokeStyle = "#09090b";
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(cx, cy, 6, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
          const d = distanceAtTime(lap, t);
          const gap = k === 0 ? "" : ` ${formatGap(t >= lap.duration ? (lap.duration - ref.duration) / 1000 : deltaAt(ref, lap, d))}`;
          const label = `${e.info.acronym}${gap}`;
          const w = ctx.measureText(label).width + 10;
          // Right of the dot unless that runs off the map; stacked clear of labels already placed.
          const lx = cx + 10 + w > cssW - 2 ? cx - 10 - w : cx + 10;
          let ly = Math.min(Math.max(cy, 8), cssH - 8);
          for (let step = 1; placed.some((p) => Math.abs(p.y - ly) < 15 && Math.abs(p.x - lx) < w); step++) {
            ly = Math.min(Math.max(cy + (step % 2 ? 1 : -1) * Math.ceil(step / 2) * 15, 8), cssH - 8);
            if (step > 8) break;
          }
          placed.push({ x: lx, y: ly });
          ctx.fillStyle = "rgba(9,9,11,0.85)";
          ctx.beginPath();
          ctx.roundRect(lx, ly - 7, w, 14, 3);
          ctx.fill();
          ctx.fillStyle = e.style.color;
          ctx.fillRect(lx, ly - 7, 2.5, 14);
          ctx.fillStyle = "#fafafa";
          ctx.fillText(label, lx + 6, ly + 0.5);
        }
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [layer, withTrace, ref, sectors]);

  /** Distance along the reference lap nearest to a point on the map, if close enough. */
  const nearest = (mx: number, my: number): number | null => {
    if (!layer || !ref) return null;
    let best: number | null = null;
    let bestD = HIT_PX;
    for (let i = 0; i < ref.d.length; i++) {
      const [px, py] = layer.tf(ref.x[i], ref.y[i]);
      const dd = Math.hypot(px - mx, py - my);
      if (dd < bestD) {
        bestD = dd;
        best = ref.d[i];
      }
    }
    return best;
  };
  const at = (e: React.PointerEvent | React.MouseEvent) => {
    const r = e.currentTarget.getBoundingClientRect();
    return nearest(e.clientX - r.left, e.clientY - r.top);
  };

  return (
    <div ref={wrapRef} className="relative min-h-0 flex-1">
      <canvas
        ref={canvasRef}
        className="absolute inset-0 cursor-crosshair"
        style={{ width: size.w, height: size.h }}
        role="img"
        aria-label="Track map coloured by the fastest compared driver in each mini-sector"
        onPointerMove={(e) => useQuali.getState().setHover(at(e))}
        onPointerLeave={() => useQuali.getState().setHover(null)}
        onClick={(e) => {
          const d = at(e);
          const s = d != null ? sectors.find((x) => d >= x.from && d <= x.to) : null;
          if (s) {
            const pad = (s.to - s.from) * 0.6;
            useQuali.getState().setZoom([Math.max(0, s.from - pad), Math.min(ref?.length ?? s.to, s.to + pad)]);
          }
        }}
      />
    </div>
  );
}

export const formatGap = (s: number) => `${s >= 0 ? "+" : "−"}${Math.abs(s).toFixed(3)}`;
