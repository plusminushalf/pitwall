import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  compareStyles,
  defineWidget,
  deltaSeries,
  DriverTag,
  Icon,
  lapTime,
  miniSectors,
  timeAtDistance,
  TyreBadge,
  useAllLaps,
  useAllStints,
  useDrivers,
  useLapGeometry,
  useLapTrace,
  usePlayback,
  useSelection,
  useSessionInfo,
  useSettings,
  useWidgetSize,
  valueAtDistance,
  type CompareStyle,
  type DriverInfo,
  type LapTrace,
} from "widget-kit";
import { drawChart, layoutStrips, M, type Series } from "./chart";
import { FOLLOWING, isFollowing, pick, resolveLaps, stepLap, toggleLink, type Picks } from "./laps";

type Settings = { throttle: boolean; gear: boolean };

/** Compared at once (the selection's first four, as the qualifying view). */
const MAX = 4;
const MINI_SECTORS = 25;
/** A click on the chart without moving this far seeks; further is a zoom brush. */
const DRAG_PX = 4;

interface LapInfo {
  lap: number;
  duration: number;
  start: number;
}

interface TyreOn {
  compound: string;
  age: number | null;
}

const signed = (s: number) => `${s > 0 ? "+" : s < 0 ? "−" : "±"}${Math.abs(s).toFixed(3)}`;

/** A short line sample in a series' colour and dash. */
function Swatch({ style }: { style: CompareStyle }) {
  return (
    <svg width="14" height="6" aria-hidden className="shrink-0">
      <line x1="1" y1="3" x2="13" y2="3" stroke={style.color} strokeWidth="2.5" strokeLinecap="round" strokeDasharray={style.dash.length ? "4 3" : undefined} />
    </svg>
  );
}

function Step({ dir, disabled, onClick }: { dir: 1 | -1; disabled: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      className="rounded p-0.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-30 disabled:hover:bg-transparent"
      aria-label={dir > 0 ? "Next lap" : "Previous lap"}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon name="chevron-left" size={14} className={dir > 0 ? "rotate-180" : ""} />
    </button>
  );
}

/** One compared driver: colour, who, which lap (a picker), its time and tyre, and the delta to the reference at the line. */
function Chip({
  info,
  style,
  laps,
  lap,
  trace,
  tyre,
  reference,
  delta,
  onPick,
}: {
  info: DriverInfo | undefined;
  style: CompareStyle;
  laps: readonly LapInfo[];
  lap: number | null;
  trace: LapTrace | null;
  tyre: TyreOn | null;
  reference: boolean;
  delta: number | null;
  onPick: (lap: number) => void;
}) {
  const numbers = laps.map((l) => l.lap);
  const prev = stepLap(numbers, lap, -1);
  const next = stepLap(numbers, lap, 1);
  const chosen = lap != null ? laps.find((l) => l.lap === lap) : undefined;
  return (
    <div className="flex items-center gap-1 rounded border border-zinc-800 bg-zinc-900/60 py-0.5 pl-1.5 pr-1">
      <Swatch style={style} />
      <DriverTag driver={info} number={info?.number ?? 0} />
      <Step dir={-1} disabled={prev == null} onClick={() => prev != null && onPick(prev)} />
      <select
        className="cursor-pointer rounded bg-zinc-900 px-0.5 py-0.5 text-xs tabular-nums text-zinc-200 outline-none hover:bg-zinc-800 focus-visible:ring-1 focus-visible:ring-zinc-600"
        aria-label={`${info?.acronym ?? "Driver"}'s lap`}
        value={lap ?? ""}
        onChange={(e) => onPick(Number(e.target.value))}
      >
        {lap == null && (
          <option value="" className="bg-zinc-900">
            {numbers.length ? "not yet" : "no laps"}
          </option>
        )}
        {laps.map((l) => (
          <option key={l.lap} value={l.lap} className="bg-zinc-900">
            L{l.lap} · {lapTime(l.duration)}
          </option>
        ))}
      </select>
      <Step dir={1} disabled={next == null} onClick={() => next != null && onPick(next)} />
      {tyre && <TyreBadge compound={tyre.compound} age={tyre.age} size={14} />}
      {reference ? (
        <span className="rounded bg-zinc-800 px-1 text-[9px] font-bold uppercase tracking-wider text-zinc-400" title="Deltas are measured against this lap">
          ref
        </span>
      ) : delta != null ? (
        <span className={`text-xs font-semibold tabular-nums ${delta > 0 ? "text-red-300" : "text-emerald-300"}`} title="At the line, against the reference lap">
          {signed(delta)}
        </span>
      ) : null}
      {chosen && !trace && <span className="text-[10px] text-amber-400">no telemetry</span>}
    </div>
  );
}

function Hint({ children }: { children: string }) {
  return <div className="flex flex-1 items-center justify-center px-6 text-center text-xs text-zinc-500">{children}</div>;
}

/** Compared drivers' laps overlaid against distance, as the qualifying view does, for any lap of the race. */
function LapCompare() {
  const [settings] = useSettings<Settings>();
  const sessionKey = useSessionInfo((i) => i.sessionKey);
  const drivers = useSelection((s) => s.selected.slice(0, MAX));
  const infos = useDrivers();
  const geometry = useLapGeometry();
  const seek = usePlayback((p) => p.seek);
  // Each compared car's completed laps with a time (the ones that can have a trace).
  const lapsOf = useAllLaps((all) => {
    const out: Record<number, LapInfo[]> = {};
    for (const n of drivers) out[n] = (all.get(n) ?? []).flatMap((l) => (l.duration != null ? [{ lap: l.lap, duration: l.duration, start: l.start }] : []));
    return out;
  });
  const stintsOf = useAllStints((all) => {
    const out: Record<number, { lapStart: number; compound: string; ageAtStart: number | null }[]> = {};
    for (const n of drivers) out[n] = (all.get(n) ?? []).map((s) => ({ lapStart: s.lapStart, compound: s.compound, ageAtStart: s.ageAtStart }));
    return out;
  });

  // Which laps: the state is the session's (a new session starts over, following the replay).
  const [picksFor, setPicksFor] = useState<{ key: number; picks: Picks }>({ key: sessionKey, picks: FOLLOWING });
  const picks = picksFor.key === sessionKey ? picksFor.picks : FOLLOWING;
  const setPicks = (p: Picks) => setPicksFor({ key: sessionKey, picks: p });
  const completed = useMemo(() => new Map(drivers.map((n) => [n, (lapsOf[n] ?? []).map((l) => l.lap)])), [drivers, lapsOf]);
  const choices = useMemo(() => resolveLaps(drivers, completed, picks), [drivers, completed, picks]);

  // A fixed number of trace hooks, so the hook order never changes with the selection.
  const traces = [
    useLapTrace(choices[0]?.driver ?? null, choices[0]?.lap ?? null),
    useLapTrace(choices[1]?.driver ?? null, choices[1]?.lap ?? null),
    useLapTrace(choices[2]?.driver ?? null, choices[2]?.lap ?? null),
    useLapTrace(choices[3]?.driver ?? null, choices[3]?.lap ?? null),
  ];
  const infoOf = (n: number) => infos.find((d) => d.number === n);
  const styles = useMemo(() => compareStyles(drivers.map(infoOf)), [drivers, infos]);

  const series = useMemo((): Series[] => {
    const withTrace = choices.flatMap((c, i) => (traces[i] ? [{ trace: traces[i]!, style: styles[i] }] : []));
    const ref = withTrace[0]?.trace;
    const step = Math.max(2, geometry.lapLength / 2000);
    return withTrace.map((s, k) => ({ ...s, delta: k > 0 && ref ? deltaSeries(ref, s.trace, step) : null }));
  }, [choices, ...traces, styles, geometry.lapLength]);
  const ref = series[0]?.trace ?? null;
  const minis = useMemo(() => (series.length > 1 ? miniSectors(series.map((s) => s.trace), MINI_SECTORS) : []), [series]);

  // The chart.
  const size = useWidgetSize();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [chart, setChart] = useState({ w: 0, h: 0 });
  // The chart's wrap comes and goes (a hint takes its place without traces): a callback ref follows it.
  const observer = useRef<ResizeObserver | null>(null);
  const wrapRef = useCallback((el: HTMLDivElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setChart({ w: Math.floor(e.contentRect.width), h: Math.floor(e.contentRect.height) }));
    ro.observe(el);
    observer.current = ro;
  }, []);
  const [hover, setHover] = useState<number | null>(null);
  const [zoom, setZoom] = useState<[number, number] | null>(null);
  const [brush, setBrush] = useState<[number, number] | null>(null);
  const drag = useRef<{ x: number; moved: boolean } | null>(null);
  const { lapLength } = geometry;
  const [x0, x1] = zoom ?? [0, lapLength];
  const plotW = Math.max(1, chart.w - M.left - M.right);
  const xOf = (d: number) => M.left + ((d - x0) / (x1 - x0)) * plotW;
  const dOf = (x: number) => x0 + ((x - M.left) / plotW) * (x1 - x0);
  const inPlot = (x: number) => x >= M.left && x <= chart.w - M.right;
  const clampD = (d: number) => Math.min(Math.max(d, 0), lapLength);

  const model = useMemo(
    () => ({ series, lapLength, sectorDistances: geometry.sectorDistances, corners: geometry.corners, x0, x1, hover, throttle: settings.throttle, gear: settings.gear }),
    [series, lapLength, geometry, x0, x1, hover, settings.throttle, settings.gear],
  );
  const strips = useMemo(() => layoutStrips(chart.h, model), [chart.h, model]);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || chart.w <= 0 || chart.h <= 0 || !Number.isFinite(lapLength)) return;
    drawChart(canvas, model, strips, chart.w, chart.h, size.pixelRatio);
  }, [model, strips, chart, size.pixelRatio, lapLength]);

  /** Seeks the replay to where the reference car was at distance d on its lap. */
  const seekTo = (d: number) => {
    const c = choices[0];
    const lap = c?.lap != null ? lapsOf[c.driver]?.find((l) => l.lap === c.lap) : undefined;
    if (!ref || !lap) return;
    seek(lap.start + timeAtDistance(ref, d));
  };

  const tyreOn = (n: number, lap: number | null): TyreOn | null => {
    if (lap == null) return null;
    const s = (stintsOf[n] ?? []).filter((s) => s.lapStart <= lap).at(-1);
    return s ? { compound: s.compound, age: s.ageAtStart == null ? null : s.ageAtStart + lap - s.lapStart } : null;
  };
  const following = isFollowing(picks);
  const localX = (e: React.PointerEvent) => e.clientX - e.currentTarget.getBoundingClientRect().left;
  const tipFlip = hover != null && xOf(hover) > chart.w - 190;

  return (
    // The host measures the widget but sets no CSS height on it: the column is given to the flex layout here.
    <div className="flex flex-col text-sm" style={{ height: size.height }}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 pb-1.5 pt-2">
        {choices.map((c, i) => {
          const d = traces[i] && ref && i > 0 ? (traces[i]!.duration - ref.duration) / 1000 : null;
          return (
            <Chip
              key={c.driver}
              info={infoOf(c.driver)}
              style={styles[i]}
              laps={lapsOf[c.driver] ?? []}
              lap={c.lap}
              trace={traces[i]}
              tyre={tyreOn(c.driver, c.lap)}
              reference={i === 0}
              delta={d}
              onPick={(lap) => setPicks(pick(picks, c.driver, lap))}
            />
          );
        })}
        {drivers.length > 0 && (
          <div className="ml-auto flex items-center gap-1 text-[11px]">
            <button
              type="button"
              className={`rounded px-1.5 py-0.5 font-semibold uppercase tracking-wider ${picks.linked ? "bg-zinc-800 text-zinc-100" : "text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"}`}
              aria-pressed={picks.linked}
              title={picks.linked ? "Everyone on the same lap number. Click to pick each driver's lap on its own." : "Each driver on their own lap. Click to put everyone on the same lap."}
              onClick={() => setPicks(toggleLink(picks, choices))}
            >
              Same lap
            </button>
            {following ? (
              <span className="px-1.5 text-zinc-500" title="Showing the latest lap everyone has completed; it moves on as the replay plays">
                Following
              </span>
            ) : (
              <button type="button" className="rounded px-1.5 py-0.5 font-semibold uppercase tracking-wider text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100" title="Back to the latest lap, moving on as the replay plays" onClick={() => setPicks(FOLLOWING)}>
                Follow
              </button>
            )}
            {ref && (
              <button type="button" className="flex items-center gap-0.5 rounded px-1.5 py-0.5 font-semibold uppercase tracking-wider text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100" title="Seek the replay to the start of the reference lap" onClick={() => seekTo(0)}>
                <Icon name="play" size={12} />
                Watch
              </button>
            )}
          </div>
        )}
      </div>
      {minis.length > 0 && (
        <div className="mx-3 mb-1 flex h-1.5 overflow-hidden rounded-sm" role="img" aria-label="Fastest driver through each mini-sector">
          {minis.map((m, i) => (
            <div
              key={i}
              className="flex-1"
              style={{ background: series[m.winner].style.color, opacity: m.winner === 0 ? 1 : 0.85 }}
              title={`${Math.round(m.from)}–${Math.round(m.to)} m: ${series.map((s, k) => `${infoOf(s.trace.driver)?.acronym ?? s.trace.driver} ${m.times[k].toFixed(3)}`).join(" · ")}`}
            />
          ))}
        </div>
      )}
      {drivers.length === 0 ? (
        <Hint>Select drivers in the timing tower to lay their laps over each other.</Hint>
      ) : !Number.isFinite(lapLength) ? (
        <Hint>Waiting for a clean lap to measure the circuit.</Hint>
      ) : series.length === 0 ? (
        <Hint>{choices.some((c) => c.lap != null) ? "No telemetry for this lap." : "Nothing to compare yet: the lap shown is the latest everyone has completed."}</Hint>
      ) : (
        <div ref={wrapRef} className="relative min-h-0 flex-1 select-none">
          <canvas
            ref={canvasRef}
            className="absolute inset-0 cursor-crosshair"
            style={{ width: chart.w, height: chart.h }}
            role="img"
            aria-label="Speed, delta, throttle, brake and gear against distance for the compared laps"
            onPointerDown={(e) => {
              const x = localX(e);
              if (!inPlot(x) || e.button !== 0) return;
              e.currentTarget.setPointerCapture(e.pointerId);
              drag.current = { x, moved: false };
            }}
            onPointerMove={(e) => {
              const x = localX(e);
              if (drag.current) {
                if (Math.abs(x - drag.current.x) > DRAG_PX) drag.current.moved = true;
                if (drag.current.moved) setBrush([drag.current.x, Math.min(Math.max(x, M.left), chart.w - M.right)]);
              }
              setHover(inPlot(x) ? clampD(dOf(x)) : null);
            }}
            onPointerUp={(e) => {
              const d = drag.current;
              drag.current = null;
              setBrush(null);
              if (!d) return;
              if (d.moved && brush) {
                const [a, b] = [clampD(dOf(Math.min(...brush))), clampD(dOf(Math.max(...brush)))];
                if (b - a > 20) setZoom([a, b]);
              } else if (e.detail < 2) seekTo(clampD(dOf(localX(e))));
            }}
            onPointerCancel={() => {
              drag.current = null;
              setBrush(null);
            }}
            onPointerLeave={() => {
              if (!drag.current) setHover(null);
            }}
            onDoubleClick={() => setZoom(null)}
          />
          {brush && <div className="pointer-events-none absolute bg-zinc-200/10 ring-1 ring-zinc-400/40" style={{ left: Math.min(...brush), width: Math.abs(brush[1] - brush[0]), top: M.top, bottom: M.bottom }} />}
          {hover != null && (
            <div className="pointer-events-none absolute top-4 z-10 rounded border border-zinc-700 bg-zinc-900/95 px-2 py-1 text-[11px] shadow-xl" style={tipFlip ? { right: chart.w - xOf(hover) + 8 } : { left: xOf(hover) + 8 }}>
              <div className="mb-0.5 flex items-baseline justify-between gap-3 text-zinc-400">
                <span className="tabular-nums">{Math.round(hover).toLocaleString("en-US")} m</span>
                {ref && <span className="tabular-nums text-zinc-500">{(timeAtDistance(ref, hover) / 1000).toFixed(2)} s</span>}
              </div>
              <div className="grid grid-cols-[auto_auto_auto_auto_auto] items-center gap-x-2 gap-y-0.5 tabular-nums">
                {series.map(({ trace, style }, k) => {
                  const delta = k > 0 && ref ? (timeAtDistance(trace, hover) - timeAtDistance(ref, hover)) / 1000 : null;
                  return (
                    <div key={trace.driver} className="contents">
                      <span className="flex items-center gap-1 font-bold text-zinc-100">
                        <Swatch style={style} />
                        {infoOf(trace.driver)?.acronym ?? `#${trace.driver}`}
                      </span>
                      <span className="text-right text-zinc-200">{Math.round(valueAtDistance(trace, "speed", hover))}</span>
                      <span className="text-zinc-400">G{valueAtDistance(trace, "gear", hover)}</span>
                      <span className="text-right text-zinc-400">
                        {Math.round(valueAtDistance(trace, "throttle", hover))}%{valueAtDistance(trace, "brake", hover) > 0 ? <span className="ml-1 font-semibold text-red-400">BRK</span> : null}
                      </span>
                      <span className={`text-right ${delta == null ? "text-zinc-500" : delta > 0 ? "text-red-300" : "text-emerald-300"}`}>{delta == null ? "ref" : signed(delta)}</span>
                    </div>
                  );
                })}
              </div>
              <div className="mt-0.5 text-[10px] text-zinc-600">click: seek here · drag: zoom · double-click: whole lap</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default defineWidget({
  id: "lap-compare",
  name: "Lap compare",
  description: "The selected drivers' laps laid over each other against distance: speed, delta, throttle, brake, gear. Any lap of the race, as in qualifying.",
  version: "1.0.0",
  // Fills its column: the chart takes what the chips leave.
  height: { min: 300 },
  width: { min: 18, default: 32, max: 100 },
  sessions: ["race", "practice"],
  settings: { throttle: true, gear: false } satisfies Settings,
  fields: {
    throttle: { kind: "toggle", label: "Throttle strip" },
    gear: { kind: "toggle", label: "Gear strip" },
  },
  Component: LapCompare,
});
