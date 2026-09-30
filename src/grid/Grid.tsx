// The middle of the race screen: the layout's blocks on the grid, exactly the height between the top bar
// and the timeline (layout.ts). Block contents are at a fixed type size: a wider block gets more room,
// not bigger text. Nothing here scrolls; blocks that have more to show scroll inside themselves.

import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { create } from "zustand";
import { BlockHost } from "../blockkit/BlockHost";
import type { BlockSettings } from "../blockkit/defineBlock";
import { heightInputOf } from "../blockkit/select";
import { useReplay } from "../store";
import { BUILTIN_BLOCKS } from "./builtins";
import { DEFAULT_LAYOUT } from "./defaultLayout";
import { boxesOf, pack, type Layout } from "./layout";

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

  const placements = useMemo(
    () => (session ? pack(layout, BUILTIN_BLOCKS, { ...session, selection: { selected, focused } }, size.height) : []),
    [layout, session, selected, focused, size.height],
  );
  const boxes = boxesOf(placements, size.width, layout.columns);

  return (
    <div ref={ref} className="relative min-h-0 overflow-hidden">
      {size.width > 0 &&
        placements.map((p, i) => (
          // Contained: a block's DOM changes restyle and relayout only inside its own box. The hairlines
          // between groups are the box's own top and left borders, outside the block.
          <div
            key={p.id}
            data-block={p.id}
            className={`absolute border-zinc-800 [contain:strict] ${p.dividerTop ? "border-t" : ""} ${p.dividerLeft ? "border-l" : ""}`}
            style={boxes[i]}
          >
            <BlockHost
              block={p.block}
              settings={layout.blocks[p.id].settings}
              onSettingsChange={(s) => setSettings(p.id, s)}
              className="h-full w-full overflow-hidden"
            />
          </div>
        ))}
    </div>
  );
}
