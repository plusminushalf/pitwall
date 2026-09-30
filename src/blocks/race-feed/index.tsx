import { memo, useCallback, useMemo, useState } from "react";
import {
  defineBlock,
  raceClock,
  teamColor,
  textOn,
  useDrivers,
  useFeed,
  usePlayback,
  useRadio,
  useSelection,
  useSessionInfo,
  type DriverInfo,
  type FeedEntry,
  type FeedKind,
} from "block-kit";

const LIMIT = 150;

type Group = "control" | "overtake" | "pit" | "radio";

const GROUPS: { id: Group; label: string }[] = [
  { id: "control", label: "Race control" },
  { id: "overtake", label: "Overtakes" },
  { id: "pit", label: "Pits & retirements" },
  { id: "radio", label: "Radio" },
];

const GROUP_OF: Record<FeedKind, Group> = {
  flag: "control",
  "safety-car": "control",
  stewards: "control",
  control: "control",
  overtake: "overtake",
  pit: "pit",
  retired: "pit",
  radio: "radio",
};

const ALL_ON: Record<Group, boolean> = { control: true, overtake: true, pit: true, radio: true };

const FLAG_TAG: Record<string, { label: string; className: string }> = {
  YELLOW: { label: "Yellow", className: "bg-yellow-400 text-black" },
  "DOUBLE YELLOW": { label: "Dbl yellow", className: "bg-yellow-400 text-black" },
  RED: { label: "Red flag", className: "bg-red-600 text-white" },
  GREEN: { label: "Green", className: "bg-emerald-600 text-white" },
  CLEAR: { label: "Clear", className: "bg-emerald-600 text-white" },
  BLUE: { label: "Blue flag", className: "bg-blue-500/25 text-blue-300" },
  CHEQUERED: { label: "Chequered", className: "bg-white text-black" },
  "BLACK AND WHITE": { label: "Black/white", className: "bg-zinc-200 text-black" },
};

function kindTag(item: FeedEntry): { label: string; className: string } {
  switch (item.kind) {
    case "flag":
      return FLAG_TAG[item.flag ?? ""] ?? { label: "Flag", className: "bg-zinc-700 text-zinc-100" };
    case "safety-car":
      return { label: item.text.includes("VIRTUAL") ? "VSC" : "Safety car", className: "bg-amber-400 text-black" };
    case "stewards":
      return { label: "Stewards", className: "bg-blue-600 text-white" };
    case "retired":
      return { label: "Retired", className: "bg-red-600 text-white" };
    case "pit":
      return { label: "Pit", className: "bg-zinc-200 text-zinc-900" };
    case "overtake":
      return { label: "Overtake", className: "bg-zinc-800 text-zinc-200" };
    case "radio":
      return { label: "Radio", className: "bg-zinc-800 text-zinc-300" };
    default:
      return { label: "Control", className: "bg-zinc-800 text-zinc-400" };
  }
}

/** A clip's play button; only radio rows have one, and only they subscribe to what's playing. */
function RadioButton({ url }: { url: string }) {
  const { playing, unavailable, play, stop } = useRadio((r) => ({ playing: r.playing === url, unavailable: r.unavailable.has(url), play: r.play, stop: r.stop }));
  if (unavailable) return <span className="shrink-0 pt-0.5 text-[10px] uppercase tracking-wide text-zinc-600">unavailable</span>;
  return (
    <button
      onClick={() => (playing ? stop() : play(url))}
      className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[9px] ${
        playing ? "bg-zinc-100 text-zinc-900" : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700 hover:text-white"
      }`}
      title={playing ? "Stop team radio" : "Play team radio"}
      aria-label={playing ? "Stop team radio" : "Play team radio"}
    >
      {playing ? "■" : "▶"}
    </button>
  );
}

/** One feed item: memoised on the entry (stable across ticks and live rebuilds), so old rows never re-render. */
const FeedRow = memo(function FeedRow({
  item,
  d,
  lightsOut,
  onItem,
}: {
  item: FeedEntry;
  d: DriverInfo | undefined;
  lightsOut: number;
  onItem: (item: FeedEntry) => void;
}) {
  const tag = kindTag(item);
  return (
    <li className="flex items-start gap-2 border-b border-zinc-900 px-3 py-1.5 hover:bg-zinc-900">
      <button onClick={() => onItem(item)} className="grid min-w-0 flex-1 grid-cols-[50px_minmax(0,1fr)] gap-2 text-left" title="Jump to 5 s before this">
        <span className="pt-0.5 text-[11px] tabular-nums text-zinc-500">{raceClock(item.t - lightsOut)}</span>
        <span className="text-xs leading-5 text-zinc-300">
          {item.postRace && (
            <span className="mr-1 inline-block rounded border border-zinc-700 px-1 align-middle text-[10px] font-semibold uppercase leading-4 text-zinc-400">
              post-race
            </span>
          )}
          <span className={`mr-1 inline-block rounded px-1 align-middle text-[10px] font-bold uppercase leading-4 ${tag.className}`}>{tag.label}</span>
          {item.driver != null && (
            <span
              className={`mr-1.5 inline-block rounded px-1 align-middle text-[10px] font-bold leading-4 ${d ? "" : "bg-zinc-700 text-zinc-100"}`}
              style={d ? { background: teamColor(d.teamColour), color: textOn(d.teamColour) } : undefined}
            >
              {d?.acronym ?? `#${item.driver}`}
            </span>
          )}
          <span className="align-middle">{item.text}</span>
        </span>
      </button>
      {item.kind === "radio" && item.url && <RadioButton url={item.url} />}
    </li>
  );
});

function RaceFeed() {
  const [groups, setGroups] = useState(ALL_ON);
  // The newest LIMIT items of the groups shown: a new item re-renders the list, nothing else does.
  const items = useFeed((feed) => feed.slice(0, LIMIT).filter((item) => groups[GROUP_OF[item.kind]]));
  const drivers = useDrivers();
  const lightsOut = useSessionInfo((i) => i.lightsOut);
  const seek = usePlayback((p) => p.seek);
  const focus = useSelection((s) => s.focus);
  const info = useMemo(() => new Map<number, DriverInfo>(drivers.map((d) => [d.number, d])), [drivers]);

  const onItem = useCallback(
    (item: FeedEntry) => {
      seek(item.t - 5_000);
      // Focus only: the track map filter (selection) stays as it is.
      if (item.driver != null) focus(item.driver);
    },
    [seek, focus],
  );

  return (
    <section className="flex h-full flex-col text-sm">
      <div className="border-b border-zinc-800 px-3 py-1.5">
        <h2 className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Race feed</h2>
        <div className="mt-1 flex flex-wrap gap-1">
          {GROUPS.map((g) => {
            const on = groups[g.id];
            return (
              <button
                key={g.id}
                onClick={() => setGroups((s) => ({ ...s, [g.id]: !s[g.id] }))}
                aria-pressed={on}
                className={`rounded-full border px-2 py-0.5 text-[11px] ${
                  on ? "border-zinc-600 bg-zinc-800 text-zinc-100" : "border-zinc-800 text-zinc-500 hover:text-zinc-300"
                }`}
              >
                {g.label}
              </button>
            );
          })}
        </div>
      </div>

      <ol className="min-h-0 flex-1 overflow-y-auto">
        {items.length === 0 && <li className="px-3 py-6 text-center text-xs text-zinc-600">No events yet</li>}
        {items.map((item) => (
          <FeedRow key={item.id} item={item} d={item.driver != null ? info.get(item.driver) : undefined} lightsOut={lightsOut} onItem={onItem} />
        ))}
      </ol>
    </section>
  );
}

export default defineBlock({
  id: "race-feed",
  name: "Race feed",
  version: "1.0.0",
  // Fixed: it scrolls inside, so the layout never jumps as items arrive. 11 rows at 3 columns.
  shape: 12 / 11,
  width: { min: 2, default: 3, max: 4 },
  sessions: ["race"],
  settings: {},
  Component: RaceFeed,
});
