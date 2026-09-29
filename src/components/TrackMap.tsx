import { useEffect, useMemo, useRef, useState } from "react";
import type { DriverData, Session } from "../data/session";
import { carPositionAt, mapOpacity, type SectorFlag } from "../engine/raceState";
import { TRACK_STATUS, teamColor } from "../lib/format";
import { makeTrackTransform, type TrackTransform } from "../lib/trackTransform";
import { clock, useReplay } from "../store";
import type { TrackGeometry } from "../types";

const PADDING = 56;
const HIT_RADIUS = 14;
const LABEL_H = 16;
const FLAG_COLORS: Record<SectorFlag, string> = { YELLOW: "#facc15", "DOUBLE YELLOW": "#f97316", RED: "#ef4444" };

interface StaticLayer {
  canvas: HTMLCanvasElement;
  tf: TrackTransform;
  dpr: number;
}

function tracePath(ctx: CanvasRenderingContext2D, tf: TrackTransform, xs: number[], ys: number[], from = 0, to = xs.length - 1) {
  ctx.beginPath();
  for (let i = from; i <= to; i++) {
    const [px, py] = tf(xs[i], ys[i]);
    if (i === from) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
}

/** Stroke outline points from..to, wrapping past the end of the lap when to < from. */
function strokeOutlineRange(ctx: CanvasRenderingContext2D, tf: TrackTransform, session: Session, from: number, to: number) {
  const { x, y } = session.meta.track.outline;
  if (to >= from) {
    tracePath(ctx, tf, x, y, from, to);
    ctx.stroke();
  } else {
    tracePath(ctx, tf, x, y, from, x.length - 1);
    const [px, py] = tf(x[0], y[0]);
    ctx.lineTo(px, py);
    ctx.stroke();
    tracePath(ctx, tf, x, y, 0, to);
    ctx.stroke();
  }
}

function drawStatic(track: TrackGeometry, w: number, h: number, dpr: number): StaticLayer {
  const canvas = document.createElement("canvas");
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext("2d")!;
  ctx.scale(dpr, dpr);
  const tf = makeTrackTransform(track, w, h, PADDING);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  if (track.pitLane) {
    ctx.strokeStyle = "#52525b";
    ctx.lineWidth = 3;
    ctx.setLineDash([5, 4]);
    tracePath(ctx, tf, track.pitLane.x, track.pitLane.y);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  const { x, y } = track.outline;
  tracePath(ctx, tf, x, y);
  ctx.closePath();
  ctx.strokeStyle = "#18181b";
  ctx.lineWidth = 16;
  ctx.stroke();
  ctx.strokeStyle = "#3f3f46";
  ctx.lineWidth = 10;
  ctx.stroke();

  // Start/finish line across the track.
  const [sx, sy] = tf(x[0], y[0]);
  const [nx, ny] = tf(x[2], y[2]);
  const len = Math.hypot(nx - sx, ny - sy) || 1;
  const px = -(ny - sy) / len;
  const py = (nx - sx) / len;
  ctx.strokeStyle = "#fafafa";
  ctx.lineWidth = 3;
  ctx.lineCap = "butt";
  ctx.beginPath();
  ctx.moveTo(sx - px * 11, sy - py * 11);
  ctx.lineTo(sx + px * 11, sy + py * 11);
  ctx.stroke();

  // Timing sector boundaries.
  ctx.fillStyle = "#a1a1aa";
  ctx.font = "600 10px ui-sans-serif, system-ui";
  track.sectorMarks.forEach((m, i) => {
    const [mx, my] = tf(m.x, m.y);
    ctx.beginPath();
    ctx.arc(mx, my, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillText(`S${i + 2}`, mx + 6, my - 6);
  });

  // Corner numbers, pushed off the racing line along the circuit's label angle.
  ctx.fillStyle = "#71717a";
  ctx.font = "500 10px ui-sans-serif, system-ui";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const offset = 20 / tf.scale;
  for (const c of track.corners) {
    const a = (c.angle * Math.PI) / 180;
    const [cx, cy] = tf(c.x + offset * Math.cos(a), c.y + offset * Math.sin(a));
    ctx.fillText(String(c.number), cx, cy);
  }

  return { canvas, tf, dpr };
}

export function TrackMap() {
  // Keyed on the track, not the session: live sessions are rebuilt every couple of seconds with the same track.
  const track = useReplay((s) => s.session?.meta.track);
  const trackStatus = useReplay((s) => s.race?.trackStatus ?? "GREEN");
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const carsOnScreen = useRef<{ driver: number; x: number; y: number }[]>([]);
  const [size, setSize] = useState({ w: 0, h: 0 });

  useEffect(() => {
    const el = containerRef.current!;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize({ w: Math.floor(width), h: Math.floor(height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const layer = useMemo(
    () => (track && size.w > 0 && size.h > 0 ? drawStatic(track, size.w, size.h, window.devicePixelRatio || 1) : null),
    [track, size],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !layer) return;
    canvas.width = layer.canvas.width;
    canvas.height = layer.canvas.height;
    const ctx = canvas.getContext("2d")!;
    const { tf, dpr } = layer;
    const cssW = layer.canvas.width / dpr;
    const cssH = layer.canvas.height / dpr;
    const labelSlots = new Map<number, number>(); // driver -> label corner used last frame
    let raf = 0;

    const draw = () => {
      const { session, race, selected, focused } = useReplay.getState();
      if (!session) {
        raf = requestAnimationFrame(draw);
        return;
      }
      const t = clock.t;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(layer.canvas, 0, 0);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.lineJoin = "round";
      ctx.lineCap = "round";

      if (race) {
        const tint = race.trackStatus === "RED" ? "#ef4444" : race.trackStatus.includes("SC") ? "#fbbf24" : null;
        if (tint) {
          ctx.globalAlpha = 0.45;
          ctx.strokeStyle = tint;
          ctx.lineWidth = 4;
          const { x, y } = session.meta.track.outline;
          tracePath(ctx, tf, x, y);
          ctx.closePath();
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
        ctx.lineWidth = 6;
        for (const [sector, flag] of race.sectorFlags) {
          const range = session.meta.track.marshalSectors.find((m) => m.number === sector);
          if (!range) continue;
          ctx.strokeStyle = FLAG_COLORS[flag];
          strokeOutlineRange(ctx, tf, session, range.from, range.to);
        }
      }

      // Draw back-markers first so the leader (and the focused car) end up on top.
      // With a selection, only the selected cars are drawn.
      const shown = selected.length > 0 ? new Set(selected) : null;
      const order = (race ? race.drivers.map((d) => d.driver).reverse() : session.driverNumbers).filter((n) => shown?.has(n) ?? true);
      const drawOrder = focused != null && order.includes(focused) ? [...order.filter((n) => n !== focused), focused] : order;
      const onScreen: { driver: number; x: number; y: number }[] = [];
      const cars: { n: number; d: DriverData; cx: number; cy: number; alpha: number }[] = [];
      const positions = new Map(race?.drivers.map((d) => [d.driver, d.position]));

      for (const n of drawOrder) {
        const d = session.drivers.get(n);
        if (!d) continue;
        const opacity = mapOpacity(d, t);
        if (opacity === 0) continue;
        const p = carPositionAt(d, t);
        if (!p) continue;
        const [cx, cy] = tf(p.x, p.y);
        const isFocused = n === focused;
        ctx.globalAlpha = opacity;
        onScreen.push({ driver: n, x: cx, y: cy });
        cars.push({ n, d, cx, cy, alpha: opacity });

        if (isFocused) {
          ctx.strokeStyle = "#fafafa";
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(cx, cy, 11, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.fillStyle = teamColor(d.info.teamColour);
        ctx.strokeStyle = "#09090b";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(cx, cy, isFocused ? 7.5 : 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }

      // Labels in priority order (focused car, then the leader down), each in the first corner
      // around its dot that doesn't overlap a label already placed; cars in a tight pack may go unlabelled.
      ctx.font = "700 11px ui-sans-serif, system-ui";
      ctx.textBaseline = "middle";
      ctx.textAlign = "left";
      const placed: { x: number; y: number; w: number }[] = [];
      const fits = (x: number, y: number, w: number) =>
        x >= 0 &&
        y >= 0 &&
        x + w <= cssW &&
        y + LABEL_H <= cssH &&
        placed.every((r) => x + w + 2 <= r.x || r.x + r.w + 2 <= x || y + LABEL_H + 2 <= r.y || r.y + LABEL_H + 2 <= y);
      for (let i = cars.length - 1; i >= 0; i--) {
        const { n, d, cx, cy, alpha } = cars[i];
        const isFocused = n === focused;
        const pos = positions.get(n);
        const label = d.info.acronym;
        const prefix = pos != null ? `${pos} ` : "";
        const prefixW = ctx.measureText(prefix).width;
        const labelW = prefixW + ctx.measureText(label).width + 10;
        // Corners: 0 above right, 1 below right, 2 above left, 3 below left.
        const corner = (k: number): [number, number] => [k < 2 ? cx + 10 : cx - 10 - labelW, k % 2 === 0 ? cy - 19 : cy + 3];
        // Try last frame's corner first so labels don't flicker between corners.
        const previous = labelSlots.get(n) ?? 0;
        let slot = [previous, 0, 1, 2, 3].find((k) => fits(...corner(k), labelW));
        if (slot == null) {
          if (!isFocused) continue;
          slot = previous;
        }
        const [lx, top] = corner(slot);
        labelSlots.set(n, slot);
        placed.push({ x: lx, y: top, w: labelW });

        const ly = top + LABEL_H / 2;
        ctx.globalAlpha = alpha;
        ctx.fillStyle = isFocused ? "rgba(250,250,250,0.95)" : "rgba(9,9,11,0.8)";
        ctx.beginPath();
        ctx.roundRect(lx, top, labelW, LABEL_H, 3);
        ctx.fill();
        ctx.fillStyle = teamColor(d.info.teamColour);
        ctx.fillRect(lx, top, 2.5, LABEL_H);
        ctx.fillStyle = isFocused ? "#52525b" : "#a1a1aa";
        ctx.fillText(prefix, lx + 6, ly + 0.5);
        ctx.fillStyle = isFocused ? "#09090b" : "#fafafa";
        ctx.fillText(label, lx + 6 + prefixW, ly + 0.5);
      }
      ctx.globalAlpha = 1;
      carsOnScreen.current = onScreen;
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [layer]);

  const onClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    let best: { driver: number; d: number } | null = null;
    for (const c of carsOnScreen.current) {
      const d = Math.hypot(c.x - mx, c.y - my);
      if (d <= HIT_RADIUS && (!best || d < best.d)) best = { driver: c.driver, d };
    }
    // Toggle the car in the selection; clicks on empty track leave the selection alone.
    if (best) useReplay.getState().toggleSelected(best.driver);
  };

  const banner = trackStatus !== "GREEN" ? TRACK_STATUS[trackStatus] : null;

  return (
    <div ref={containerRef} className="relative h-full w-full overflow-hidden">
      <canvas
        ref={canvasRef}
        onClick={onClick}
        className="absolute inset-0 h-full w-full cursor-crosshair"
        style={{ width: size.w, height: size.h }}
      />
      {banner && (
        <div className={`absolute left-1/2 top-3 -translate-x-1/2 rounded px-4 py-1 text-sm font-bold uppercase tracking-wider shadow-lg ${banner.className}`}>
          {banner.label}
        </div>
      )}
    </div>
  );
}
