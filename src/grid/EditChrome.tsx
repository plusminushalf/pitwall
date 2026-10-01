// Edit mode's chrome on the grid (H3.10): column and row guides, each block's frame (name, settings,
// remove, and the grips that change its width and height), free slots, the drop placeholder, and the popover shell. Quiet on purpose: thin rings
// and small controls over the race, which keeps playing underneath.

import { useEffect, useRef, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from "react";
import { ROW, type Box } from "./layout";

const SMALL_LABEL = "text-[10px] font-semibold uppercase tracking-wider";

/** The column edges, over the blocks (most fill their box) but under the dragged one and the popovers. */
export function ColumnGuides({ columns, width, strong }: { columns: number; width: number; strong: boolean }) {
  return (
    <div className="pointer-events-none absolute inset-0 z-[5]" aria-hidden>
      {Array.from({ length: columns - 1 }, (_, i) => (
        <div
          key={i}
          className={`absolute inset-y-0 w-px transition-colors ${strong ? "bg-zinc-100/[0.09]" : "bg-zinc-100/[0.05]"}`}
          style={{ left: Math.round(((i + 1) * width) / columns) }}
        />
      ))}
    </div>
  );
}

/** The lines a height resize snaps to (ROW apart from the top), shown only during one. */
export function RowGuides({ height }: { height: number }) {
  return (
    <div className="pointer-events-none absolute inset-0 z-[5]" aria-hidden>
      {Array.from({ length: Math.max(Math.ceil(height / ROW) - 1, 0) }, (_, i) => (
        <div key={i} className="absolute inset-x-0 h-px bg-zinc-100/[0.09]" style={{ top: (i + 1) * ROW }} />
      ))}
    </div>
  );
}

function IconButton({ label, onClick, children, ...rest }: { label: string; onClick: () => void; children: ReactNode; [data: `data-${string}`]: string }) {
  return (
    <button
      {...rest}
      type="button"
      aria-label={label}
      title={label}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.currentTarget.blur();
        onClick();
      }}
      className="flex h-5 w-5 items-center justify-center rounded border border-zinc-700 bg-zinc-900 text-zinc-400 hover:border-zinc-500 hover:text-zinc-100"
    >
      {children}
    </button>
  );
}

const GearIcon = () => (
  <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none" stroke="currentColor" aria-hidden>
    <circle cx="8" cy="8" r="2" strokeWidth="1.5" />
    <circle cx="8" cy="8" r="4.6" strokeWidth="1.5" />
    {Array.from({ length: 8 }, (_, i) => {
      const a = (i * Math.PI) / 4;
      return <line key={i} x1={8 + Math.cos(a) * 4.6} y1={8 + Math.sin(a) * 4.6} x2={8 + Math.cos(a) * 6.6} y2={8 + Math.sin(a) * 6.6} strokeWidth="2.2" />;
    })}
  </svg>
);

const CloseIcon = () => (
  <svg viewBox="0 0 16 16" className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
    <path d="M4 4l8 8M12 4l-8 8" />
  </svg>
);

/** "refused": dragged somewhere it doesn't fit; "blocked": a resize step that's refused. */
export type ChromeState = "idle" | "dragging" | "refused" | "resizing" | "blocked";
/** What a resize changes: the width (the grip on a side) or the height (the grip on the top or bottom edge). */
export type ResizeAxis = "width" | "height";

/**
 * Over one block in edit mode, inside its box: catches every pointer event so the block's own controls
 * (driver rows, the tower's toggle) don't fire, and starts moves and resizes.
 */
export function BlockChrome({
  name,
  hasSettings,
  settingsOpen,
  cutOff,
  state,
  axis,
  heightSide,
  onMoveStart,
  onResizeStart,
  onHeightStart,
  onFitHeight,
  onSettings,
  onRemove,
}: {
  name: string;
  hasSettings: boolean;
  settingsOpen: boolean;
  cutOff: boolean;
  state: ChromeState;
  /** While resizing: which handle is held. */
  axis: ResizeAxis | null;
  /** The edge a height change moves (edit.ts heightEdge()), where the height grip goes. */
  heightSide: "top" | "bottom";
  onMoveStart: (e: ReactPointerEvent) => void;
  onResizeStart: (side: "left" | "right", e: ReactPointerEvent) => void;
  onHeightStart: (e: ReactPointerEvent) => void;
  onFitHeight: () => void;
  onSettings: () => void;
  onRemove: () => void;
}) {
  const handle = (of: ResizeAxis) =>
    axis === of && state === "blocked" ? "border-red-400" : axis === of && state === "resizing" ? "border-zinc-200" : "border-zinc-500 group-hover/chrome:border-zinc-300";
  const ring =
    state === "blocked" || state === "refused"
      ? "ring-red-500/80"
      : state === "dragging"
        ? "ring-zinc-400 bg-zinc-950/40"
        : state === "resizing" || settingsOpen
          ? "ring-zinc-400"
          : "ring-zinc-700 hover:ring-zinc-500";
  return (
    <div
      className={`group/chrome absolute inset-0 z-10 touch-none ring-1 ring-inset ${ring} ${state === "dragging" || state === "refused" ? "cursor-grabbing" : "cursor-grab"}`}
      onPointerDown={(e) => {
        if (e.button === 0) onMoveStart(e);
      }}
    >
      <div className="absolute inset-x-1 top-1 flex items-start gap-1">
        <span className={`min-w-0 truncate rounded border border-zinc-800 bg-zinc-900 px-1.5 py-px leading-4 text-zinc-400 ${SMALL_LABEL}`}>{name}</span>
        {cutOff && (
          <span className={`min-w-0 truncate rounded bg-amber-500/15 px-1.5 py-px leading-4 text-amber-300 ${SMALL_LABEL}`} title="The bottom of this block is below the window: make the window taller or move blocks">
            Cut off at this window height
          </span>
        )}
        <span className="ml-auto flex shrink-0 gap-1">
          {hasSettings && (
            <IconButton label={`${name} settings`} onClick={onSettings} data-settings-toggle="">
              <GearIcon />
            </IconButton>
          )}
          <IconButton label={`Remove ${name}`} onClick={onRemove}>
            <CloseIcon />
          </IconButton>
        </span>
      </div>
      {state === "refused" && (
        <span className={`absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded border border-red-500/60 bg-red-950 px-1.5 py-px leading-4 text-red-300 ${SMALL_LABEL}`}>
          Doesn't fit
        </span>
      )}
      {(["left", "right"] as const).map((side) => (
        <div
          key={side}
          title="Drag to change the width"
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.stopPropagation();
            onResizeStart(side, e);
          }}
          className={`absolute top-1/2 flex h-12 w-2.5 -translate-y-1/2 cursor-ew-resize items-center ${side === "left" ? "left-0 justify-start pl-[3px]" : "right-0 justify-end pr-[3px]"}`}
        >
          <span className={`h-6 ${side === "left" ? "border-l-2" : "border-r-2"} ${handle("width")}`} />
        </div>
      ))}
      <div
        title="Drag to change the height · double-click to fit the contents"
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.stopPropagation();
          onHeightStart(e);
        }}
        onDoubleClick={(e) => {
          e.stopPropagation();
          onFitHeight();
        }}
        className={`absolute inset-x-4 flex h-2.5 cursor-ns-resize justify-center ${heightSide === "bottom" ? "bottom-0 items-end pb-[3px]" : "top-0 items-start pt-[3px]"}`}
      >
        <span className={`w-6 ${heightSide === "bottom" ? "border-b-2" : "border-t-2"} ${handle("height")}`} />
      </div>
    </div>
  );
}

/** Free room in edit mode: opens the picker for this spot. */
export function EmptySlot({ box, onAdd }: { box: Box; onAdd: () => void }) {
  if (box.height < 12 || box.width < 12) return null;
  return (
    <button
      type="button"
      data-picker-toggle=""
      onClick={(e) => {
        e.currentTarget.blur();
        onAdd();
      }}
      className={`absolute flex items-center justify-center rounded-md border border-dashed border-zinc-800 text-zinc-600 hover:border-zinc-600 hover:bg-zinc-900/60 hover:text-zinc-300 ${SMALL_LABEL}`}
      style={{ left: box.left + 3, top: box.top + 3, width: box.width - 6, height: box.height - 6 }}
    >
      {box.height >= 30 && box.width >= 70 && "+ Add block"}
    </button>
  );
}

/** Where the dragged block would land, or a red outline if it doesn't fit there (the dragged block says so). */
export function DropPlaceholder({ box, ok }: { box: Box; ok: boolean }) {
  return (
    <div
      className={`pointer-events-none absolute z-10 rounded-md border border-dashed ${
        ok ? "border-zinc-400 bg-zinc-100/[0.04]" : "border-red-500 bg-red-500/10"
      }`}
      style={{ left: box.left + 2, top: box.top + 2, width: box.width - 4, height: box.height - 4 }}
    />
  );
}

/** Calls `onClose` on Esc or a press outside `ref` (and outside elements matching `ignore`, its toggles). */
export function useDismiss(ref: RefObject<HTMLElement | null>, onClose: () => void, ignore: string) {
  const latest = useRef(onClose);
  latest.current = onClose;
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const target = e.target as Element | null;
      if (ref.current?.contains(target) || target?.closest?.(ignore)) return;
      latest.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Not also a "clear selection".
      e.stopPropagation();
      e.preventDefault();
      latest.current();
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [ref, ignore]);
}

/** The popover shell, like the shortcuts help: positioned in grid px, kept inside the grid. */
export function Popover({
  anchor,
  gridWidth,
  gridHeight,
  width,
  title,
  onClose,
  ignore,
  children,
}: {
  anchor: { left: number; top: number; align: "left" | "right" };
  gridWidth: number;
  gridHeight: number;
  width: number;
  title: string;
  onClose: () => void;
  ignore: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, onClose, ignore);
  const left = Math.min(Math.max(anchor.align === "right" ? anchor.left - width : anchor.left, 8), gridWidth - width - 8);
  const top = Math.min(Math.max(anchor.top, 8), Math.max(8, gridHeight - 120));
  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={title}
      className="absolute z-30 flex flex-col rounded-md border border-zinc-800 bg-zinc-900 p-3 shadow-xl"
      style={{ left, top, width, maxHeight: gridHeight - top - 8 }}
    >
      <p className={`mb-2 shrink-0 text-zinc-500 ${SMALL_LABEL}`}>{title}</p>
      <div className="-mx-1 min-h-0 overflow-y-auto px-1">{children}</div>
    </div>
  );
}
