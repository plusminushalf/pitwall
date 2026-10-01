// The block picker behind "+ Add block" (H3.10): every race block, also those on the screen already (a
// block can be placed more than once, H3.11), greyed out where there's no room for it, and the marketplace
// still to come.

import type { BlockDefinition } from "../blockkit/defineBlock";
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
          <span className="min-w-0 flex-1">
            <span className={`block text-xs font-semibold ${room ? "text-zinc-100" : "text-zinc-500"}`}>
              {block.name}
              {placed > 0 && <span className="ml-1.5 font-normal text-zinc-500">{placed === 1 ? "on screen" : `${placed} on screen`}</span>}
            </span>
            {block.description && <span className={`block text-[11px] leading-snug ${room ? "text-zinc-400" : "text-zinc-600"}`}>{block.description}</span>}
          </span>
          <span className={`mt-px shrink-0 text-[10px] font-semibold uppercase tracking-wider tabular-nums ${room ? "text-zinc-500" : "text-zinc-600"}`}>
            {room ? `${defaultColumns(block, columns)} col` : "No room"}
          </span>
        </button>
      ))}
      <div className="mt-1.5 border-t border-zinc-800 pt-1.5">
        <button type="button" disabled className="flex w-full cursor-default items-center justify-between gap-3 rounded px-2 py-1.5 text-left">
          <span className="text-xs font-semibold text-zinc-500">Marketplace</span>
          <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-600">Coming soon</span>
        </button>
      </div>
    </div>
  );
}
