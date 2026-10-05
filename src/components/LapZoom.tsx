import { useRef, type KeyboardEvent, type PointerEvent } from "react";
import { nearestEdge, type LapWindow } from "../engine/lapWindow";

/** What a drag on the rail moves: an end of the window, the whole window, or a new window drawn from `anchor`. */
type Drag = { mode: "from" | "to" | "pan" | "new"; anchor: number; edges: [number, number] };

interface Props {
  /** The lap boundaries' times (lapEdges): edges[0] the start of lap 1, edges[n] the end of lap n. */
  edges: readonly number[];
  value: LapWindow;
  /** The timeline's position of a time, and the time under the pointer. */
  pct: (ms: number) => string;
  timeAt: (clientX: number) => number;
  onChange: (w: [number, number] | null) => void;
  onHover: (over: boolean) => void;
}

/**
 * The timeline's zoom rail, under its lap numbers: the laps every lap chart shows. Drag an end to zoom, the window
 * to move it, or across the rail to pick new laps; a double-click (or the arrow keys on an end) changes it back.
 */
export function LapZoom({ edges, value: win, pct, timeAt, onChange, onHover }: Props) {
  const drag = useRef<Drag | null>(null);
  const laps = edges.length - 1;
  // The window as edges: from the start of its first lap to the end of its last.
  const lo = win.from - 1;
  const hi = win.to;
  const set = (a: number, b: number) => onChange(a === 0 && b === laps ? null : [a + 1, b]);
  const edgeAt = (clientX: number) => nearestEdge(edges, timeAt(clientX));

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    // Not a scrub of the timeline.
    e.stopPropagation();
    if (e.button !== 0 || laps < 2) return;
    const grip = (e.target as HTMLElement).closest<HTMLElement>("[data-grip]")?.dataset.grip;
    const mode = grip === "from" || grip === "to" || grip === "pan" ? grip : "new";
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { mode, anchor: edgeAt(e.clientX), edges: [lo, hi] };
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const at = edgeAt(e.clientX);
    const [a, b] = d.edges;
    if (d.mode === "from") set(Math.min(at, b - 2), b);
    else if (d.mode === "to") set(a, Math.max(at, a + 2));
    else if (d.mode === "pan") {
      const by = Math.min(Math.max(at - d.anchor, -a), laps - b);
      set(a + by, b + by);
    } else if (Math.abs(at - d.anchor) >= 2) set(Math.min(at, d.anchor), Math.max(at, d.anchor));
  };
  const end = () => (drag.current = null);

  // An end, by keyboard: a lap at a time (Escape: the whole race).
  const onKey = (which: "from" | "to") => (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0;
    if (e.key === "Escape" && win.zoomed) {
      e.preventDefault();
      return onChange(null);
    }
    if (!step) return;
    e.preventDefault();
    if (which === "from") set(Math.min(Math.max(lo + step, 0), hi - 2), hi);
    else set(lo, Math.max(Math.min(hi + step, laps), lo + 2));
  };

  const knob = `h-3 w-1.5 rounded-sm transition-colors ${win.zoomed ? "bg-zinc-100" : "bg-zinc-500 group-hover/zoom:bg-zinc-300"}`;
  const grip = (which: "from" | "to") => (
    <div
      data-grip={which}
      role="slider"
      tabIndex={0}
      aria-label={which === "from" ? "First lap in the lap charts" : "Last lap in the lap charts"}
      aria-valuemin={1}
      aria-valuemax={laps}
      aria-valuenow={which === "from" ? win.from : win.to}
      onKeyDown={onKey(which)}
      className={`absolute -inset-y-1 flex w-3 cursor-ew-resize items-center justify-center rounded-sm outline-none focus-visible:ring-1 focus-visible:ring-zinc-300 ${
        which === "from" ? "-left-1.5" : "-right-1.5"
      }`}
    >
      <span className={knob} />
    </div>
  );

  return (
    <div
      className="group/zoom absolute inset-x-0 top-[60px] h-2 cursor-crosshair rounded-full bg-zinc-900"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onChange(null);
      }}
      onPointerEnter={() => onHover(true)}
      onPointerLeave={() => onHover(false)}
    >
      <div
        data-grip="pan"
        className={`absolute inset-y-0 cursor-grab rounded-full transition-colors active:cursor-grabbing ${
          win.zoomed ? "bg-zinc-600 hover:bg-zinc-500" : "bg-zinc-800 group-hover/zoom:bg-zinc-700"
        }`}
        style={{ left: pct(edges[lo]), width: `calc(${pct(edges[hi])} - ${pct(edges[lo])})` }}
      >
        {grip("from")}
        {grip("to")}
      </div>
    </div>
  );
}
