// The block picker behind "+ Add block" (H3.10): every race block, also those on the screen already (a
// block can be placed more than once, H3.11), greyed out where there's no room for it, and the marketplace
// still to come.

import type { BlockDefinition } from "../blockkit/defineBlock";
import { LABEL_CLASS } from "../blockkit/ui/Label";
import { blockIdOf, columnRange, type Layout } from "./layout";

export interface PickerEntry {
  block: BlockDefinition;
  room: boolean;
  /** How many are on the screen already. */
  placed: number;
}

/** Race blocks in the app's order, with how many of each the layout places. */
export function raceBlocks(blocks: ReadonlyMap<string, BlockDefinition>, layout: Layout): { block: BlockDefinition; placed: number }[] {
  const ids = Object.entries(layout.blocks).map(([key, entry]) => blockIdOf(key, entry));
  return [...blocks.values()].filter((b) => b.sessions.includes("race")).map((block) => ({ block, placed: ids.filter((id) => id === block.id).length }));
}

/** Default width in whole columns, as the grid would place it. */
const defaultColumns = (block: BlockDefinition, columns: number) => {
  const { min, max } = columnRange(block, columns);
  return Math.min(Math.max(Math.round((block.width.default * columns) / 100), min), max);
};

export function BlockPicker({ entries, columns, onPick }: { entries: readonly PickerEntry[]; columns: number; onPick: (id: string) => void }) {
  return (
    <div className="flex flex-col">
      {entries.map(({ block, room, placed }) => (
        <button
          key={block.id}
          type="button"
          disabled={!room}
          onClick={() => onPick(block.id)}
          className="flex items-start gap-3 rounded px-2 py-1.5 text-left enabled:hover:bg-zinc-800 disabled:cursor-default"
        >
          {/* Without room: dimmed like a disabled button, but "No room" stays readable: it says why. */}
          <span className={`min-w-0 flex-1 ${room ? "" : "opacity-50"}`}>
            <span className="block text-xs font-semibold text-zinc-100">
              {block.name}
              {placed > 0 && <span className="ml-1.5 font-normal text-zinc-400">{placed === 1 ? "on screen" : `${placed} on screen`}</span>}
            </span>
            {block.description && <span className="block text-[11px] leading-snug text-zinc-400">{block.description}</span>}
          </span>
          <span className={`mt-px shrink-0 tabular-nums ${LABEL_CLASS}`}>{room ? `${defaultColumns(block, columns)} col` : "No room"}</span>
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
