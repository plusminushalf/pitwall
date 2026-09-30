// The middle of the race screen: the layout's blocks on a snap grid that grows with the screen.
// Columns share the width; each block's height is its width over its shape, and its contents are
// zoomed to that width (they're laid out at the block's default width, H3.8). Only this area scrolls.

import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { create } from "zustand";
import { BlockHost } from "../blockkit/BlockHost";
import { COLUMN_WIDTH, type BlockSettings } from "../blockkit/defineBlock";
import { shapeInputOf } from "../blockkit/select";
import { useReplay } from "../store";
import { BUILTIN_BLOCKS } from "./builtins";
import { DEFAULT_LAYOUT } from "./defaultLayout";
import { boxesOf, gridHeight, pack, type Layout } from "./layout";

/** The layout on screen. In memory for now: editing and saving it come with edit mode (step 3). */
export const useLayout = create<{ layout: Layout; setSettings: (id: string, settings: Partial<BlockSettings>) => void }>((set, get) => ({
  layout: DEFAULT_LAYOUT,
  setSettings: (id, settings) => {
    const { layout } = get();
    const entry = layout.blocks[id];
    if (entry) set({ layout: { ...layout, blocks: { ...layout.blocks, [id]: { ...entry, settings } } } });
  },
}));

export function Grid() {
  const layout = useLayout((s) => s.layout);
  const setSettings = useLayout((s) => s.setSettings);
  // Only what shapes depend on (fixed for the session): new live data doesn't re-render the grid.
  const input = useReplay((s) => (s.session ? shapeInputOf(s.session) : null));
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    const el = ref.current!;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const placements = useMemo(() => (input ? pack(layout, BUILTIN_BLOCKS, input) : []), [layout, input]);

  const boxes = boxesOf(placements, width, layout.columns);
  const height = gridHeight(placements, width, layout.columns);

  return (
    <div ref={ref} className="min-h-0 overflow-y-auto [scrollbar-gutter:stable]">
      {width > 0 && (
        <div className="relative" style={{ height }}>
          {placements.map((p, i) => {
            const box = boxes[i];
            const lastColumn = p.x + p.width >= layout.columns;
            return (
              // Contained: a block's DOM changes restyle and relayout only inside its own box.
              <div key={p.id} className="absolute [contain:strict]" style={box}>
                <BlockHost
                  block={p.block}
                  scale={box.width / (p.block.width.default * COLUMN_WIDTH)}
                  settings={layout.blocks[p.id].settings}
                  onSettingsChange={(s) => setSettings(p.id, s)}
                  className="h-full w-full overflow-hidden"
                />
                {/* Hairlines between blocks, drawn over their edges like the old panel borders. */}
                <div className={`pointer-events-none absolute inset-0 border-b border-zinc-800 ${lastColumn ? "" : "border-r"}`} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
