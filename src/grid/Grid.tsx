// The middle of the race screen: the layout's blocks on the grid, exactly the height between the top bar
// and the timeline (layout.ts). Block contents are at a fixed type size: a wider block gets more room,
// not bigger text. The grid doesn't scroll; blocks that have more to show scroll inside themselves, and a
// block given a height shorter than its contents scrolls as a whole.
//
// Edit mode (H3.10) adds chrome inside each box and a few layers around them; normal mode renders exactly
// the boxes. A drag moves its box by writing a transform from pointermove, and re-renders only when where
// it would land changes; the other blocks then glide to their new places (FLIP, transforms only: sizes
// snap, so canvases reallocate once per step rather than every frame).

import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { BlockHost } from "../blockkit/BlockHost";
import type { BlockDefinition, BlockSettings } from "../blockkit/defineBlock";
import { heightInputOf, orderOf, selectedDriverOf } from "../blockkit/select";
import { useReplay } from "../store";
import { BlockPicker, gridBlocks } from "./BlockPicker";
import { BUILTIN_BLOCKS } from "./builtins";
import { BlockChrome, ColumnGuides, DropPlaceholder, EmptySlot, Popover, RowGuides, type ChromeState, type ResizeAxis } from "./EditChrome";
import {
  addBlock,
  canAdd,
  cutOff,
  dropTarget,
  fitHeight,
  fitsAsWell,
  freeSlots,
  heightEdge,
  moveBlock,
  removeBlock,
  resizeBlock,
  resizeHeight,
  type DropTarget,
  type EditContext,
} from "./edit";
import { boxesOf, pack, ROW, type Box, type Layout } from "./layout";
import { SettingsEditor, shownFields } from "./SettingsEditor";
import { gridKind } from "./storage";
import { useLayout } from "./store";

export { useLayout } from "./store";

interface Drag {
  id: string;
  target: DropTarget;
  preview: Layout;
  ok: boolean;
}

const GLIDE: KeyframeAnimationOptions = { duration: 180, easing: "cubic-bezier(0.2, 0, 0, 1)" };

/** Who a block following the selection shows right now: who "Pinned" starts with. */
const showing = () => {
  const { race, selected, focused } = useReplay.getState();
  return race ? selectedDriverOf(orderOf(race), selected, focused, null) : null;
};

// Memoised (no props): it re-renders only on its own state, not on every 10 Hz commit of the app above it.
export const Grid = memo(function Grid() {
  const layout = useLayout((s) => s.layout);
  const editing = useLayout((s) => s.editing);
  const picker = useLayout((s) => s.picker);
  const setSettings = useLayout((s) => s.setSettings);
  // Only what heights depend on (session info and the selection): new live data doesn't re-render the grid.
  const session = useReplay((s) => (s.session ? heightInputOf(s.session) : null));
  const selected = useReplay((s) => s.selected);
  const focused = useReplay((s) => s.focused);
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useLayoutEffect(() => {
    const el = ref.current!;
    const measure = (box: { width: number; height: number }) =>
      setSize((s) => (s.width === box.width && s.height === box.height ? s : { width: box.width, height: box.height }));
    measure({ width: el.clientWidth, height: el.clientHeight });
    const ro = new ResizeObserver(([entry]) => measure(entry.contentRect));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const input = useMemo(() => (session ? { ...session, selection: { selected, focused } } : null), [session, selected, focused]);
  const placements = useMemo(() => (input ? pack(layout, BUILTIN_BLOCKS, input, size.height) : []), [layout, input, size.height]);
  const boxes = boxesOf(placements, size.width, layout.columns);

  // Edit mode.
  const [drag, setDrag] = useState<Drag | null>(null);
  const [resizing, setResizing] = useState<{ id: string; axis: ResizeAxis; blocked: boolean } | null>(null);
  const [settingsFor, setSettingsFor] = useState<string | null>(null);
  if (!editing && settingsFor) setSettingsFor(null);
  const ctx = useMemo<EditContext | null>(() => (input ? { blocks: BUILTIN_BLOCKS, input, gridHeight: size.height } : null), [input, size.height]);
  // While dragging, the others sit where the drop would put them (if it fits); the dragged box stays in
  // its old place and size, moved by its transform.
  const shownLayout = drag?.ok ? drag.preview : layout;
  const shown = useMemo(
    () => (shownLayout === layout ? placements : input ? pack(shownLayout, BUILTIN_BLOCKS, input, size.height) : []),
    [shownLayout, layout, placements, input, size.height],
  );
  const shownBoxes = shown === placements ? boxes : boxesOf(shown, size.width, layout.columns);

  // Boxes in a stable DOM order (the order they first appeared), so moves never reorder DOM nodes.
  const order = useRef<string[]>([]);
  const ids = new Set(shown.map((p) => p.id));
  order.current = [...order.current.filter((id) => ids.has(id)), ...shown.map((p) => p.id).filter((id) => !order.current.includes(id))];
  const byId = new Map(shown.map((p, i) => [p.id, i]));
  const originalBox = (id: string) => boxes[placements.findIndex((p) => p.id === id)];

  // FLIP: each box glides from where it was drawn to its new place.
  const els = useRef(new Map<string, HTMLDivElement>());
  const drawn = useRef(new Map<string, Box>());
  const glides = useRef(new Map<string, { anim: Animation; dx: number; dy: number }>());
  /** Where a box is on screen right now if not where it last rendered: a dropped box, moved by hand. */
  const from = useRef(new Map<string, { left: number; top: number }>());
  const drawnSize = useRef(size);
  useLayoutEffect(() => {
    // A window resize moves everything at once: that snaps, like in normal mode.
    const resized = drawnSize.current !== size;
    drawnSize.current = size;
    const next = new Map<string, Box>();
    for (const id of order.current) {
      const box = id === drag?.id ? originalBox(id) : shownBoxes[byId.get(id)!];
      next.set(id, box);
      const el = els.current.get(id);
      const was = drawn.current.get(id);
      // The dragged box follows the pointer and the resized one snaps with its edges, and so do the boxes
      // under a bottom edge being dragged (gliding, they'd trail behind it).
      if (!editing || resized || !el || id === drag?.id || id === resizing?.id || resizing?.axis === "height") continue;
      const glide = glides.current.get(id);
      const at = from.current.get(id) ?? (was && glide ? offsetNow(was, glide) : was);
      from.current.delete(id);
      if (!at) {
        el.animate([{ opacity: 0 }, { opacity: 1 }], GLIDE);
        continue;
      }
      const dx = at.left - box.left;
      const dy = at.top - box.top;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
      glide?.anim.cancel();
      const anim = el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], GLIDE);
      const entry = { anim, dx, dy };
      glides.current.set(id, entry);
      anim.onfinish = () => glides.current.get(id) === entry && glides.current.delete(id);
    }
    drawn.current = next;
  });

  // The latest values for the pointer handlers, which live across renders.
  const live = useRef({ layout, placements, boxes, ctx, size });
  live.current = { layout, placements, boxes, ctx, size };

  const startMove = useCallback((id: string, e: ReactPointerEvent) => {
    const { layout: start, placements: startPlacements, boxes: startBoxes, ctx: c, size: s } = live.current;
    const el = els.current.get(id);
    const box = startBoxes[startPlacements.findIndex((p) => p.id === id)];
    if (!c || !el || !box) return;
    e.preventDefault();
    setSettingsFor(null);
    useLayout.getState().closePicker();
    const x0 = e.clientX;
    const y0 = e.clientY;
    let dx = 0;
    let dy = 0;
    let current: Drag | null = null;

    const land = (d: Drag) => {
      if (current && current.target.x === d.target.x && current.target.index === d.target.index) return;
      current = d;
      setDrag(d);
    };
    const targetAt = (): Drag => {
      const target = dropTarget(start, startPlacements, id, box.left + dx, box.top + dy + box.height / 2, s.width);
      const preview = moveBlock(start, startPlacements, id, target);
      return { id, target, preview, ok: fitsAsWell(start, preview, c) };
    };
    const onMove = (ev: PointerEvent) => {
      dx = ev.clientX - x0;
      dy = ev.clientY - y0;
      if (!current) {
        if (Math.hypot(dx, dy) < 4) return;
        glides.current.get(id)?.anim.cancel();
        document.body.style.cursor = "grabbing";
      }
      el.style.transform = `translate(${dx}px, ${dy}px)`;
      land(targetAt());
    };
    const end = (drop: boolean) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKey, true);
      if (!current) return;
      document.body.style.cursor = "";
      el.style.transform = "";
      from.current.set(id, { left: box.left + dx, top: box.top + dy });
      if (drop && current.ok) useLayout.getState().setLayout(current.preview);
      setDrag(null);
    };
    const onUp = () => end(true);
    const onCancel = () => end(false);
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      // Esc cancels the drag, not the selection too.
      ev.stopPropagation();
      ev.preventDefault();
      end(false);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKey, true);
  }, []);

  const startResize = useCallback((id: string, side: "left" | "right", e: ReactPointerEvent) => {
    const { layout: start, ctx: c, size: s } = live.current;
    const entry = start.blocks[id];
    if (!c || !entry) return;
    e.preventDefault();
    setSettingsFor(null);
    useLayout.getState().closePicker();
    const x0 = e.clientX;
    const edge0 = side === "right" ? entry.x + entry.width : entry.x;
    let lastEdge = edge0;
    let blocked = false;
    setResizing({ id, axis: "width", blocked });
    document.body.style.cursor = "ew-resize";

    const onMove = (ev: PointerEvent) => {
      const edge = Math.round(edge0 + ((ev.clientX - x0) * start.columns) / s.width);
      if (edge === lastEdge) return;
      lastEdge = edge;
      // Always from the layout the resize started with, so going back undoes what neighbours gave up.
      const next = resizeBlock(start, c, id, side, edge);
      const got = next.blocks[id];
      const reached = side === "right" ? got.x + got.width : got.x;
      // Refused (a neighbour can't give way, or it wouldn't fit): the grip turns red.
      if ((reached !== edge) !== blocked) {
        blocked = !blocked;
        setResizing({ id, axis: "width", blocked });
      }
      if (next !== useLayout.getState().layout) useLayout.getState().setLayout(next);
    };
    const end = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      document.body.style.cursor = "";
      setResizing(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  }, []);

  const startHeight = useCallback((id: string, e: ReactPointerEvent) => {
    const { layout: start, ctx: c } = live.current;
    const edge = c && heightEdge(start, c, id);
    if (!c || !edge) return;
    e.preventDefault();
    setSettingsFor(null);
    useLayout.getState().closePicker();
    const y0 = e.clientY;
    let blocked = false;
    setResizing({ id, axis: "height", blocked });
    document.body.style.cursor = "ns-resize";

    const onMove = (ev: PointerEvent) => {
      const y = edge.y + ev.clientY - y0;
      // Always from the layout the resize started with, so going back gives back what the blocks under it gave up.
      const next = resizeHeight(start, c, id, y);
      // Refused (no room, or below the least height): the edge stops more than a snap from the pointer and turns red.
      if ((Math.abs(heightEdge(next, c, id)!.y - y) > ROW / 2 + 0.5) !== blocked) {
        blocked = !blocked;
        setResizing({ id, axis: "height", blocked });
      }
      if (next.blocks[id].height !== useLayout.getState().layout.blocks[id]?.height) useLayout.getState().setLayout(next);
    };
    const end = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      document.body.style.cursor = "";
      setResizing(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  }, []);

  // Stable, so a Grid render (a new drop target) re-renders only the boxes whose props changed.
  const actions = useMemo<BoxActions>(
    () => ({
      register: (id, el) => {
        if (el) els.current.set(id, el);
        else els.current.delete(id);
      },
      setSettings: (id, settings) => useLayout.getState().setSettings(id, settings),
      startMove,
      startResize,
      startHeight,
      fitHeight: (id) => {
        const { layout: l, ctx: c } = live.current;
        if (c) useLayout.getState().setLayout(fitHeight(l, c, id));
      },
      toggleSettings: (id) => setSettingsFor((open) => (open === id ? null : id)),
      remove: (id) => {
        setSettingsFor((open) => (open === id ? null : open));
        useLayout.getState().setLayout(removeBlock(useLayout.getState().layout, id));
      },
    }),
    [startMove, startResize, startHeight],
  );
  const cut = useMemo(() => new Set(editing && ctx ? cutOff(layout, ctx) : []), [editing, layout, ctx]);
  const heightSides = useMemo(
    () => new Map(editing && ctx ? placements.map((p) => [p.id, heightEdge(layout, ctx, p.id)?.side ?? "bottom"] as const) : []),
    [editing, layout, ctx, placements],
  );
  const colEdge = (c: number) => Math.round((c * size.width) / layout.columns);
  const slotBox = (slot: { x: number; width: number; top: number; height: number }): Box => ({
    left: colEdge(slot.x),
    width: colEdge(slot.x + slot.width) - colEdge(slot.x),
    top: slot.top,
    height: slot.height,
  });
  const slots = useMemo(() => (editing && !drag ? freeSlots(placements, layout.columns, size.height) : []), [editing, drag, placements, layout.columns, size.height]);
  const placeholder = useMemo(() => {
    if (!drag || !input) return null;
    const preview = drag.ok ? shown : pack(drag.preview, BUILTIN_BLOCKS, input, size.height);
    const i = preview.findIndex((p) => p.id === drag.id);
    const box = boxesOf(preview, size.width, layout.columns)[i];
    // A refused spot may be below the bottom: keep its outline on screen.
    const top = Math.min(box.top, size.height - 40);
    return { ...box, top, height: Math.min(box.height, size.height - top) };
  }, [drag, input, shown, size, layout.columns]);

  const settingsBlock = settingsFor && byId.has(settingsFor) ? shown[byId.get(settingsFor)!].block : undefined;
  const settingsBox = settingsFor && byId.has(settingsFor) ? shownBoxes[byId.get(settingsFor)!] : null;
  /** In edit mode, a block pinned to a driver says who: two of the same block can be told apart. */
  const labelOf = (block: BlockDefinition, settings: Partial<BlockSettings> | undefined) => {
    const driver = settings?.driver;
    if (typeof driver !== "number") return block.name;
    return `${block.name} · ${session?.drivers.find((d) => d.number === driver)?.acronym ?? `#${driver}`}`;
  };

  return (
    <div ref={ref} className={editing ? "relative min-h-0 select-none overflow-hidden" : "relative min-h-0 overflow-hidden"}>
      {slots.map((slot) => (
        <EmptySlot key={`${slot.x}:${Math.round(slot.top)}`} box={slotBox(slot)} onAdd={() => useLayout.getState().openPicker(slot)} />
      ))}
      {size.width > 0 &&
        order.current.map((id) => {
          const p = shown[byId.get(id)!];
          const dragged = drag?.id === id;
          const state: ChromeState = dragged ? (drag.ok ? "dragging" : "refused") : resizing?.id === id ? (resizing.blocked ? "blocked" : "resizing") : "idle";
          const b = dragged ? originalBox(id) : shownBoxes[byId.get(id)!];
          const settings = layout.blocks[id]?.settings ?? shownLayout.blocks[id].settings;
          return (
            <BlockBox
              key={id}
              id={id}
              block={p.block}
              dividerTop={p.dividerTop}
              dividerLeft={p.dividerLeft}
              left={b.left}
              top={b.top}
              width={b.width}
              height={b.height}
              contentHeight={p.contentHeight > p.height ? p.contentHeight : null}
              label={labelOf(p.block, settings)}
              settings={settings}
              editing={editing}
              state={state}
              axis={resizing?.id === id ? resizing.axis : null}
              heightSide={heightSides.get(id) ?? "bottom"}
              cutOff={cut.has(id)}
              settingsOpen={settingsFor === id}
              actions={actions}
            />
          );
        })}
      {editing && size.width > 0 && <ColumnGuides columns={layout.columns} width={size.width} strong={drag != null || resizing?.axis === "width"} />}
      {resizing?.axis === "height" && <RowGuides height={size.height} />}
      {placeholder && <DropPlaceholder box={placeholder} ok={drag!.ok} />}
      {editing && settingsBlock && settingsBox && session && (
        <Popover
          anchor={{ left: settingsBox.left + settingsBox.width - 4, top: settingsBox.top + 28, align: "right" }}
          grid={ref}
          width={240}
          title={`${labelOf(settingsBlock, layout.blocks[settingsFor!]?.settings)} settings`}
          ignore="[data-settings-toggle]"
          onClose={() => setSettingsFor(null)}
        >
          <SettingsEditor
            block={settingsBlock}
            settings={layout.blocks[settingsFor!]?.settings ?? {}}
            drivers={session.drivers}
            showing={showing}
            onChange={(s) => setSettings(settingsFor!, s)}
          />
        </Popover>
      )}
      {editing && picker && ctx && (
        <Popover
          anchor={picker.slot ? { left: slotBox(picker.slot).left + 6, top: picker.slot.top + 6, align: "left" } : { left: size.width - 8, top: 8, align: "right" }}
          grid={ref}
          width={288}
          title="Add a block"
          ignore="[data-picker-toggle]"
          onClose={() => useLayout.getState().closePicker()}
        >
          <BlockPicker
            columns={layout.columns}
            entries={gridBlocks(BUILTIN_BLOCKS, layout, gridKind(ctx.input.info.kind)).map(({ block, placed }) => ({
              block,
              placed,
              room: canAdd(layout, ctx, block.id, picker.slot),
            }))}
            onPick={(id) => {
              const next = addBlock(layout, ctx, id, picker.slot);
              if (next) useLayout.getState().setLayout(next);
              useLayout.getState().closePicker();
            }}
          />
        </Popover>
      )}
    </div>
  );
});

interface BoxActions {
  register: (id: string, el: HTMLDivElement | null) => void;
  setSettings: (id: string, settings: Partial<BlockSettings>) => void;
  startMove: (id: string, e: ReactPointerEvent) => void;
  startResize: (id: string, side: "left" | "right", e: ReactPointerEvent) => void;
  startHeight: (id: string, e: ReactPointerEvent) => void;
  /** Back to the block's own height (or the tallest that fits). */
  fitHeight: (id: string) => void;
  toggleSettings: (id: string) => void;
  remove: (id: string) => void;
}

/** One block's box (and in edit mode its chrome). Memoised on plain values: moving a box doesn't re-render its block. */
const BlockBox = memo(function BlockBox({
  id,
  block,
  label,
  dividerTop,
  dividerLeft,
  left,
  top,
  width,
  height,
  contentHeight,
  settings,
  editing,
  state,
  axis,
  heightSide,
  cutOff,
  settingsOpen,
  actions,
}: {
  id: string;
  block: BlockDefinition;
  /** Its name in edit mode. */
  label: string;
  dividerTop: boolean;
  dividerLeft: boolean;
  left: number;
  top: number;
  width: number;
  height: number;
  /** When it's taller than the box (a height set in edit mode): what the contents keep, scrolling. */
  contentHeight: number | null;
  settings: Partial<BlockSettings>;
  editing: boolean;
  state: ChromeState;
  axis: ResizeAxis | null;
  heightSide: "top" | "bottom";
  cutOff: boolean;
  settingsOpen: boolean;
  actions: BoxActions;
}) {
  const ref = useCallback((el: HTMLDivElement | null) => actions.register(id, el), [actions, id]);
  const onSettingsChange = useCallback((s: Partial<BlockSettings>) => actions.setSettings(id, s), [actions, id]);
  const host = useMemo(
    () => (
      <BlockHost
        block={block}
        settings={settings}
        onSettingsChange={onSettingsChange}
        className="w-full overflow-hidden"
        style={{ height: contentHeight ?? "100%" }}
      />
    ),
    [block, settings, onSettingsChange, contentHeight],
  );
  const hasSettings = useMemo(() => shownFields(block).length > 0, [block]);
  // Floating: its own compositor layer, so the box and its shadow aren't repainted on every pointer move.
  const floating = state === "dragging" || state === "refused";
  return (
    // Contained: a block's DOM changes restyle and relayout only inside its own box. The hairlines
    // between groups are the box's own top and left borders, outside the block.
    <div
      ref={ref}
      data-block={id}
      className={`absolute border-zinc-800 [contain:strict] ${dividerTop ? "border-t" : ""} ${dividerLeft ? "border-l" : ""}${
        floating ? " z-20 bg-zinc-950 shadow-2xl will-change-transform" : ""
      }`}
      style={{ left, top, width, height }}
    >
      {/* Always there, scrolling or not, so a block doesn't remount when its height changes. */}
      <div className={contentHeight == null ? "h-full" : "h-full overflow-y-auto overflow-x-hidden"}>{host}</div>
      {editing && (
        <BlockChrome
          name={label}
          hasSettings={hasSettings}
          settingsOpen={settingsOpen}
          cutOff={cutOff}
          state={state}
          axis={axis}
          heightSide={heightSide}
          onMoveStart={(e) => actions.startMove(id, e)}
          onResizeStart={(side, e) => actions.startResize(id, side, e)}
          onHeightStart={(e) => actions.startHeight(id, e)}
          onFitHeight={() => actions.fitHeight(id)}
          onSettings={() => actions.toggleSettings(id)}
          onRemove={() => actions.remove(id)}
        />
      )}
    </div>
  );
});

/** Where a gliding box is drawn right now: its place plus what's left of its glide. */
function offsetNow(box: Box, glide: { anim: Animation; dx: number; dy: number }) {
  const progress = glide.anim.effect?.getComputedTiming().progress ?? 1;
  const left = 1 - (progress ?? 1);
  return { left: box.left + glide.dx * left, top: box.top + glide.dy * left };
}
