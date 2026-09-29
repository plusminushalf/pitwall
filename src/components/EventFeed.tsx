import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FeedItem, FeedKind, Session } from "../data/session";
import { feedAt } from "../engine/raceState";
import { indexAtOrBefore } from "../engine/lookup";
import { raceClock, teamColor, textOn } from "../lib/format";
import { useReplay } from "../store";

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

function kindTag(item: FeedItem): { label: string; className: string } {
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

/**
 * Index of the newest feed item visible at t (the feed only changes when this does).
 * At the very end of the replay, post-race items are included too.
 */
function feedEnd(session: Session, t: number): number {
  return t >= session.meta.duration ? session.feed.length : indexAtOrBefore(session.feedTimes, t);
}

/** One radio clip at a time; clips that fail to load are remembered as unavailable. */
function useRadio(sessionKey: number | null) {
  const current = useRef<{ audio: HTMLAudioElement; url: string } | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState<ReadonlySet<string>>(() => new Set());

  const stop = useCallback(() => {
    current.current?.audio.pause();
    current.current = null;
    setPlaying(null);
  }, []);

  const toggle = useCallback(
    (url: string) => {
      const wasPlaying = current.current?.url === url;
      stop();
      if (wasPlaying) return;

      const audio = new Audio(url);
      const entry = { audio, url };
      current.current = entry;
      setPlaying(url);

      const release = () => {
        if (current.current !== entry) return;
        current.current = null;
        setPlaying(null);
      };
      const fail = () => {
        release();
        setUnavailable((s) => new Set(s).add(url));
      };
      audio.addEventListener("ended", release);
      audio.addEventListener("error", fail);
      audio.play().catch((e: unknown) => {
        // AbortError: stopped (or another clip started) before playback began; not a failure.
        if (e instanceof DOMException && e.name === "AbortError") return;
        if (current.current === entry) fail();
      });
    },
    [stop],
  );

  // Stop playback when the session changes or the feed unmounts (not on live updates of the same session).
  useEffect(() => stop, [sessionKey, stop]);

  return { playing, unavailable, toggle };
}

function RadioButton({
  url,
  playing,
  unavailable,
  onToggle,
}: {
  url: string;
  playing: boolean;
  unavailable: boolean;
  onToggle: (url: string) => void;
}) {
  if (unavailable) return <span className="shrink-0 pt-0.5 text-[10px] uppercase tracking-wide text-zinc-600">unavailable</span>;
  return (
    <button
      onClick={() => onToggle(url)}
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

export function EventFeed() {
  const session = useReplay((s) => s.session);
  // Subscribing to the derived index (not `t`) means this only re-renders when the feed actually changes.
  const end = useReplay((s) => (s.session ? feedEnd(s.session, s.t) : -1));
  const seek = useReplay((s) => s.seek);
  const focus = useReplay((s) => s.focus);
  const [groups, setGroups] = useState(ALL_ON);
  const radio = useRadio(session?.meta.sessionKey ?? null);

  // Stable row keys: an item's position in the full session feed.
  const keys = useMemo(() => new Map(session?.feed.map((item, i) => [item, i])), [session]);

  const items = useMemo(() => {
    if (!session || end < 0) return [];
    // A representative time with the same feed contents as the current `t`.
    const at = end >= session.feed.length ? session.meta.duration : session.feedTimes[end];
    return feedAt(session, at, LIMIT).filter((item) => groups[GROUP_OF[item.kind]]);
  }, [session, end, groups]);

  if (!session) return null;
  const { meta } = session;

  const onItem = (item: FeedItem) => {
    seek(item.t - 5_000);
    // Focus only: the track map filter (selection) stays as it is.
    if (item.driver != null) focus(item.driver);
  };

  return (
    <section className="flex min-h-0 flex-1 flex-col border-t border-zinc-800 text-sm first:border-t-0">
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
        {items.map((item) => {
          const tag = kindTag(item);
          const info = item.driver != null ? session.drivers.get(item.driver)?.info : undefined;
          const postRace = item.t > meta.duration;
          return (
            <li key={keys.get(item)} className="flex items-start gap-2 border-b border-zinc-900 px-3 py-1.5 hover:bg-zinc-900">
              <button onClick={() => onItem(item)} className="grid min-w-0 flex-1 grid-cols-[50px_minmax(0,1fr)] gap-2 text-left" title="Jump to 5 s before this">
                <span className="pt-0.5 text-[11px] tabular-nums text-zinc-500">{raceClock(item.t - meta.lightsOut)}</span>
                <span className="text-xs leading-5 text-zinc-300">
                  {postRace && (
                    <span className="mr-1 inline-block rounded border border-zinc-700 px-1 align-middle text-[10px] font-semibold uppercase leading-4 text-zinc-400">
                      post-race
                    </span>
                  )}
                  <span className={`mr-1 inline-block rounded px-1 align-middle text-[10px] font-bold uppercase leading-4 ${tag.className}`}>
                    {tag.label}
                  </span>
                  {item.driver != null && (
                    <span
                      className={`mr-1.5 inline-block rounded px-1 align-middle text-[10px] font-bold leading-4 ${info ? "" : "bg-zinc-700 text-zinc-100"}`}
                      style={info ? { background: teamColor(info.teamColour), color: textOn(info.teamColour) } : undefined}
                    >
                      {info?.acronym ?? `#${item.driver}`}
                    </span>
                  )}
                  <span className="align-middle">{item.text}</span>
                </span>
              </button>
              {item.kind === "radio" && item.url && (
                <RadioButton
                  url={item.url}
                  playing={radio.playing === item.url}
                  unavailable={radio.unavailable.has(item.url)}
                  onToggle={radio.toggle}
                />
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
