// The widget picker behind "+ Add widget" (H3.10): every widget for the session's kind (race or practice), also
// those on the screen already (a widget can be placed more than once, H3.11), greyed out where there's no room
// for it, and the marketplace still to come.

import type { WidgetDefinition } from "../widgetkit/defineWidget";
import { LABEL_CLASS } from "../widgetkit/ui/Label";
import { widgetIdOf, columnRange, type Layout } from "./layout";
import type { GridKind } from "./storage";

export interface PickerEntry {
  widget: WidgetDefinition;
  room: boolean;
  /** How many are on the screen already. */
  placed: number;
}

/** The widgets for `kind` sessions in the app's order, with how many of each the layout places. */
export function gridWidgets(widgets: ReadonlyMap<string, WidgetDefinition>, layout: Layout, kind: GridKind = "race"): { widget: WidgetDefinition; placed: number }[] {
  const ids = Object.entries(layout.widgets).map(([key, entry]) => widgetIdOf(key, entry));
  return [...widgets.values()].filter((b) => b.sessions.includes(kind)).map((widget) => ({ widget, placed: ids.filter((id) => id === widget.id).length }));
}

/** Default width in whole columns, as the grid would place it. */
const defaultColumns = (widget: WidgetDefinition, columns: number) => {
  const { min, max } = columnRange(widget, columns);
  return Math.min(Math.max(Math.round((widget.width.default * columns) / 100), min), max);
};

export function WidgetPicker({ entries, columns, onPick }: { entries: readonly PickerEntry[]; columns: number; onPick: (id: string) => void }) {
  return (
    <div className="flex flex-col">
      {entries.map(({ widget, room, placed }) => (
        <button
          key={widget.id}
          type="button"
          disabled={!room}
          onClick={() => onPick(widget.id)}
          className="flex items-start gap-3 rounded px-2 py-1.5 text-left enabled:hover:bg-zinc-800 disabled:cursor-default"
        >
          {/* Without room: dimmed like a disabled button, but "No room" stays readable: it says why. */}
          <span className={`min-w-0 flex-1 ${room ? "" : "opacity-50"}`}>
            <span className="block text-xs font-semibold text-zinc-100">
              {widget.name}
              {placed > 0 && <span className="ml-1.5 font-normal text-zinc-400">{placed === 1 ? "on screen" : `${placed} on screen`}</span>}
            </span>
            {widget.description && <span className="block text-[11px] leading-snug text-zinc-400">{widget.description}</span>}
          </span>
          <span className={`mt-px shrink-0 tabular-nums ${LABEL_CLASS}`}>{room ? `${defaultColumns(widget, columns)} col` : "No room"}</span>
        </button>
      ))}
      <div className="mt-1.5 border-t border-zinc-800 pt-1.5">
        <button type="button" disabled className="flex w-full cursor-default items-center justify-between gap-3 rounded px-2 py-1.5 text-left">
          <span className="text-xs font-semibold text-zinc-100 opacity-50">Marketplace</span>
          <span className={LABEL_CLASS}>Coming soon</span>
        </button>
      </div>
    </div>
  );
}
