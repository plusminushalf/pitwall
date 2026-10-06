import { memo, useCallback, useMemo, useState } from "react";
import {
  defineWidget,
  DriverTag,
  Icon,
  Label,
  raceClock,
  TAP_CLASS,
  useDrivers,
  useFeed,
  usePlayback,
  useRadio,
  useSelection,
  useSessionInfo,
  useSettings,
  type DriverInfo,
  type FeedEntry,
  type FeedKind,
} from "widget-kit";

const LIMIT = 150;

type Group = "control" | "overtake" | "pit" | "radio";
type Show = "all" | "selected";
/** With the selected drivers shown: every pass they're in, only the ones they made, or only the ones made on them. */
type Passes = "both" | "made" | "lost";
type Settings = { show: Show; passes: Passes };

const PASSES: { id: Passes; label: string; title: string }[] = [
  { id: "both", label: "Both", title: "Passes the selected drivers made, and passes made on them" },
  { id: "made", label: "Made", title: "Only passes the selected drivers made" },
  { id: "lost", label: "Lost", title: "Only passes made on the selected drivers" },
];

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
  if (unavailable) return <span className="shrink-0 pt-0.5 text-[11px] uppercase tracking-wide text-zinc-400">unavailable</span>;
  return (
    <button
      onClick={() => (playing ? stop() : play(url))}
      className={`${TAP_CLASS} flex h-5 w-5 shrink-0 items-center justify-center rounded-full ${
        playing ? "bg-zinc-100 text-zinc-900" : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700 hover:text-white"
      }`}
      title={playing ? "Stop team radio" : "Play team radio"}
      aria-label={playing ? "Stop team radio" : "Play team radio"}
    >
      <Icon name={playing ? "stop" : "play"} size={10} className={playing ? "" : "translate-x-px"} />
    </button>
  );
}

/** The car a row is about: the one race control named, else the first inferred from telemetry. */
const driverOf = (item: FeedEntry) => item.driver ?? item.inferred?.[0] ?? null;

/** Every car a row is about: race control's, the car passed, and those inferred from telemetry. */
const carsOf = (item: FeedEntry) => [item.driver, item.passed, ...(item.inferred ?? [])];

/** Whether a row is about the selected drivers; an overtake can be narrowed to the passer (made) or the car passed (lost). */
function aboutSelected(item: FeedEntry, selected: readonly number[], passes: Passes): boolean {
  const isSelected = (n: number | null | undefined) => n != null && selected.includes(n);
  if (item.kind === "overtake" && passes !== "both") return isSelected(passes === "made" ? item.driver : item.passed);
  return carsOf(item).some(isSelected);
}

/** Items Pitwall words itself, each starting with its driver's acronym ("VER passes HAD for P3"). */
const OWN_WORDS = new Set<FeedKind>(["overtake", "radio", "pit", "retired"]);

/** The row's text after its driver tag, which already shows the acronym; race control's messages stay word for word. */
function textAfterTag(item: FeedEntry, d: DriverInfo | undefined): string {
  const prefix = d && OWN_WORDS.has(item.kind) ? `${d.acronym} ` : null;
  return prefix && item.text.startsWith(prefix) ? item.text.slice(prefix.length) : item.text;
}

/** One feed item: memoised on the entry (stable across ticks and live rebuilds), so old rows never re-render. */
const FeedRow = memo(function FeedRow({
  item,
  info,
  lightsOut,
  onItem,
}: {
  item: FeedEntry;
  info: Map<number, DriverInfo>;
  lightsOut: number;
  onItem: (item: FeedEntry) => void;
}) {
  const tag = kindTag(item);
  const driver = item.driver != null ? info.get(item.driver) : undefined;
  return (
    <li className="flex items-start gap-2 border-b border-zinc-900 px-3 py-1.5 hover:bg-zinc-900">
      <button onClick={() => onItem(item)} className="grid min-w-0 flex-1 grid-cols-[50px_minmax(0,1fr)] gap-2 rounded-sm text-left" title="Jump to 5 s before this">
        <span className="pt-0.5 text-[11px] tabular-nums text-zinc-400">{raceClock(item.t - lightsOut)}</span>
        <span className="text-xs leading-5 text-zinc-300">
          {item.postRace && (
            <span className="mr-1 inline-block rounded border border-zinc-700 px-1 align-middle text-[11px] font-semibold uppercase leading-4 text-zinc-400">
              post-race
            </span>
          )}
          <span className={`mr-1 inline-block rounded px-1 align-middle text-[11px] font-bold uppercase leading-4 ${tag.className}`}>{tag.label}</span>
          {item.driver != null ? (
            <DriverTag driver={driver} number={item.driver} className="mr-1.5" />
          ) : (
            item.inferred?.map((n) => <DriverTag key={n} driver={info.get(n)} number={n} title="Inferred from telemetry" className="mr-1.5" />)
          )}
          <span className="align-middle">{textAfterTag(item, driver)}</span>
        </span>
      </button>
      {item.kind === "radio" && item.url && <RadioButton url={item.url} />}
    </li>
  );
});

function RaceFeed() {
  const [groups, setGroups] = useState(ALL_ON);
  const [{ show, passes }, update] = useSettings<Settings>();
  const selected = useSelection((s) => s.selected);
  const filtered = show === "selected";
  // The newest LIMIT items shown (by kind, and by selected driver when filtered): a new item re-renders the list, nothing else does.
  const items = useFeed((feed) => {
    const shown: FeedEntry[] = [];
    for (const item of feed) {
      if (!groups[GROUP_OF[item.kind]]) continue;
      if (filtered && !aboutSelected(item, selected, passes)) continue;
      if (shown.push(item) === LIMIT) break;
    }
    return shown;
  });
  const drivers = useDrivers();
  const lightsOut = useSessionInfo((i) => i.lightsOut);
  const practice = useSessionInfo((i) => i.kind === "practice");
  const seek = usePlayback((p) => p.seek);
  const focus = useSelection((s) => s.focus);
  const info = useMemo(() => new Map<number, DriverInfo>(drivers.map((d) => [d.number, d])), [drivers]);

  const onItem = useCallback(
    (item: FeedEntry) => {
      seek(item.t - 5_000);
      // Focus only: the track map filter (selection) stays as it is.
      const n = driverOf(item);
      if (n != null) focus(n);
    },
    [seek, focus],
  );

  return (
    <section className="flex h-full flex-col text-sm">
      <div className="border-b border-zinc-800 px-3 py-1.5">
        <div className="flex items-center gap-2">
          <Label as="h2">{practice ? "Session feed" : "Race feed"}</Label>
          <div className="ml-auto flex shrink-0 rounded-md bg-zinc-900 p-0.5">
            {(["all", "selected"] as const).map((v) => (
              <button
                key={v}
                onClick={() => update({ show: v })}
                aria-pressed={show === v}
                className={`${TAP_CLASS} rounded px-2 text-[11px] leading-5 ${show === v ? "bg-zinc-700 text-zinc-50" : "text-zinc-300 hover:text-white"}`}
                title={v === "all" ? "Every driver" : "Only the selected drivers"}
              >
                {v === "all" ? "All" : "Selected"}
              </button>
            ))}
          </div>
        </div>
        <div className="mt-1 flex flex-wrap gap-1">
          {GROUPS.filter((g) => !practice || g.id !== "overtake").map((g) => {
            const on = groups[g.id];
            return (
              <button
                key={g.id}
                onClick={() => setGroups((s) => ({ ...s, [g.id]: !s[g.id] }))}
                aria-pressed={on}
                className={`${TAP_CLASS} rounded-full border px-2 py-0.5 text-[11px] transition-colors ${
                  on ? "border-zinc-600 bg-zinc-800 text-zinc-100" : "border-zinc-800 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200"
                }`}
              >
                {g.label}
              </button>
            );
          })}
          {filtered && groups.overtake && !practice && (
            <div className="ml-auto flex shrink-0 items-center gap-1.5">
              <span className="text-[11px] text-zinc-400">Passes</span>
              <div className="flex rounded-md bg-zinc-900 p-0.5">
                {PASSES.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => update({ passes: p.id })}
                    aria-pressed={passes === p.id}
                    className={`rounded px-2 text-[11px] leading-5 ${passes === p.id ? "bg-zinc-700 text-zinc-50" : "text-zinc-300 hover:text-white"}`}
                    title={p.title}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      <ol className="min-h-0 flex-1 overflow-y-auto">
        {items.length === 0 && (
          <li className="px-3 py-6 text-center text-xs text-zinc-400">
            {!Object.values(groups).some(Boolean)
              ? "Every kind of event is switched off: pick one above"
              : filtered && selected.length === 0
                ? "No drivers selected"
                : filtered
                  ? "No events for the selected drivers yet"
                  : "No events yet"}
          </li>
        )}
        {items.map((item) => (
          <FeedRow key={item.id} item={item} info={info} lightsOut={lightsOut} onItem={onItem} />
        ))}
      </ol>
    </section>
  );
}

export default defineWidget({
  id: "race-feed",
  name: "Race feed",
  description: "Race control messages, overtakes, pit stops and team radio as they happen.",
  version: "1.0.0",
  // Fills its column and scrolls inside, so the layout never jumps as items arrive.
  height: { min: 150 },
  width: { min: 15, default: 21, max: 40 },
  sessions: ["race", "practice"],
  settings: { show: "all" as Show, passes: "both" as Passes },
  fields: {
    show: {
      kind: "choice",
      label: "Show",
      options: [
        { value: "all", label: "Every driver" },
        { value: "selected", label: "Selected drivers" },
      ],
    },
    passes: {
      kind: "choice",
      label: "Overtakes, selected drivers",
      options: [
        { value: "both", label: "Made and lost" },
        { value: "made", label: "Only passes they made" },
        { value: "lost", label: "Only passes made on them" },
      ],
    },
  },
  Component: RaceFeed,
});
