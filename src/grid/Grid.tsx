// The middle of the race screen: the layout's widgets on the grid, exactly the height between the top bar
// and the timeline (layout.ts). Widget contents are at a fixed type size: a wider widget gets more room,
// not bigger text. The grid doesn't scroll; widgets that have more to show scroll inside themselves, and a
// widget given a height shorter than its contents scrolls as a whole.
//
// Edit mode (H3.10) adds chrome inside each box and a few layers around them; normal mode renders exactly
// the boxes. A drag moves its box by writing a transform from pointermove, and re-renders only when where
// it would land changes; the other widgets then glide to their new places (FLIP, transforms only: sizes
// snap, so canvases reallocate once per step rather than every frame).
//
// In normal mode, hovering a widget shows a button that fills the grid with it (the same widget, so it
// doesn't remount); a button in the same place, or Esc, puts it back. Not a layout change: nothing is saved.
//
// On a phone (usePhone) none of that: the same layout's widgets as one full-width column that scrolls
// (PhoneGrid), the tower first, each widget at its own height (layout.ts: phoneColumn). Edit mode is for
// desktops: the phone column ignores the store's editing flag and never saves, so the layout a user made
// on their desktop is exactly as they left it when they next open it there.

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Icon } from "../widgetkit/ui/Icon";
import { WidgetHost } from "../widgetkit/WidgetHost";
import type { WidgetDefinition, WidgetSettings } from "../widgetkit/defineWidget";
import { heightInputOf, orderOf, selectedDriverOf } from "../widgetkit/select";
import { track } from "../posthog";
import { useReplay } from "../store";
import { usePhone } from "../hooks/usePhone";
import { WidgetPicker, gridWidgets } from "./WidgetPicker";
import { BUILTIN_WIDGETS } from "./builtins";
import { WidgetChrome, ColumnGuides, DropPlaceholder, EmptySlot, IconButton, Popover, RowGuides, type ChromeState, type ResizeAxis } from "./EditChrome";
import {
  addWidget,
  canAdd,
  cutOff,
  dropTarget,
  fitHeight,
  fitsAsWell,
  freeSlots,
  heightEdge,
  moveWidget,
  removeWidget,
  resizeWidget,
  resizeHeight,
  type DropTarget,
  type EditContext,
} from "./edit";
import { boxesOf, pack, phoneColumn, ROW, type Box, type Layout } from "./layout";
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

/** Who a widget following the selection shows right now: who "Pinned" starts with. */
const showing = () => {
  const { race, selected, focused } = useReplay.getState();
  return race ? selectedDriverOf(orderOf(race), selected, focused, null) : null;
};

// Memoised (no props): it re-renders only on its own state, not on every 10 Hz commit of the app above it.
// The phone and desktop grids are separate components, so crossing the breakpoint (a window resized, a
// tablet turned) unmounts one and mounts the other: its observers and listeners go with it.
export const Grid = memo(function Grid() {
  return usePhone() ? <PhoneGrid /> : <DesktopGrid />;
});

/** The phone column: the layout's widgets full width, one under the other, scrolling as a whole. */
function PhoneGrid() {
  const layout = useLayout((s) => s.layout);
  const session = useReplay((s) => (s.session ? heightInputOf(s.session) : null));
  const selected = useReplay((s) => s.selected);
  const focused = useReplay((s) => s.focused);
  const input = useMemo(() => (session ? { ...session, selection: { selected, focused } } : null), [session, selected, focused]);
  const column = useMemo(() => (input ? phoneColumn(layout, BUILTIN_WIDGETS, input) : []), [layout, input]);
  return (
    <div className="min-h-0 overflow-y-auto overflow-x-hidden overscroll-contain">
      {column.map(({ id, widget, settings, height }) => (
        <PhoneBox key={id} id={id} widget={widget} settings={settings} height={height} />
      ))}
    </div>
  );
}

/**
 * A widget's own setting changes (the tower's Gap/Int toggle) on a phone: kept while the app is open, not
 * saved (the saved layout is the desktop's; the phone writes nothing to it).
 */
const setPhoneSettings = (id: string, settings: Partial<WidgetSettings>) => {
  const { layout, setLayout } = useLayout.getState();
  const entry = layout.widgets[id];
  if (entry) setLayout({ ...layout, widgets: { ...layout.widgets, [id]: { ...entry, settings } } });
};

/** One widget of the phone column, in the same host as on the desktop so it measures itself the same way. */
const PhoneBox = memo(function PhoneBox({ id, widget, settings, height }: { id: string; widget: WidgetDefinition; settings: Partial<WidgetSettings>; height: string }) {
  const onSettingsChange = useCallback((s: Partial<WidgetSettings>) => setPhoneSettings(id, s), [id]);
  return (
    // A hairline between neighbours, as between groups on the desktop; contained like a desktop box.
    <div data-widget={id} className="relative w-full border-zinc-800 [contain:layout_paint] not-first:border-t" style={{ height }}>
      <WidgetHost widget={widget} settings={settings} onSettingsChange={onSettingsChange} className="h-full w-full overflow-hidden" />
    </div>
  );
});

const DesktopGrid = memo(function DesktopGrid() {
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
  const placements = useMemo(() => (input ? pack(layout, BUILTIN_WIDGETS, input, size.height) : []), [layout, input, size.height]);
  const boxes = boxesOf(placements, size.width, layout.columns);

  // Edit mode.
  const [drag, setDrag] = useState<Drag | null>(null);
  const [resizing, setResizing] = useState<{ id: string; axis: ResizeAxis; blocked: boolean } | null>(null);
  const [settingsFor, setSettingsFor] = useState<string | null>(null);
  if (!editing && settingsFor) setSettingsFor(null);
  const ctx = useMemo<EditContext | null>(() => (input ? { widgets: BUILTIN_WIDGETS, input, gridHeight: size.height } : null), [input, size.height]);
  // While dragging, the others sit where the drop would put them (if it fits); the dragged box stays in
  // its old place and size, moved by its transform.
  const shownLayout = drag?.ok ? drag.preview : layout;
  const shown = useMemo(
    () => (shownLayout === layout ? placements : input ? pack(shownLayout, BUILTIN_WIDGETS, input, size.height) : []),
    [shownLayout, layout, placements, input, size.height],
  );
  const shownBoxes = shown === placements ? boxes : boxesOf(shown, size.width, layout.columns);

  // Boxes in a stable DOM order (the order they first appeared), so moves never reorder DOM nodes.
  const order = useRef<string[]>([]);
  const ids = new Set(shown.map((p) => p.id));
  order.current = [...order.current.filter((id) => ids.has(id)), ...shown.map((p) => p.id).filter((id) => !order.current.includes(id))];
  const byId = new Map(shown.map((p, i) => [p.id, i]));
  const originalBox = (id: string) => boxes[placements.findIndex((p) => p.id === id)];

  // Full screen (normal mode only): one widget over the whole grid. Edit mode, or the widget leaving the
  // layout (another session's layout, a shared link), puts it back.
  const [fullId, setFullId] = useState<string | null>(null);
  const full = fullId && !editing && byId.has(fullId) ? fullId : null;
  if (fullId && !full) setFullId(null);
  useEffect(() => {
    if (!full) return;
    // Before the replay's own Esc (clear selection), which the user didn't mean.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      e.preventDefault();
      setFullId(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [full]);

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
  // The drag or resize in progress, ended (as a cancel) if the grid unmounts under it: the window
  // listeners and the body cursor go with it, instead of outliving the grid (a tablet turned to the
  // phone layout mid-drag).
  const pending = useRef<(() => void) | null>(null);
  useEffect(() => () => pending.current?.(), []);

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
      const preview = moveWidget(start, startPlacements, id, target);
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
      pending.current = null;
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
    pending.current = () => end(false);
  }, []);

  const startResize = useCallback((id: string, side: "left" | "right", e: ReactPointerEvent) => {
    const { layout: start, ctx: c, size: s } = live.current;
    const entry = start.widgets[id];
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
      const next = resizeWidget(start, c, id, side, edge);
      const got = next.widgets[id];
      const reached = side === "right" ? got.x + got.width : got.x;
      // Refused (a neighbour can't give way, or it wouldn't fit): the grip turns red.
      if ((reached !== edge) !== blocked) {
        blocked = !blocked;
        setResizing({ id, axis: "width", blocked });
      }
      if (next !== useLayout.getState().layout) useLayout.getState().setLayout(next);
    };
    const end = () => {
      pending.current = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      document.body.style.cursor = "";
      setResizing(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    pending.current = end;
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
      // Always from the layout the resize started with, so going back gives back what the widgets under it gave up.
      const next = resizeHeight(start, c, id, y);
      // Refused (no room, or below the least height): the edge stops more than a snap from the pointer and turns red.
      if ((Math.abs(heightEdge(next, c, id)!.y - y) > ROW / 2 + 0.5) !== blocked) {
        blocked = !blocked;
        setResizing({ id, axis: "height", blocked });
      }
      if (next.widgets[id].height !== useLayout.getState().layout.widgets[id]?.height) useLayout.getState().setLayout(next);
    };
    const end = () => {
      pending.current = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      document.body.style.cursor = "";
      setResizing(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    pending.current = end;
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
      toggleFull: (id) => setFullId((open) => (open === id ? null : id)),
      remove: (id) => {
        setSettingsFor((open) => (open === id ? null : open));
        useLayout.getState().setLayout(removeWidget(useLayout.getState().layout, id));
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
    const preview = drag.ok ? shown : pack(drag.preview, BUILTIN_WIDGETS, input, size.height);
    const i = preview.findIndex((p) => p.id === drag.id);
    const box = boxesOf(preview, size.width, layout.columns)[i];
    // A refused spot may be below the bottom: keep its outline on screen.
    const top = Math.min(box.top, size.height - 40);
    return { ...box, top, height: Math.min(box.height, size.height - top) };
  }, [drag, input, shown, size, layout.columns]);

  const settingsWidget = settingsFor && byId.has(settingsFor) ? shown[byId.get(settingsFor)!].widget : undefined;
  const settingsBox = settingsFor && byId.has(settingsFor) ? shownBoxes[byId.get(settingsFor)!] : null;
  /** In edit mode, a widget pinned to a driver says who: two of the same widget can be told apart. */
  const labelOf = (widget: WidgetDefinition, settings: Partial<WidgetSettings> | undefined) => {
    const driver = settings?.driver;
    if (typeof driver !== "number") return widget.name;
    return `${widget.name} · ${session?.drivers.find((d) => d.number === driver)?.acronym ?? `#${driver}`}`;
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
          const isFull = full === id;
          const b = isFull ? { left: 0, top: 0, width: size.width, height: size.height } : dragged ? originalBox(id) : shownBoxes[byId.get(id)!];
          const settings = layout.widgets[id]?.settings ?? shownLayout.widgets[id].settings;
          return (
            <WidgetBox
              key={id}
              id={id}
              widget={p.widget}
              dividerTop={p.dividerTop && !isFull}
              dividerLeft={p.dividerLeft && !isFull}
              left={b.left}
              top={b.top}
              width={b.width}
              height={b.height}
              contentHeight={p.contentHeight > b.height ? p.contentHeight : null}
              full={isFull}
              label={labelOf(p.widget, settings)}
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
      {editing && settingsWidget && settingsBox && session && (
        <Popover
          anchor={{ left: settingsBox.left + settingsBox.width - 4, top: settingsBox.top + 28, align: "right" }}
          grid={ref}
          width={240}
          title={`${labelOf(settingsWidget, layout.widgets[settingsFor!]?.settings)} settings`}
          ignore="[data-settings-toggle]"
          onClose={() => setSettingsFor(null)}
        >
          <SettingsEditor
            widget={settingsWidget}
            settings={layout.widgets[settingsFor!]?.settings ?? {}}
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
          title="Add a widget"
          ignore="[data-picker-toggle]"
          onClose={() => useLayout.getState().closePicker()}
        >
          <WidgetPicker
            columns={layout.columns}
            entries={gridWidgets(BUILTIN_WIDGETS, layout, gridKind(ctx.input.info.kind)).map(({ widget, placed }) => ({
              widget,
              placed,
              room: canAdd(layout, ctx, widget.id, picker.slot),
            }))}
            onPick={(id) => {
              const next = addWidget(layout, ctx, id, picker.slot);
              if (next) {
                useLayout.getState().setLayout(next);
                track("widget_added", { widget_id: id, session_kind: gridKind(ctx.input.info.kind) });
              }
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
  setSettings: (id: string, settings: Partial<WidgetSettings>) => void;
  startMove: (id: string, e: ReactPointerEvent) => void;
  startResize: (id: string, side: "left" | "right", e: ReactPointerEvent) => void;
  startHeight: (id: string, e: ReactPointerEvent) => void;
  /** Back to the widget's own height (or the tallest that fits). */
  fitHeight: (id: string) => void;
  toggleSettings: (id: string) => void;
  /** Fills the grid with this widget, or puts it back. */
  toggleFull: (id: string) => void;
  remove: (id: string) => void;
}

/** One widget's box (and in edit mode its chrome). Memoised on plain values: moving a box doesn't re-render its widget. */
const WidgetBox = memo(function WidgetBox({
  id,
  widget,
  label,
  dividerTop,
  dividerLeft,
  left,
  top,
  width,
  height,
  contentHeight,
  full,
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
  widget: WidgetDefinition;
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
  /** Over the whole grid, on top of the others. */
  full: boolean;
  settings: Partial<WidgetSettings>;
  editing: boolean;
  state: ChromeState;
  axis: ResizeAxis | null;
  heightSide: "top" | "bottom";
  cutOff: boolean;
  settingsOpen: boolean;
  actions: BoxActions;
}) {
  const ref = useCallback((el: HTMLDivElement | null) => actions.register(id, el), [actions, id]);
  const onSettingsChange = useCallback((s: Partial<WidgetSettings>) => actions.setSettings(id, s), [actions, id]);
  const host = useMemo(
    () => (
      <WidgetHost
        widget={widget}
        settings={settings}
        onSettingsChange={onSettingsChange}
        className="w-full overflow-hidden"
        style={{ height: contentHeight ?? "100%" }}
      />
    ),
    [widget, settings, onSettingsChange, contentHeight],
  );
  const hasSettings = useMemo(() => shownFields(widget).length > 0, [widget]);
  // Floating: its own compositor layer, so the box and its shadow aren't repainted on every pointer move.
  const floating = state === "dragging" || state === "refused";
  return (
    // Contained: a widget's DOM changes restyle and relayout only inside its own box. The hairlines
    // between groups are the box's own top and left borders, outside the widget.
    <div
      ref={ref}
      data-widget={id}
      className={`group/box absolute border-zinc-800 [contain:strict] ${dividerTop ? "border-t" : ""} ${dividerLeft ? "border-l" : ""}${
        floating ? " z-20 bg-zinc-950 shadow-2xl will-change-transform" : full ? " z-30 bg-zinc-950" : ""
      }`}
      style={{ left, top, width, height }}
    >
      {/* Always there, scrolling or not, so a widget doesn't remount when its height changes. */}
      <div className={contentHeight == null ? "h-full" : "h-full overflow-y-auto overflow-x-hidden"}>{host}</div>
      {!editing && (
        // Bottom right, like a video player's, where no widget keeps its controls. Shown on hover (or focus)
        // until the widget is full screen, when it stays to put it back; a touch screen (a tablet) has no
        // hover, so there it's always shown.
        <span
          className={`absolute bottom-1 right-1 z-10 transition-opacity ${
            full ? "" : "opacity-0 focus-within:opacity-100 group-hover/box:opacity-100 pointer-coarse:opacity-100"
          }`}
        >
          <IconButton label={full ? `Shrink ${label} (Esc)` : `Fill the screen with ${label}`} onClick={() => actions.toggleFull(id)}>
            <Icon name={full ? "shrink" : "expand"} size={12} />
          </IconButton>
        </span>
      )}
      {editing && (
        <WidgetChrome
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
