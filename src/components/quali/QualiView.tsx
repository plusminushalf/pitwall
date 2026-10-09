// The lap comparison: qualifying's screen, and finished practice's Fastest laps (Header.tsx's switch). The timing
// board on the left, speed, delta, throttle, brake and gear on one distance axis, and the track map with who's
// fastest in each mini-sector and the laps as ghosts.

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { TyreBadge } from "../../widgetkit/ui/TyreBadge";
import { cornerLabel } from "../../data/circuits";
import { compareModel, type CompareModel } from "../../data/compare";
import { miniSectors } from "../../engine/compare";
import { useCompare, type CompareEntry } from "../../hooks/useCompare";
import { useCoarsePointer, usePhone } from "../../hooks/usePhone";
import { lapTime } from "../../lib/format";
import { ghost, GHOST_SPEEDS, MINI_SECTOR_COUNTS, useQuali } from "../../qualiStore";
import { useReplay } from "../../store";
import type { SessionMeta } from "../../types";
import { ScreenSwitch, SessionPicker } from "../Header";
import { RacesButton } from "../Navigation";
import { ShareButton } from "../../share/ShareShot";
import { CompareBar } from "./CompareBar";
import { CompareCharts, Swatch } from "./CompareCharts";
import { CompareMap } from "./CompareMap";
import { GhostBar } from "./GhostBar";
import { QualiBoard } from "./QualiBoard";
import { SectorTable } from "./SectorTable";

const LABEL = "text-[10px] font-semibold uppercase tracking-wider text-zinc-500";
const PUBLISH_EVERY_MS = 100;

const SHORTCUTS: [string, string][] = [
  ["P / hold space", "Play the ghost laps"],
  ["← / →", "Ghost back / forward 1 s (shift: 5 s)"],
  ["Home", "Ghost back to the line"],
  ["− / +", "Slower / faster ghost"],
  ["Drag / wheel", "Zoom the charts"],
  ["Swipe sideways / shift + wheel", "Pan the zoomed charts"],
  ["Double-click", "Reset zoom"],
  ["Esc", "Clear the comparison"],
  ["S", "Share a screenshot and a link"],
];

function Help() {
  return (
    <div className="group relative">
      <button className="flex h-6 w-6 items-center justify-center rounded-full border border-zinc-700 text-xs font-bold text-zinc-400 hover:border-zinc-500 hover:text-zinc-100" aria-label="Keyboard shortcuts">
        ?
      </button>
      <div className="pointer-events-none absolute right-0 top-full z-30 mt-2 hidden w-72 rounded-md border border-zinc-800 bg-zinc-900 p-3 shadow-xl group-focus-within:block group-hover:block">
        <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Compare shortcuts</p>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-xs">
          {SHORTCUTS.map(([key, action]) => (
            <div key={key} className="contents">
              <dt>
                <kbd className="rounded border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 font-mono text-[11px] text-zinc-200">{key}</kbd>
              </dt>
              <dd className="text-zinc-400">{action}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}

/** Qualifying: the best time of each segment, and pole. */
function QualiSummary({ meta }: { meta: SessionMeta }) {
  const q = meta.quali!;
  return (
    <div className="flex items-center gap-3">
      {q.segments.map((s) => (
        <span key={s.number} className="flex flex-col leading-tight" title={`${s.name}: ${Math.round((s.end - s.start) / 60_000)} minutes${s.advance ? `, top ${s.advance} go through` : ""}`}>
          <span className={LABEL}>{s.name}</span>
          <span className="text-xs tabular-nums text-zinc-300">{lapTime(Math.min(...q.results.map((r) => r.times[s.number - 1] ?? Infinity)))}</span>
        </span>
      ))}
    </div>
  );
}

const COMPOUNDS = ["SOFT", "MEDIUM", "HARD", "INTERMEDIATE", "WET"];

/** Practice: the fastest lap on each compound (laps that count). */
function PracticeSummary({ meta, model }: { meta: SessionMeta; model: CompareModel }) {
  const best = useMemo(() => {
    const out = new Map<string, { driver: number; time: number }>();
    for (const l of meta.laps) {
      if (l.duration == null || l.pitOut || l.deleted) continue;
      const tyre = model.tyre(l.driver, l.lap);
      const b = tyre && out.get(tyre.compound);
      if (tyre && (!b || l.duration < b.time)) out.set(tyre.compound, { driver: l.driver, time: l.duration });
    }
    return [...out].sort(([a], [b]) => COMPOUNDS.indexOf(a) - COMPOUNDS.indexOf(b));
  }, [meta, model]);
  const acronym = (n: number) => meta.drivers.find((d) => d.number === n)?.acronym ?? `#${n}`;
  return (
    <div className="flex items-center gap-3">
      {best.map(([compound, b]) => (
        <span key={compound} className="flex items-center gap-1.5 leading-tight" title={`Fastest on the ${compound.toLowerCase()}: ${acronym(b.driver)}`}>
          <TyreBadge compound={compound} size={16} />
          <span className="flex flex-col">
            <span className={LABEL}>{acronym(b.driver)}</span>
            <span className="text-xs tabular-nums text-zinc-300">{lapTime(b.time)}</span>
          </span>
        </span>
      ))}
    </div>
  );
}

/** The phone's header: the way back, the session, the practice switch and Share. The summaries live on the board. */
function PhoneHeader({ meta }: { meta: SessionMeta }) {
  return (
    <header className="flex h-[52px] items-center gap-2 border-b border-zinc-800 bg-zinc-950 px-3">
      <RacesButton />
      <SessionPicker meta={meta} />
      <div className="ml-auto flex shrink-0 items-center gap-2">
        <ScreenSwitch />
        <ShareButton />
      </div>
    </header>
  );
}

type Panel = "board" | "charts" | "map";
const PANELS: { id: Panel; label: string }[] = [
  { id: "board", label: "Board" },
  { id: "charts", label: "Charts" },
  { id: "map", label: "Map" },
];

/** The phone shows one of the three columns at a time; this picks it. */
function PanelTabs({ panel, onPick }: { panel: Panel; onPick: (p: Panel) => void }) {
  return (
    <div className="flex shrink-0 gap-1 border-b border-zinc-800 bg-zinc-950 p-1" role="tablist" aria-label="Panel">
      {PANELS.map((p) => (
        <button key={p.id} type="button" role="tab" aria-selected={panel === p.id} onClick={() => onPick(p.id)} className={`h-11 flex-1 rounded-md text-sm font-semibold ${panel === p.id ? "bg-zinc-100 text-zinc-900" : "text-zinc-400 active:bg-zinc-800"}`}>
          {p.label}
        </button>
      ))}
    </div>
  );
}

function CompareHeader({ meta, model }: { meta: SessionMeta; model: CompareModel }) {
  // Pole, or practice's fastest lap.
  let top: { label: string; driver: number; time: number } | null = null;
  if (meta.quali) {
    const pole = meta.quali.results[0];
    const time = pole ? ([...pole.times].reverse().find((t) => t != null) ?? null) : null;
    if (pole && time != null) top = { label: "Pole", driver: pole.driver, time };
  } else {
    const p1 = model.classification[0];
    if (p1?.best != null) top = { label: "Fastest", driver: p1.driver, time: p1.best };
  }
  const topInfo = top ? meta.drivers.find((d) => d.number === top.driver) : null;
  return (
    <header className="grid h-[52px] grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-4 border-b border-zinc-800 bg-zinc-950 px-4">
      <div className="flex min-w-0 items-center gap-3">
        <RacesButton />
        <SessionPicker meta={meta} />
        <ScreenSwitch />
      </div>
      <div className="flex items-center gap-5">
        <span className="text-xl font-black uppercase tracking-tight">{meta.sessionName}</span>
        {meta.quali ? <QualiSummary meta={meta} /> : <PracticeSummary meta={meta} model={model} />}
      </div>
      <div className="flex items-center justify-end gap-4">
        {top && topInfo && (
          <span className="flex flex-col items-end leading-tight">
            <span className={LABEL}>{top.label}</span>
            <span className="text-sm tabular-nums text-zinc-100">
              <span className="font-bold">{topInfo.acronym}</span> {lapTime(top.time)}
            </span>
          </span>
        )}
        <ShareButton />
        <Help />
      </div>
    </header>
  );
}

/** Advances the ghost clock while the replay store is playing (space / P / the play button). */
function useGhostLoop(maxDuration: number) {
  const max = useRef(maxDuration);
  max.current = maxDuration;
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let lastPublish = 0;
    let wasPlaying = false;
    const frame = (now: number) => {
      const dt = now - last;
      last = now;
      const { playing, setPlaying } = useReplay.getState();
      const { ghostSpeed } = useQuali.getState();
      if (playing && max.current > 0) {
        if (!wasPlaying && ghost.t >= max.current) ghost.t = 0; // play at the end restarts the laps
        ghost.t = Math.min(ghost.t + dt * ghostSpeed, max.current);
        if (ghost.t >= max.current) {
          setPlaying(false);
          useQuali.setState({ ghostT: ghost.t });
        } else if (now - lastPublish >= PUBLISH_EVERY_MS) {
          lastPublish = now;
          useQuali.setState({ ghostT: ghost.t });
        }
      }
      wasPlaying = playing;
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);
}

/** Ghost keys (the replay's own handler leaves them to this view: they'd move the replay behind it). */
function useGhostKeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const { seekGhost, ghostSpeed, setGhostSpeed } = useQuali.getState();
      const i = GHOST_SPEEDS.indexOf(ghostSpeed as (typeof GHOST_SPEEDS)[number]);
      if (e.key === "ArrowLeft") seekGhost(ghost.t - (e.shiftKey ? 5_000 : 1_000));
      else if (e.key === "ArrowRight") seekGhost(ghost.t + (e.shiftKey ? 5_000 : 1_000));
      else if (e.key === "Home") seekGhost(0);
      else if (e.key === "-") setGhostSpeed(GHOST_SPEEDS[Math.max(0, i - 1)]);
      else if (e.key === "+" || e.key === "=") setGhostSpeed(GHOST_SPEEDS[Math.min(GHOST_SPEEDS.length - 1, i + 1)]);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

function Dominance({ entries, sectors }: { entries: CompareEntry[]; sectors: ReturnType<typeof miniSectors> }) {
  const withTrace = entries.filter((e) => e.trace);
  const wins = withTrace.map((_, i) => sectors.filter((s) => s.winner === i).length);
  if (withTrace.length < 2) return <span className="text-[11px] text-zinc-600">Add a second driver to see who is faster where</span>;
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] tabular-nums">
      {withTrace.map((e, i) => (
        <span key={e.driver} className="flex items-center gap-1" title={`${e.info.acronym} is fastest in ${wins[i]} of ${sectors.length} mini-sectors`}>
          <Swatch color={e.style.color} dashed={e.style.dash.length > 0} width={12} />
          <span className="font-bold text-zinc-200">{e.info.acronym}</span>
          <span className="text-zinc-400">{wins[i]}</span>
        </span>
      ))}
    </span>
  );
}

export function QualiView({ overlay }: { overlay?: ReactNode }) {
  const session = useReplay((s) => s.session)!;
  const meta = session.meta;
  const model = compareModel(meta)!;
  const entries = useCompare();
  const zoom = useQuali((s) => s.zoom);
  const miniCount = useQuali((s) => s.miniCount);
  const cornerNames = useQuali((s) => s.cornerNames);
  const { setMiniCount, setCornerNames } = useQuali.getState();

  // A fresh session: reset the compare state, and start with pole vs P2 (practice: the two fastest) unless a link
  // (or the replay, in practice) picked drivers.
  useEffect(() => {
    useQuali.getState().reset(meta.sessionKey);
    const { selected } = useReplay.getState();
    if (selected.length === 0) {
      useReplay.setState({ selected: model.defaultDrivers });
      useQuali.setState({ autoPicked: model.defaultDrivers });
    }
  }, [meta.sessionKey, model]);

  const withTrace = useMemo(() => entries.filter((e) => e.trace), [entries]);
  const maxDuration = Math.max(0, ...withTrace.map((e) => e.trace!.duration));
  useGhostLoop(maxDuration);
  useGhostKeys();

  const sectors = useMemo(() => miniSectors(withTrace.map((e) => e.trace!), miniCount), [withTrace, miniCount]);

  // Corner numbers along the lap, from the reference lap's path.
  const corners = useMemo(() => {
    const ref = withTrace[0]?.trace;
    if (!ref) return [];
    return meta.track.corners.map((c) => {
      let best = 0;
      let bestD = Infinity;
      for (let i = 0; i < ref.d.length; i++) {
        const dd = (ref.x[i] - c.x) ** 2 + (ref.y[i] - c.y) ** 2;
        if (dd < bestD) {
          bestD = dd;
          best = i;
        }
      }
      return { label: cornerLabel(c), d: ref.d[best] };
    });
  }, [withTrace, meta]);

  const ref = entries[0];
  const phone = usePhone();
  const coarse = useCoarsePointer();
  const [panel, setPanel] = useState<Panel>("charts");

  const board = (
    <aside data-shot="" className={phone ? "min-h-0" : "min-h-0 border-r border-zinc-800"}>
      <QualiBoard />
    </aside>
  );
  const charts = (
    <main data-shot="" className="flex min-h-0 min-w-0 flex-col">
      <CompareBar model={model} entries={entries} />
      <div className="flex h-7 shrink-0 items-center justify-between gap-2 px-3 text-[11px] text-zinc-500">
        <span className="min-w-0 truncate">
          {ref && entries.length > 1 ? (
            <>
              Delta = time behind <span className="font-semibold text-zinc-300">{ref.info.acronym}</span> at the same point of the lap (up = slower)
            </>
          ) : (
            "Speed, throttle, brake and gear against distance from the timing line"
          )}
        </span>
        <span className="flex shrink-0 items-center gap-2">
          {zoom ? (
            <>
              {!coarse && <span className="text-zinc-600">Swipe sideways to pan</span>}
              <span className="tabular-nums">
                {Math.round(zoom[0])}–{Math.round(zoom[1])} m
              </span>
              {/* Touch has its own Reset zoom button over the charts (CompareCharts.tsx). */}
              {!coarse && (
                <button onClick={() => useQuali.getState().setZoom(null)} className="rounded px-1.5 font-semibold text-zinc-300 hover:bg-zinc-800 hover:text-white">
                  Reset zoom
                </button>
              )}
            </>
          ) : (
            <span className="text-zinc-600">{coarse ? "Drag to zoom · double-tap to reset" : "Drag or scroll to zoom"}</span>
          )}
        </span>
      </div>
      {withTrace.length ? <CompareCharts entries={entries} lapLength={model.lapLength} sectorDistances={model.sectorDistances} corners={corners} /> : <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-zinc-500">{entries.some((e) => e.loading) ? "Loading lap telemetry…" : "Pick drivers on the timing board to compare their laps"}</div>}
    </main>
  );
  const map = (
    // A phone's panel scrolls: the map keeps a readable height and the sector table goes under it.
    <aside className={`flex min-h-0 flex-col ${phone ? "overflow-y-auto overscroll-contain" : "border-l border-zinc-800"}`}>
      {/* The map and what goes with it: one region to share (share/ShareShot.tsx). */}
      <div data-shot="" className={`flex min-h-0 flex-1 flex-col ${phone ? "min-h-[24rem] shrink-0" : ""}`}>
        <div className="flex shrink-0 items-center justify-between gap-2 px-3 pt-2">
          <span className={LABEL}>Fastest per mini-sector</span>
          <div className="flex overflow-hidden rounded border border-zinc-800 text-[10px]">
            {MINI_SECTOR_COUNTS.map((n) => (
              <button key={n} onClick={() => setMiniCount(n)} className={`px-1.5 py-0.5 tabular-nums pointer-coarse:px-3 pointer-coarse:py-2 ${n === miniCount ? "bg-zinc-100 font-bold text-zinc-900" : "text-zinc-400 hover:bg-zinc-800"}`}>
                {n}
              </button>
            ))}
          </div>
        </div>
        <div className="shrink-0 px-3 pt-1">
          <Dominance entries={entries} sectors={sectors} />
        </div>
        <CompareMap track={meta.track} entries={entries} sectors={withTrace.length > 1 ? sectors : []} names={cornerNames} />
        <div className="flex shrink-0 items-center justify-between gap-2 px-3 pb-1 text-[10px] text-zinc-600">
          <p>{coarse ? "Touch the track to follow the charts' cursor · tap a mini-sector to zoom to it" : "Hover to follow the charts' cursor · click a mini-sector to zoom to it"}</p>
          {meta.track.corners.some((c) => c.name) && (
            <button onClick={() => setCornerNames(!cornerNames)} aria-pressed={cornerNames} className={`shrink-0 rounded px-1.5 py-0.5 pointer-coarse:px-3 pointer-coarse:py-2 ${cornerNames ? "bg-zinc-100 font-bold text-zinc-900" : "text-zinc-400 hover:bg-zinc-800"}`}>
              Corner names
            </button>
          )}
        </div>
      </div>
      <SectorTable entries={entries} />
    </aside>
  );

  return (
    <div className="relative grid h-full grid-cols-[minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)_auto]">
      {phone ? <PhoneHeader meta={meta} /> : <CompareHeader meta={meta} model={model} />}
      {phone ? (
        // One column at a time; the tab bar picks which. Each panel keeps its own height so the canvases size to it.
        <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)]">
          <PanelTabs panel={panel} onPick={setPanel} />
          <div className="grid min-h-0">{panel === "board" ? board : panel === "charts" ? charts : map}</div>
        </div>
      ) : (
        <div className="grid min-h-0 grid-cols-[360px_minmax(0,1fr)_400px]">
          {board}
          {charts}
          {map}
        </div>
      )}
      <GhostBar entries={entries} maxDuration={maxDuration} />
      {overlay}
    </div>
  );
}
