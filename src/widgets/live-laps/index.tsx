import { useEffect, useMemo, useRef } from "react";
import {
  compareStyles,
  defineWidget,
  Icon,
  Label,
  lapTime,
  teamColor,
  timeAtDistance,
  useAllLaps,
  useCardState,
  useCoarsePointer,
  useDrivers,
  useFastestLap,
  useLapGeometry,
  useLapTrace,
  useLiveLap,
  useLiveLaps,
  useSessionInfo,
  useWidgetSize,
  type CompareStyle,
  type DriverInfo,
  type LapGeometry,
  type LapProgress,
  type LapTrace,
} from "widget-kit";

/** Followed at once. */
const MAX = 4;
/** A finished lap kept as a driver's last push lap: within this share of the fastest lap's time. */
const PUSH_RATIO = 1.05;
/** Dropped from the list only when this far off the fastest lap's pace: every lap counts as a push lap until then. */
const OFF_PACE_RATIO = 1.1;
const OFF_PACE_SLACK_MS = 2_000;
const ROW_H = 26;
const FONT = "9px ui-sans-serif, system-ui, sans-serif";

/** Seconds behind (+) or ahead (−) of the reference at the same distance. */
const deltaOf = (ref: LapTrace, distance: number, elapsed: number) => (elapsed - timeAtDistance(ref, distance)) / 1000;
const signed = (s: number) => `${s > 0 ? "+" : s < 0 ? "−" : "±"}${Math.abs(s).toFixed(3)}`;

/** On a push lap, optimistically: any lap in progress, until it falls well off the reference's pace. */
function pushing(p: Pick<LapProgress, "pitOut" | "distance" | "elapsed">, ref: LapTrace | null): boolean {
  return ref == null || p.elapsed <= OFF_PACE_RATIO * timeAtDistance(ref, p.distance) + OFF_PACE_SLACK_MS;
}

interface Line {
  trace: LapTrace;
  style: CompareStyle;
  /** Still being driven: drawn with a dot at the car. */
  live: boolean;
}

function draw(canvas: HTMLCanvasElement, ref: LapTrace | null, lines: Line[], geometry: LapGeometry, w: number, h: number, dpr: number) {
  const pw = Math.round(w * dpr);
  const ph = Math.round(h * dpr);
  if (canvas.width !== pw || canvas.height !== ph) {
    canvas.width = pw;
    canvas.height = ph;
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const L = geometry.lapLength;
  if (!Number.isFinite(L) || w <= 0 || h <= 0) return;
  const left = 30;
  const right = 6;
  const xOf = (d: number) => left + (d / L) * (w - left - right);
  // Speed on top, the delta to the reference under it.
  const speedTop = 6;
  const speedBottom = Math.round(h * 0.6);
  const deltaTop = speedBottom + 12;
  const deltaBottom = h - 6;
  const ySpeed = (v: number) => speedBottom - (Math.min(Math.max(v, 50), 360) - 50) / 310 * (speedBottom - speedTop);
  // The delta's range: what the lines reach, at least ±0.5 s.
  let range = 0.5;
  if (ref) {
    for (const { trace } of lines) {
      for (let k = 0; k < trace.d.length; k += 4) range = Math.max(range, Math.abs(deltaOf(ref, trace.d[k], trace.t[k])));
    }
  }
  range = Math.min(range * 1.15, 5);
  const yDelta = (s: number) => (deltaTop + deltaBottom) / 2 + (Math.min(Math.max(s, -range), range) / range) * ((deltaBottom - deltaTop) / 2);

  ctx.font = FONT;
  ctx.lineWidth = 1;
  ctx.strokeStyle = "#27272a";
  ctx.fillStyle = "#9f9fa9";
  ctx.textBaseline = "middle";
  for (const v of [100, 200, 300]) {
    const y = Math.round(ySpeed(v)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(w - right, y);
    ctx.stroke();
    ctx.fillText(String(v), 4, y);
  }
  // The reference's zero line, and the range.
  ctx.strokeStyle = "#52525b";
  ctx.beginPath();
  ctx.moveTo(left, Math.round(yDelta(0)) + 0.5);
  ctx.lineTo(w - right, Math.round(yDelta(0)) + 0.5);
  ctx.stroke();
  ctx.fillText(`+${range.toFixed(1)}`, 4, yDelta(range) + 4);
  ctx.fillText(`−${range.toFixed(1)}`, 4, yDelta(-range) - 4);
  // Sector boundaries.
  ctx.setLineDash([2, 3]);
  ctx.strokeStyle = "#3f3f46";
  for (const d of geometry.sectorDistances) {
    if (!Number.isFinite(d)) continue;
    const x = Math.round(xOf(d)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(x, speedTop);
    ctx.lineTo(x, deltaBottom);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  ctx.lineJoin = "round";
  if (ref) {
    ctx.strokeStyle = "#71717a";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let k = 0; k < ref.d.length; k++) (k ? ctx.lineTo : ctx.moveTo).call(ctx, xOf(ref.d[k]), ySpeed(ref.speed[k]));
    ctx.stroke();
  }
  for (const { trace, style, live } of lines) {
    ctx.strokeStyle = style.color;
    ctx.globalAlpha = live ? 1 : 0.55;
    ctx.lineWidth = 1.5;
    ctx.setLineDash(style.dash);
    ctx.beginPath();
    for (let k = 0; k < trace.d.length; k++) (k ? ctx.lineTo : ctx.moveTo).call(ctx, xOf(trace.d[k]), ySpeed(trace.speed[k]));
    ctx.stroke();
    if (ref) {
      ctx.beginPath();
      for (let k = 0; k < trace.d.length; k++) (k ? ctx.lineTo : ctx.moveTo).call(ctx, xOf(trace.d[k]), yDelta(deltaOf(ref, trace.d[k], trace.t[k])));
      ctx.stroke();
    }
    ctx.setLineDash([]);
    const last = trace.d.length - 1;
    if (live && last >= 0) {
      ctx.fillStyle = style.color;
      ctx.beginPath();
      ctx.arc(xOf(trace.d[last]), ySpeed(trace.speed[last]), 3, 0, 2 * Math.PI);
      ctx.fill();
      if (ref) {
        ctx.beginPath();
        ctx.arc(xOf(trace.d[last]), yDelta(deltaOf(ref, trace.d[last], trace.t[last])), 3, 0, 2 * Math.PI);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }
}

/** One followed driver: their lap in progress while it's a push lap, else their last push lap, finished. */
function useFollowed(n: number | null, ref: LapTrace | null, lastPush: number | null): { trace: LapTrace; live: boolean } | null {
  const live = useLiveLap(n);
  const done = useLapTrace(n, lastPush);
  if (live && pushing({ pitOut: live.pitOut, distance: live.trace.length, elapsed: live.trace.duration }, ref)) return { trace: live.trace, live: true };
  return done ? { trace: done, live: false } : null;
}

function Row({
  info,
  p,
  lastPush,
  reference,
  lapLength,
  followed,
  style,
  onToggle,
}: {
  info: DriverInfo;
  p: LapProgress | null;
  lastPush: { lap: number; duration: number } | null;
  reference: LapTrace | null;
  lapLength: number;
  followed: boolean;
  style: CompareStyle | null;
  onToggle: () => void;
}) {
  const onPush = p != null && pushing(p, reference);
  const delta = onPush && reference ? deltaOf(reference, p.distance, p.elapsed) : null;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={followed}
      title={followed ? `Stop following ${info.acronym}` : `Follow ${info.acronym}'s laps on the chart`}
      className={`grid w-full grid-cols-[14px_4px_36px_minmax(0,1fr)_64px_58px] items-center gap-2 px-3 text-left text-xs ${followed ? "bg-zinc-800/60" : "hover:bg-zinc-900"}`}
      style={{ height: ROW_H }}
    >
      <span className={`flex h-3 w-3 items-center justify-center rounded-full ${followed ? "bg-zinc-100 text-zinc-900" : "border border-zinc-600"}`}>
        {followed && <Icon name="check" size={9} className="[&_path]:[stroke-width:2.5]" />}
      </span>
      <span className="h-4 w-1 rounded-sm" style={{ background: style?.color ?? teamColor(info.teamColour) }} />
      <span className="font-bold tracking-wide text-zinc-100">{info.acronym}</span>
      {onPush ? (
        <span className="relative h-1.5 overflow-hidden rounded-full bg-zinc-800" title={`${Math.round(p.distance)} m of ${Math.round(lapLength)} m`}>
          <span className="absolute inset-y-0 left-0 rounded-full bg-zinc-300" style={{ width: `${Math.min(100, (p.distance / lapLength) * 100)}%` }} />
        </span>
      ) : (
        <span className="truncate text-zinc-500">{p?.pitOut ? "Out lap" : p ? "Not pushing" : "In the pits"}</span>
      )}
      <span className={`text-right tabular-nums ${delta == null ? "text-zinc-500" : delta < 0 ? "font-semibold text-fuchsia-400" : delta < 0.3 ? "text-emerald-300" : "text-zinc-300"}`}>
        {delta != null ? signed(delta) : ""}
      </span>
      <span className="text-right tabular-nums text-zinc-400" title={lastPush ? `Last push lap: lap ${lastPush.lap}` : undefined}>
        {onPush ? lapTime(p.elapsed / 1000) : lastPush ? lapTime(lastPush.duration) : ""}
      </span>
    </button>
  );
}

/** Push laps as they're driven: who's on one, how they stand against the fastest lap, and the ones followed overlaid live. */
function LiveLaps() {
  const sessionKey = useSessionInfo((i) => i.sessionKey);
  const infos = useDrivers();
  const geometry = useLapGeometry();
  const fastest = useFastestLap((f) => (f ? { driver: f.driver, lap: f.lap, duration: f.duration } : null));
  const ref = useLapTrace(fastest?.driver ?? null, fastest?.lap ?? null);
  const progress = useLiveLaps();
  // Each driver's latest timed lap on the fastest lap's pace (their last push lap), to keep on screen once it's over.
  const lastPushOf = useAllLaps((all) => {
    const out: Record<number, { lap: number; duration: number }> = {};
    const best = fastest?.duration;
    if (best == null) return out;
    for (const [n, laps] of all) {
      const l = [...laps].reverse().find((x) => x.duration != null && !x.pitOut && x.duration <= best * PUSH_RATIO);
      if (l) out[n] = { lap: l.lap, duration: l.duration! };
    }
    return out;
  });
  const [followFor, setFollowFor] = useCardState<{ key: number; drivers: number[] }>("follow", { key: sessionKey, drivers: [] });
  const followed = followFor.key === sessionKey ? followFor.drivers : [];
  const toggle = (n: number) =>
    setFollowFor({ key: sessionKey, drivers: followed.includes(n) ? followed.filter((x) => x !== n) : [...followed, n].slice(-MAX) });

  const infoOf = (n: number) => infos.find((d) => d.number === n);
  const styles = useMemo(() => compareStyles(followed.map(infoOf)), [followed, infos]);
  const slots = [0, 1, 2, 3].map((i) => followed[i] ?? null);
  const lines = [
    useFollowed(slots[0], ref, slots[0] != null ? (lastPushOf[slots[0]]?.lap ?? null) : null),
    useFollowed(slots[1], ref, slots[1] != null ? (lastPushOf[slots[1]]?.lap ?? null) : null),
    useFollowed(slots[2], ref, slots[2] != null ? (lastPushOf[slots[2]]?.lap ?? null) : null),
    useFollowed(slots[3], ref, slots[3] != null ? (lastPushOf[slots[3]]?.lap ?? null) : null),
  ];

  // The list: the followed drivers first, then everyone on a push lap, closest to the reference first.
  const byDriver = new Map(progress.map((p) => [p.driver, p]));
  const onPush = progress
    .filter((p) => !followed.includes(p.driver) && pushing(p, ref))
    .sort((a, b) => (ref ? deltaOf(ref, a.distance, a.elapsed) - deltaOf(ref, b.distance, b.elapsed) : b.distance - a.distance));
  const rows = [...followed, ...onPush.map((p) => p.driver)];

  const size = useWidgetSize();
  const coarse = useCoarsePointer();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const listH = Math.min(rows.length, 6) * ROW_H;
  const chartH = Math.max(0, size.height - 34 - listH - (rows.length ? 0 : 40) - 8);
  const chartW = size.width;
  const drawnLines = lines.flatMap((l, i) => (l ? [{ ...l, style: styles[i] }] : []));
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas) draw(canvas, ref, drawnLines, geometry, chartW, chartH, size.pixelRatio);
  });

  return (
    <div className="flex flex-col text-sm" style={{ height: size.height }}>
      <div className="flex h-[34px] shrink-0 items-center justify-between gap-2 px-3">
        <Label>Live laps</Label>
        <span className="truncate text-[11px] text-zinc-400">
          {fastest && ref ? (
            <>
              vs fastest · <span className="font-semibold text-zinc-200">{infoOf(fastest.driver)?.acronym}</span> {lapTime(fastest.duration)}
            </>
          ) : (
            "No lap time to measure against yet"
          )}
        </span>
      </div>
      {rows.length ? (
        <div className="shrink-0 overflow-y-auto border-y border-zinc-800/80" style={{ maxHeight: listH }}>
          {rows.map((n) => {
            const info = infoOf(n);
            if (!info) return null;
            const i = followed.indexOf(n);
            return (
              <Row
                key={n}
                info={info}
                p={byDriver.get(n) ?? null}
                lastPush={lastPushOf[n] ?? null}
                reference={ref}
                lapLength={geometry.lapLength}
                followed={i >= 0}
                style={i >= 0 ? styles[i] : null}
                onToggle={() => toggle(n)}
              />
            );
          })}
        </div>
      ) : (
        <div className="flex h-10 shrink-0 items-center px-3 text-xs text-zinc-500">Nobody's on a push lap right now.</div>
      )}
      <div className="relative min-h-0 flex-1">
        {!Number.isFinite(geometry.lapLength) ? (
          <div className="flex h-full items-center justify-center px-6 text-center text-xs text-zinc-500">Waiting for a clean lap to measure the circuit.</div>
        ) : followed.length === 0 ? (
          <div className="flex h-full items-center justify-center px-6 text-center text-xs text-zinc-500">
            {coarse ? "Tap" : "Click"} a driver on a push lap to follow it here as it's driven: speed on top, the gap to the fastest lap under it.
          </div>
        ) : null}
        <canvas
          ref={canvasRef}
          role="img"
          aria-label="The followed drivers' push laps against distance: speed, and the gap to the fastest lap"
          className={`absolute left-0 top-1 ${followed.length && Number.isFinite(geometry.lapLength) ? "" : "hidden"}`}
          style={{ width: chartW, height: chartH }}
        />
      </div>
    </div>
  );
}

export default defineWidget({
  id: "live-laps",
  name: "Live laps",
  group: "telemetry",
  description:
    "Push laps as they're driven: who's on one and how they stand against the fastest lap, and the drivers you follow drawn live, speed and gap, as their lap goes on.",
  version: "1.0.0",
  // Fills its column: the chart takes what the list leaves.
  height: { min: 320 },
  width: { min: 18, default: 32, max: 100 },
  sessions: ["qualifying", "practice"],
  settings: {},
  Component: LiveLaps,
});
