import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { stepAt } from "../engine/lookup";
import { spoilerFreeEnd } from "../engine/noSpoilers";
import { scheduledDistance } from "../engine/raceDistance";
import { leaderLapAt } from "../engine/raceState";
import { clusterEvents, EVENT_PRIORITY, timelineEvents, type EventCluster, type TimelineEventKind } from "../engine/timelineEvents";
import { raceClock, teamColor, TRACK_STATUS } from "../lib/format";
import { SPEEDS, useReplay } from "../store";
import type { DriverInfo, PitStop, TrackStatus } from "../types";
import { GoLiveButton } from "./LiveControl";
import { StreamBadge } from "./StreamStatus";

const BAND: Partial<Record<TrackStatus, string>> = {
  SC: "bg-amber-400/70",
  SC_ENDING: "bg-amber-400/50",
  VSC: "bg-amber-200/50",
  VSC_ENDING: "bg-amber-200/35",
  RED: "bg-red-500/80",
};

/** Neutralised periods named in the hover tooltip (nothing extra under green). */
const HOVER_STATUS: Partial<Record<TrackStatus, { label: string; dot: string }>> = {
  SC: { label: TRACK_STATUS.SC.label, dot: "bg-amber-400" },
  SC_ENDING: { label: `${TRACK_STATUS.SC.label} (ending)`, dot: "bg-amber-400" },
  VSC: { label: TRACK_STATUS.VSC.label, dot: "bg-amber-200" },
  VSC_ENDING: { label: "VSC (ending)", dot: "bg-amber-200" },
  RED: { label: TRACK_STATUS.RED.label, dot: "bg-red-500" },
};

// Thin line from a period-start marker down to the bar.
const STEM: Partial<Record<TimelineEventKind, string>> = {
  sc: "bg-amber-400/60",
  vsc: "bg-amber-200/60",
  red: "bg-red-500/70",
};

// Drawn marker widths (px), so labels that would touch are clustered; ticks use the minimum gap.
const MARKER_PX: Record<TimelineEventKind, number> = {
  red: 18,
  sc: 23,
  vsc: 30,
  penalty: 24,
  retired: 11,
  "double-yellow": 0,
  yellow: 0,
};

const MAX_TIP_LINES = 8;

/** What the pointer is over, for the tooltip (the bar itself otherwise). */
type Target =
  | { type: "events"; cluster: EventCluster }
  | { type: "pit"; info: DriverInfo; pit: PitStop }
  | { type: "chequered"; t: number };

function MarkerGlyph({ kind, color }: { kind: TimelineEventKind; color?: string }) {
  const pill = "rounded-sm px-1 text-[9px] font-bold leading-[13px]";
  switch (kind) {
    case "red":
      return <span className={`${pill} bg-red-600 text-white`}>⚑</span>;
    case "sc":
      return <span className={`${pill} bg-amber-400 text-black`}>SC</span>;
    case "vsc":
      return <span className={`${pill} bg-amber-200 text-black`}>VSC</span>;
    case "penalty":
      return <span className="rounded-sm bg-blue-600 px-0.5 text-[8px] font-bold leading-[11px] text-white">PEN</span>;
    case "retired":
      return (
        <span className="text-[11px] font-black leading-none" style={{ color }}>
          ✕
        </span>
      );
    case "double-yellow":
      return <span className="block h-2.5 w-[3px] rounded-full bg-orange-500" />;
    case "yellow":
      return <span className="block h-2 w-0.5 rounded-full bg-yellow-400" />;
  }
}

function PitGlyph({ color }: { color: string }) {
  return <span className="inline-block h-0 w-0 border-x-[5px] border-t-[7px] border-x-transparent" style={{ borderTopColor: color }} />;
}

export function Timeline() {
  const session = useReplay((s) => s.session);
  const t = useReplay((s) => s.t);
  const playing = useReplay((s) => s.playing);
  const latched = useReplay((s) => s.latched);
  const speed = useReplay((s) => s.speed);
  const selected = useReplay((s) => s.selected);
  const focused = useReplay((s) => s.focused);
  const leaderLap = useReplay((s) => s.race?.leaderLap ?? 0);
  const live = useReplay((s) => s.mode === "live");
  const followLive = useReplay((s) => s.followLive);
  const liveEdge = useReplay((s) => s.liveEdge);
  // Live, the bar already ends at what has happened. Not chosen yet (the spoiler prompt is open over it): hidden.
  const noSpoilers = useReplay((s) => s.noSpoilers !== false && s.mode !== "live");
  const watchedTo = useReplay((s) => s.watchedTo);
  // A race watched while it downloads: what's in so far.
  const spans = useReplay((s) => (s.stream && s.session?.meta.sessionKey === s.stream.key ? s.stream.spans : null));
  const { setSpeed, seek, seekToLap, togglePlay, setNoSpoilers } = useReplay.getState();
  const barRef = useRef<HTMLDivElement>(null);
  const [barWidth, setBarWidth] = useState(0);
  const [hover, setHover] = useState<{ x: number; t: number } | null>(null);
  const [target, setTarget] = useState<Target | null>(null);
  const dragging = useRef(false);

  const hasSession = session != null;
  // Live, the bar grows with the live edge (its right end). No spoilers: it shows nothing past what has been
  // watched, and its length (until the flag) doesn't give the race away.
  const duration = !session ? 0 : live ? Math.max(liveEdge, session.meta.duration) : noSpoilers ? spoilerFreeEnd(session.meta, watchedTo) : session.meta.duration;
  const shownTo = noSpoilers ? watchedTo : Infinity;
  useEffect(() => {
    const el = barRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setBarWidth(Math.round(entry.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [hasSession]);

  const bands = useMemo(() => {
    if (!session) return [];
    const events = session.meta.trackStatus;
    return events
      .map((e, i) => ({ status: e.status, from: e.t, to: events[i + 1]?.t ?? Infinity }))
      .filter((b) => BAND[b.status]);
  }, [session]);

  // Race events are derived once per session; only their clustering depends on the bar's width
  // (and, with no spoilers, on how many have been watched: they're sorted by time).
  const events = useMemo(() => (session ? timelineEvents(session.meta) : []), [session]);
  const ahead = events.findIndex((e) => e.t > shownTo);
  const shownEvents = ahead < 0 ? events.length : ahead;
  const markers = useMemo(() => {
    const clusters = clusterEvents(events.slice(0, shownEvents), duration, barWidth, (kind) => MARKER_PX[kind]);
    // Lowest priority first, so the most important markers are drawn on top.
    return clusters.sort((a, b) => EVENT_PRIORITY[a.kind] - EVENT_PRIORITY[b.kind]);
  }, [events, shownEvents, duration, barWidth]);

  if (!session) return null;
  const { meta } = session;
  // Following live, the play button pauses (freezes the picture), like when playback is latched.
  const pauses = latched || (live && followLive);
  const pct = (ms: number) => `${(Math.min(Math.max(ms, 0), duration) / duration) * 100}%`;

  const timeAt = (clientX: number) => {
    const rect = barRef.current!.getBoundingClientRect();
    const f = Math.min(Math.max((clientX - rect.left) / rect.width, 0), 1);
    return { x: clientX - rect.left, t: f * duration };
  };

  // Pit stops for every selected driver, else the focused one; the focused driver's markers go on top.
  const pitDrivers = selected.length > 0 ? selected : focused != null ? [focused] : [];
  const pitMarkers = [...pitDrivers].sort((a, b) => Number(a === focused) - Number(b === focused)).flatMap((n) => {
    const d = session.drivers.get(n);
    return d ? d.pits.filter((p) => p.entry <= shownTo).map((p) => ({ driver: n, info: d.info, p })) : [];
  });
  // By the scheduled distance: the laps actually run would give away a race cut short.
  const labelEvery = scheduledDistance(meta).totalLaps > 60 ? 10 : 5;
  const colorOf = (driver: number | null) => teamColor((driver != null && session.drivers.get(driver)?.info.teamColour) || "a1a1aa");
  const lapAt = (ms: number) => Math.max(leaderLapAt(session, ms), 0);
  const clockAt = (ms: number) => raceClock(ms - meta.lightsOut);

  // One tooltip: details of the marker / pit stop under the pointer, else lap, time and track status on the bar.
  let tip: { t: number; content: ReactNode } | null = null;
  if (target?.type === "events") {
    const list = target.cluster.events;
    tip = {
      t: target.cluster.t,
      content: (
        <>
          <div className="grid grid-cols-[28px_auto_auto_auto] items-center gap-x-2 gap-y-1 py-0.5">
            {list.slice(0, MAX_TIP_LINES).map((e, i) => (
              <div key={i} className="contents">
                <span className="flex justify-center">
                  <MarkerGlyph kind={e.kind} color={colorOf(e.driver)} />
                </span>
                <span className="text-zinc-500">{lapAt(e.t) > 0 ? `L${lapAt(e.t)}` : ""}</span>
                <span className="text-zinc-400">{clockAt(e.t)}</span>
                <span>{e.text}</span>
              </div>
            ))}
          </div>
          {list.length > MAX_TIP_LINES && <div className="text-zinc-500">+{list.length - MAX_TIP_LINES} more</div>}
          <div className="mt-0.5 text-[10px] text-zinc-500">Click to jump to 5 s before</div>
        </>
      ),
    };
  } else if (target?.type === "pit") {
    const { info, pit } = target;
    tip = {
      t: pit.entry,
      content: (
        <span className="flex items-center gap-1.5">
          <PitGlyph color={teamColor(info.teamColour)} />
          <span className="text-zinc-400">{clockAt(pit.entry)}</span>
          <span>
            {info.acronym} pit stop · lap {pit.lap}
          </span>
        </span>
      ),
    };
  } else if (target?.type === "chequered") {
    tip = { t: target.t, content: `🏁 Chequered flag · ${clockAt(target.t)}` };
  } else if (hover && hover.t > shownTo) {
    tip = { t: hover.t, content: `${clockAt(hover.t)} · not watched yet` };
  } else if (hover) {
    const status = HOVER_STATUS[stepAt(meta.trackStatus, session.trackStatusTimes, hover.t)?.status ?? "GREEN"];
    tip = {
      t: hover.t,
      content: (
        <span className="flex items-center gap-1">
          Lap {lapAt(hover.t)} · {clockAt(hover.t)}
          {status && (
            <>
              <span>·</span>
              <span className={`h-1.5 w-1.5 rounded-full ${status.dot}`} />
              {status.label}
            </>
          )}
        </span>
      ),
    };
  }
  // Keep wide tooltips inside the bar near its ends.
  const tipAlign = (ms: number) => {
    const f = ms / duration;
    return f < 0.15 ? "-translate-x-3" : f > 0.85 ? "-translate-x-[calc(100%_-_12px)]" : "-translate-x-1/2";
  };

  return (
    <div className="flex items-center gap-4 border-t border-zinc-800 bg-zinc-950 px-4 py-3">
      <div className="flex items-center gap-1">
        <button onClick={() => seekToLap(leaderLap - 1)} className="rounded px-2 py-1 text-zinc-400 hover:bg-zinc-800 hover:text-white" title="Previous lap ([)">
          ⏮
        </button>
        {/* A click plays and pauses, like P; holding to play is the space bar's. */}
        <button
          onClick={(e) => {
            e.currentTarget.blur();
            togglePlay();
          }}
          className={`flex h-9 w-9 select-none items-center justify-center rounded-full text-lg transition ${
            playing ? "scale-95 bg-emerald-400 text-zinc-950 ring-4 ring-emerald-400/25" : "bg-zinc-100 text-zinc-900 hover:bg-white"
          }`}
          title="Play / pause (P) · hold space to play"
          aria-label={pauses ? "Pause" : "Play"}
        >
          {pauses ? "⏸" : <span className={playing ? "animate-pulse" : ""}>▶</span>}
        </button>
        <button onClick={() => seekToLap(leaderLap + 1)} className="rounded px-2 py-1 text-zinc-400 hover:bg-zinc-800 hover:text-white" title="Next lap (])">
          ⏭
        </button>
      </div>

      <div className="flex overflow-hidden rounded border border-zinc-800 text-xs">
        {SPEEDS.map((s) => (
          <button
            key={s}
            onClick={() => setSpeed(s)}
            className={`px-2 py-1 tabular-nums ${s === speed ? "bg-zinc-100 font-bold text-zinc-900" : "text-zinc-400 hover:bg-zinc-800"}`}
          >
            {s}×
          </button>
        ))}
      </div>

      <div
        ref={barRef}
        className="relative h-14 flex-1 cursor-pointer select-none"
        onPointerDown={(e) => {
          dragging.current = true;
          e.currentTarget.setPointerCapture(e.pointerId);
          seek(timeAt(e.clientX).t);
        }}
        onPointerMove={(e) => {
          const h = timeAt(e.clientX);
          setHover(h);
          if (dragging.current) seek(h.t);
        }}
        onPointerUp={() => (dragging.current = false)}
        onPointerCancel={() => (dragging.current = false)}
        onPointerLeave={() => {
          setHover(null);
          setTarget(null);
        }}
      >
        {/* track */}
        <div className="absolute inset-x-0 top-8 h-2 overflow-hidden rounded bg-zinc-800">
          {/* downloaded so far (a race watched while it downloads) */}
          {spans?.map(([from, to]) =>
            from < duration ? (
              <div key={from} className="absolute inset-y-0 bg-zinc-700" style={{ left: pct(from), width: `calc(${pct(to)} - ${pct(from)})` }} />
            ) : null,
          )}
          <div className="absolute inset-y-0 left-0 bg-zinc-500" style={{ width: pct(t) }} />
          {bands.map((b, i) =>
            b.from < shownTo ? (
              <div
                key={i}
                className={`absolute inset-y-0 ${BAND[b.status]}`}
                style={{ left: pct(b.from), width: `calc(${pct(Math.min(b.to, shownTo))} - ${pct(b.from)})` }}
              />
            ) : null,
          )}
          {/* not watched yet */}
          {noSpoilers && watchedTo < duration && (
            <div
              className="absolute inset-y-0 right-0 bg-[repeating-linear-gradient(-45deg,var(--color-zinc-700)_0_2px,transparent_2px_6px)]"
              style={{ left: pct(watchedTo) }}
            />
          )}
        </div>

        {/* lap ticks */}
        {session.lapStartTimes.map((lt, lap) =>
          lap === 0 || lt === undefined || lt > shownTo ? null : (
            <div key={lap} className="absolute top-7 h-4" style={{ left: pct(lt) }}>
              <div className={`w-px ${lap % labelEvery === 0 || lap === 1 ? "h-4 bg-zinc-500" : "h-2 bg-zinc-700"}`} />
              {(lap % labelEvery === 0 || lap === 1) && (
                <span className="absolute left-0 top-4 -translate-x-1/2 text-[10px] tabular-nums text-zinc-500">{lap === 1 ? "L1" : lap}</span>
              )}
            </div>
          ),
        )}

        {/* race events: stems from period starts down to the bar, then the markers */}
        {markers.map((c) =>
          STEM[c.kind] ? (
            <div key={`stem-${c.primary.t}`} className={`pointer-events-none absolute top-4 h-4 w-px -translate-x-1/2 ${STEM[c.kind]}`} style={{ left: pct(c.t) }} />
          ) : null,
        )}
        {markers.map((c) => (
          <button
            key={`${c.events[0].t}-${c.kind}`}
            className="absolute top-0 flex h-4 -translate-x-1/2 items-end justify-center px-0.5 outline-none focus-visible:ring-1 focus-visible:ring-zinc-400"
            style={{ left: pct(c.t) }}
            // Not a scrub: the click seeks to the event instead.
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => seek(c.events[0].t - 5_000)}
            onPointerEnter={() => setTarget({ type: "events", cluster: c })}
            onPointerLeave={() => setTarget(null)}
            aria-label={`${c.primary.text}${c.events.length > 1 ? ` and ${c.events.length - 1} more` : ""}: jump to 5 s before`}
          >
            <MarkerGlyph kind={c.kind} color={colorOf(c.primary.driver)} />
            {c.events.length > 1 && (
              <span className="absolute -right-1.5 -top-1 min-w-3 rounded-full bg-zinc-700 px-0.5 text-center text-[8px] font-bold leading-3 tabular-nums text-zinc-100">
                {c.events.length}
              </span>
            )}
          </button>
        ))}

        {/* chequered flag */}
        {meta.chequered != null && meta.chequered <= shownTo && (
          <div
            className="absolute top-4 -translate-x-1/2 text-xs"
            style={{ left: pct(meta.chequered) }}
            onPointerEnter={() => setTarget({ type: "chequered", t: meta.chequered! })}
            onPointerLeave={() => setTarget(null)}
          >
            🏁
          </div>
        )}

        {/* selected (or focused) drivers' pit stops */}
        {pitMarkers.map(({ driver, info, p }) => (
          <div
            key={`${driver}-${p.entry}`}
            className="absolute top-4 h-0 w-0 -translate-x-1/2 border-x-[5px] border-t-[7px] border-x-transparent"
            style={{ left: pct(p.entry), borderTopColor: teamColor(info.teamColour) }}
            onPointerEnter={() => setTarget({ type: "pit", info, pit: p })}
            onPointerLeave={() => setTarget(null)}
          />
        ))}

        {/* live edge: the newest data, at the right end */}
        {live && <div className="pointer-events-none absolute right-0 top-6 h-6 w-0.5 translate-x-1/2 rounded bg-red-500" title="Live edge" />}

        {/* playhead */}
        <div className="pointer-events-none absolute top-[26px] h-5 w-1 -translate-x-1/2 rounded bg-white shadow" style={{ left: pct(t) }} />

        {tip && (
          <div
            className={`pointer-events-none absolute bottom-full z-20 mb-1 whitespace-nowrap rounded bg-zinc-800 px-2 py-0.5 text-[11px] tabular-nums text-zinc-200 shadow-lg ${tipAlign(tip.t)}`}
            style={{ left: pct(tip.t) }}
          >
            {tip.content}
          </div>
        )}
      </div>

      <div className="flex w-20 flex-col items-end leading-tight">
        <span className="text-sm tabular-nums text-zinc-300">{raceClock(t - meta.lightsOut)}</span>
        <StreamBadge />
      </div>
      {live ? (
        <GoLiveButton className="-ml-1 shrink-0" />
      ) : (
        <button
          onClick={() => setNoSpoilers(!noSpoilers)}
          className={`shrink-0 whitespace-nowrap rounded border px-2 py-1 text-xs ${
            noSpoilers ? "border-zinc-100 bg-zinc-100 font-bold text-zinc-900" : "border-zinc-800 text-zinc-400 hover:bg-zinc-800"
          }`}
          title={noSpoilers ? "No spoilers: the timeline shows only what you've watched (this race)" : "Show only what you've watched on the timeline (this race)"}
          aria-pressed={noSpoilers}
        >
          No spoilers
        </button>
      )}
    </div>
  );
}
