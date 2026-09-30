// The block picker behind "+ Add block" (H3.10): the race blocks not on the screen yet, each once
// (H3.11), greyed out where there's no room for it, and the marketplace still to come.

import type { BlockDefinition } from "../blockkit/defineBlock";
import { columnRange, type Layout } from "./layout";

export interface PickerEntry {
  block: BlockDefinition;
  room: boolean;
}

/** Race blocks that aren't placed, in the app's order. */
export function unplaced(blocks: ReadonlyMap<string, BlockDefinition>, layout: Layout): BlockDefinition[] {
  return [...blocks.values()].filter((b) => b.sessions.includes("race") && !layout.blocks[b.id]);
}

/** Default width in whole columns, as the grid would place it. */
const defaultColumns = (block: BlockDefinition, columns: number) => {
  const { min, max } = columnRange(block, columns);
  return Math.min(Math.max(Math.round((block.width.default * columns) / 100), min), max);
};

export function BlockPicker({ entries, columns, onPick }: { entries: readonly PickerEntry[]; columns: number; onPick: (id: string) => void }) {
  return (
    <div className="flex flex-col">
      {entries.length === 0 && <p className="px-2 py-1.5 text-xs text-zinc-500">Every block is on the screen.</p>}
      {entries.map(({ block, room }) => (
        <button
          key={block.id}
          type="button"
          disabled={!room}
          onClick={() => onPick(block.id)}
          className="flex items-start gap-3 rounded px-2 py-1.5 text-left enabled:hover:bg-zinc-800 disabled:cursor-default"
        >
          <span className="min-w-0 flex-1">
            <span className={`block text-xs font-semibold ${room ? "text-zinc-100" : "text-zinc-500"}`}>{block.name}</span>
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
