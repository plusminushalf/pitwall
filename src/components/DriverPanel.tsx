import { useMemo, useState, type ReactNode } from "react";
import type { DriverData, Session } from "../data/session";
import { indexAtOrBefore } from "../engine/lookup";
import {
  drsEligible,
  drsOpen,
  telemetryAt,
  type DriverState,
  type DriverStatus,
  type RaceState,
  type Telemetry,
} from "../engine/raceState";
import { COMPOUND, lapTime, teamColor, textOn } from "../lib/format";
import { useReplay } from "../store";
import type { Lap } from "../types";
import { TelemetryChart } from "./TelemetryChart";
import { TyreBadge } from "./TyreBadge";

const LABEL = "text-[10px] font-semibold uppercase tracking-wider text-zinc-500";
const RPM_MAX = 13_000;
const RPM_HIGH = 11_800;
const EPS = 1e-6;

const STATUS_PILL: Record<Exclude<DriverStatus, "RUNNING">, string> = {
  PIT: "bg-zinc-200 text-zinc-900",
  OUT: "bg-red-500/20 text-red-400",
  FINISHED: "bg-white text-black",
};

// Mini-sector status codes: 2048 yellow, 2049 green, 2051 purple, 2064 pit lane.
const SEGMENT_COLOR: Record<number, string> = {
  2048: "#eab308",
  2049: "#10b981",
  2051: "#d946ef",
  2064: "#3b82f6",
};

// ---------------------------------------------------------------------------
// Sector bests

/** Every completed lap in the session sorted by end time, with the running best per sector. */
interface SectorIndex {
  ends: Float64Array;
  best: Float64Array[]; // best[k][i] = fastest sector k among the first i + 1 laps to finish
}

const sectorIndexes = new WeakMap<Session, SectorIndex>();

function sectorIndex(session: Session): SectorIndex {
  const cached = sectorIndexes.get(session);
  if (cached) return cached;
  const laps = session.meta.laps.filter((l) => l.end != null).sort((a, b) => a.end! - b.end!);
  const ends = Float64Array.from(laps, (l) => l.end!);
  const best = [0, 1, 2].map((k) => {
    const out = new Float64Array(laps.length);
    let min = Infinity;
    for (let i = 0; i < laps.length; i++) {
      const v = laps[i].sectors[k];
      if (v != null && v < min) min = v;
      out[i] = min;
    }
    return out;
  });
  const index = { ends, best };
  sectorIndexes.set(session, index);
  return index;
}

/** Fastest time in each sector by anyone, among laps finished by t. */
function overallBestSectors(session: Session, t: number): number[] {
  const { ends, best } = sectorIndex(session);
  const i = indexAtOrBefore(ends, t);
  return best.map((b) => (i >= 0 ? b[i] : Infinity));
}

/** The driver's fastest time in each sector over laps finished by the end of `upTo`. */
function personalBestSectors(d: DriverData, upTo: Lap | null): number[] {
  const best = [Infinity, Infinity, Infinity];
  if (!upTo || upTo.end == null) return best;
  for (const l of d.laps) {
    if (l.end == null || l.end > upTo.end) continue;
    for (let k = 0; k < 3; k++) {
      const v = l.sectors[k];
      if (v != null && v < best[k]) best[k] = v;
    }
  }
  return best;
}

/** Laps completed at t, including the fraction of the lap in progress (0 before the start). */
function lapProgress(d: DriverData, t: number): number {
  const li = indexAtOrBefore(d.lapStarts, t);
  if (li < 0) return 0;
  const l = d.laps[li];
  const frac = l.end != null && l.end > l.start ? Math.min(Math.max((t - l.start) / (l.end - l.start), 0), 1) : 0;
  return l.lap - 1 + frac;
}

// ---------------------------------------------------------------------------
// Header

function Headshot({ url, color }: { url: string | null; color: string }) {
  const [failed, setFailed] = useState(false);
  if (!url || failed) return null;
  return (
    <img
      src={url}
      alt=""
      onError={() => setFailed(true)}
      className="h-12 w-12 shrink-0 rounded-md object-cover object-top"
      style={{ background: `${color}40` }}
    />
  );
}

function Position({ s }: { s: DriverState }) {
  const out = s.status === "OUT";
  const delta = s.gridPosition != null && s.position != null ? s.gridPosition - s.position : null;
  return (
    <div className="shrink-0 text-right">
      <div className="text-2xl font-bold leading-none tabular-nums">{out || s.position == null ? "–" : `P${s.position}`}</div>
      {!out && delta != null && (
        <div className="mt-1 text-[10px] tabular-nums">
          {delta > 0 ? (
            <span className="text-emerald-400">▲{delta}</span>
          ) : delta < 0 ? (
            <span className="text-red-400">▼{-delta}</span>
          ) : (
            <span className="text-zinc-500">–</span>
          )}
          <span className="text-zinc-500"> grid P{s.gridPosition}</span>
        </div>
      )}
    </div>
  );
}

/** Focuses one of the selected drivers (ringed on the map, shown here); clicking the active chip unfocuses. */
function FocusChips({
  session,
  selected,
  focused,
  onFocus,
}: {
  session: Session;
  selected: number[];
  focused: number | null;
  onFocus: (n: number | null) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1 border-b border-zinc-800 px-3 py-1.5">
      {selected.map((n) => {
        const info = session.drivers.get(n)?.info;
        if (!info) return null;
        const color = teamColor(info.teamColour || "71717a");
        const active = n === focused;
        return (
          <button
            key={n}
            onClick={() => onFocus(active ? null : n)}
            aria-pressed={active}
            className={`rounded border px-1.5 text-[11px] font-bold leading-[18px] tracking-wide ${active ? "" : "text-zinc-300 hover:bg-zinc-800 hover:text-white"}`}
            style={active ? { background: color, borderColor: color, color: textOn(info.teamColour) } : { borderColor: `${color}99` }}
            title={active ? `Stop highlighting ${info.fullName}` : `Highlight ${info.fullName} on the map`}
          >
            {info.acronym}
          </button>
        );
      })}
    </div>
  );
}

function PanelHeader({
  d,
  s,
  hint,
  canClear,
  onClear,
}: {
  d: DriverData;
  s: DriverState;
  hint: string | null;
  canClear: boolean;
  onClear: () => void;
}) {
  const { info } = d;
  const color = teamColor(info.teamColour || "71717a");
  return (
    <div
      className="border-l-[3px] px-3 py-2"
      style={{ borderLeftColor: color, background: `linear-gradient(90deg, ${color}2e, transparent 70%)` }}
    >
      <div className="flex items-center gap-3">
        <Headshot key={info.number} url={info.headshotUrl} color={color} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-lg font-bold leading-tight tracking-wide">{info.acronym}</span>
            <span className="text-xs tabular-nums text-zinc-500">#{info.number}</span>
            {s.status !== "RUNNING" && (
              <span className={`rounded px-1.5 text-[10px] font-bold leading-4 ${STATUS_PILL[s.status]}`}>{s.status}</span>
            )}
          </div>
          <div className="truncate text-xs text-zinc-300">{info.fullName}</div>
          <div className="truncate text-[11px] text-zinc-500">{info.team}</div>
        </div>
        <Position s={s} />
        {canClear && (
          <button
            onClick={onClear}
            className="-mr-1 self-start rounded px-1 text-base leading-none text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
            title="Clear selection (show everyone on the map and the leader here)"
            aria-label="Clear driver selection"
          >
            ×
          </button>
        )}
      </div>
      {hint && <p className="mt-1 text-[10px] text-zinc-500">{hint}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Live telemetry

function Bar({ label, pct, color, value, valueClass = "text-zinc-300" }: { label: string; pct: number; color: string; value: string; valueClass?: string }) {
  return (
    <div className="grid grid-cols-[58px_minmax(0,1fr)_40px] items-center gap-2">
      <span className={LABEL}>{label}</span>
      <div className="h-1.5 overflow-hidden rounded-full bg-zinc-800">
        <div
          className="h-full rounded-full transition-[width] duration-100 ease-linear"
          style={{ width: `${Math.min(Math.max(pct, 0), 100)}%`, background: color }}
        />
      </div>
      <span className={`text-right text-xs tabular-nums ${valueClass}`}>{value}</span>
    </div>
  );
}

function DrsPill({ code }: { code: number | null }) {
  const open = drsOpen(code);
  const eligible = drsEligible(code);
  const cls = open
    ? "border-emerald-500 bg-emerald-500 text-zinc-950"
    : eligible
      ? "border-emerald-500 text-emerald-400"
      : "border-zinc-700 text-zinc-600";
  return (
    <span
      className={`flex h-5 items-center rounded border px-1.5 text-[10px] font-bold tracking-wider ${cls}`}
      title={open ? "DRS open" : eligible ? "DRS eligible (within a second in a DRS zone)" : "DRS off"}
    >
      DRS
    </span>
  );
}

function LiveTelemetry({ tel, hasDrs }: { tel: Telemetry | null; hasDrs: boolean }) {
  const rpm = tel?.rpm ?? 0;
  const throttle = Math.min(Math.max(tel?.throttle ?? 0, 0), 100);
  const braking = tel != null && tel.brake > 0;
  return (
    <div className="grid grid-cols-[88px_minmax(0,1fr)] items-center gap-3">
      <div>
        <div className="flex items-baseline gap-1">
          <span className="w-[3ch] text-right text-3xl font-bold leading-none tabular-nums">{tel ? Math.round(tel.speed) : "—"}</span>
          <span className="text-[10px] font-semibold uppercase text-zinc-500">km/h</span>
        </div>
        <div className="mt-2 flex items-center gap-1.5">
          <span className="flex h-5 items-center gap-1 rounded bg-zinc-800 px-1.5">
            <span className="text-[9px] font-semibold uppercase text-zinc-500">Gear</span>
            <span className="w-[1ch] text-center text-xs font-bold tabular-nums">{tel ? (tel.gear === 0 ? "N" : tel.gear) : "–"}</span>
          </span>
          {hasDrs && <DrsPill code={tel?.drs ?? null} />}
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <Bar
          label="RPM"
          pct={(rpm / RPM_MAX) * 100}
          color={rpm >= RPM_HIGH ? "#f59e0b" : "#a1a1aa"}
          value={tel ? Math.round(rpm).toLocaleString("en-US") : "—"}
        />
        <Bar label="Throttle" pct={throttle} color="#22c55e" value={tel ? `${Math.round(throttle)}%` : "—"} />
        <Bar
          label="Brake"
          pct={braking ? 100 : 0}
          color="#ef4444"
          value={tel ? (braking ? "ON" : "OFF") : "—"}
          valueClass={braking ? "font-semibold text-red-400" : "text-zinc-600"}
        />
      </div>
    </div>
  );
}

function Legend({ swatch, label }: { swatch: string; label: string }) {
  return (
    <span className="flex items-center gap-1">
      <span className={`inline-block rounded-[1px] ${swatch}`} />
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Laps and sectors

function Stat({ label, value, className = "text-zinc-200" }: { label: string; value: ReactNode; className?: string }) {
  return (
    <div className="min-w-0">
      <div className={LABEL}>{label}</div>
      <div className={`truncate text-base font-semibold tabular-nums ${className}`}>{value}</div>
    </div>
  );
}

function SectorCell({ index, lap, personal, overall }: { index: number; lap: Lap | null; personal: number; overall: number }) {
  const v = lap?.sectors[index] ?? null;
  const color =
    v == null ? "text-zinc-600" : v <= overall + EPS ? "text-fuchsia-400" : v <= personal + EPS ? "text-emerald-400" : "text-yellow-400";
  const segments = lap?.segments[index] ?? [];
  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-1">
        <span className={LABEL}>S{index + 1}</span>
        <span className={`text-xs font-semibold tabular-nums ${color}`}>{lapTime(v)}</span>
      </div>
      <div className="mt-1 flex h-1 gap-px">
        {segments.length > 0 ? (
          segments.map((c, i) => (
            <span key={i} className="flex-1 rounded-[1px]" style={{ background: (c != null && SEGMENT_COLOR[c]) || "#3f3f46" }} />
          ))
        ) : (
          <span className="flex-1 rounded-[1px] bg-zinc-800" />
        )}
      </div>
    </div>
  );
}

function LapTimes({ session, d, s, race, t }: { session: Session; d: DriverData; s: DriverState; race: RaceState; t: number }) {
  const last = s.lastLap;
  const best = s.bestLap;
  const personal = useMemo(() => personalBestSectors(d, last), [d, last]);
  const overall = overallBestSectors(session, t);
  const fl = race.fastestLap;
  const isFastest = (l: Lap | null) => l != null && fl != null && fl.driver === l.driver && fl.lap === l.lap;
  const lastColor = !last ? "text-zinc-600" : isFastest(last) ? "text-fuchsia-400" : best === last ? "text-emerald-400" : "text-zinc-200";
  const bestColor = !best ? "text-zinc-600" : isFastest(best) ? "text-fuchsia-400" : "text-zinc-200";

  return (
    <div className="border-t border-zinc-800 px-3 py-2">
      <div className="grid grid-cols-[64px_minmax(0,1fr)_minmax(0,1fr)] gap-2">
        <Stat
          label="Lap"
          value={
            <>
              {s.lap > 0 ? s.lap : "–"}
              <span className="text-xs font-normal text-zinc-500" title={session.meta.totalLapsEstimated ? "Estimated race distance" : undefined}>
                /{session.meta.totalLapsEstimated ? "~" : ""}
                {race.totalLaps}
              </span>
            </>
          }
        />
        <Stat label={last ? `Last · L${last.lap}` : "Last"} value={lapTime(last?.duration)} className={lastColor} />
        <Stat label={best ? `Best · L${best.lap}` : "Best"} value={lapTime(best?.duration)} className={bestColor} />
      </div>
      <div className="mt-2 grid grid-cols-3 gap-3">
        {[0, 1, 2].map((k) => (
          <SectorCell key={k} index={k} lap={last} personal={personal[k]} overall={overall[k]} />
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tyre strategy

function TyreStrip({ session, d, s, t }: { session: Session; d: DriverData; s: DriverState; t: number }) {
  const total = Math.max(session.meta.totalLaps, 1);
  const progress = Math.min(lapProgress(d, t), total);
  // Only stints that have started by t, so the replay doesn't spoil the strategy.
  const stints = d.stints.filter((st) => st.lapStart <= Math.max(s.lap, 1));
  const pct = (laps: number) => `${(Math.max(laps, 0) / total) * 100}%`;

  return (
    <div className="border-t border-zinc-800 px-3 py-2">
      <div className="mb-1.5 flex items-center justify-between">
        <span className={LABEL}>
          Tyres <span className="font-normal normal-case tracking-normal text-zinc-600">· {session.meta.totalLapsEstimated ? "~" : ""}{total} laps</span>
        </span>
        <span className="flex items-center gap-2 text-[11px] text-zinc-400">
          <span className="tabular-nums">
            {s.pitStops} {s.pitStops === 1 ? "stop" : "stops"}
          </span>
          <TyreBadge compound={s.compound} age={s.tyreAge} size={16} />
        </span>
      </div>
      <div className="relative h-3.5">
        <div className="absolute inset-0 overflow-hidden rounded-sm bg-zinc-900">
          {stints.map((st, i) => {
            const current = i === stints.length - 1;
            const from = st.lapStart - 1;
            const lastLap = current ? null : Math.min(st.lapEnd, stints[i + 1].lapStart - 1);
            const width = Math.max((lastLap ?? progress) - from, 0);
            const c = COMPOUND[st.compound] ?? COMPOUND.UNKNOWN;
            return (
              <div
                key={st.stint}
                className="absolute inset-y-0 flex items-center justify-center overflow-hidden text-[9px] font-bold leading-none text-black/75"
                style={{ left: pct(from), width: current ? pct(width) : `calc(${pct(width)} - 2px)`, background: c.color }}
                title={`${st.compound.toLowerCase()}, ${lastLap != null ? `laps ${st.lapStart}–${lastLap}` : `from lap ${st.lapStart}`}`}
              >
                {width / total >= 0.05 ? c.letter : null}
              </div>
            );
          })}
        </div>
        <div className="absolute -inset-y-0.5 w-0.5 -translate-x-1/2 rounded-full bg-white" style={{ left: pct(progress) }} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

export function DriverPanel() {
  const session = useReplay((s) => s.session);
  const race = useReplay((s) => s.race);
  const t = useReplay((s) => s.t);
  const selected = useReplay((s) => s.selected);
  const focused = useReplay((s) => s.focused);
  const focus = useReplay((s) => s.focus);
  const clearSelection = useReplay((s) => s.clearSelection);
  if (!session || !race || race.drivers.length === 0) return null;

  // The focused driver, else the best-placed selected one (race.drivers is in race order), else the leader.
  const s =
    (focused != null ? race.drivers.find((x) => x.driver === focused) : undefined) ??
    race.drivers.find((x) => selected.includes(x.driver)) ??
    race.drivers[0];
  const d = session.drivers.get(s.driver);
  if (!d) return null;
  const following = focused === s.driver;
  const hint = following
    ? null
    : selected.length === 0
      ? "Showing the leader · click a car or row to select drivers"
      : selected.length === 1
        ? "Showing the selected driver · pick the chip to highlight on the map"
        : "Showing the highest-placed selected driver · pick a chip to highlight on the map";
  const tel = telemetryAt(d, t);

  return (
    <section className="shrink-0 border-b border-zinc-800 text-sm">
      {selected.length > 0 && <FocusChips session={session} selected={selected} focused={focused} onFocus={focus} />}
      <PanelHeader d={d} s={s} hint={hint} canClear={following || selected.length > 0} onClear={clearSelection} />
      <div className={`border-t border-zinc-800 px-3 pb-2 pt-2.5 ${s.status === "OUT" ? "opacity-40" : ""}`}>
        <LiveTelemetry tel={tel} hasDrs={d.car.drs != null} />
        <div className="mb-1 mt-2.5 flex items-center justify-between">
          <span className={LABEL}>Last 60 s</span>
          <span className="flex items-center gap-2.5 text-[10px] text-zinc-500">
            <Legend swatch="h-0.5 w-3 bg-zinc-100" label="Speed" />
            <Legend swatch="h-2 w-2 bg-green-500/40" label="Throttle" />
            <Legend swatch="h-1 w-2.5 bg-red-500" label="Brake" />
          </span>
        </div>
        <TelemetryChart car={d.car} t={t} height={68} />
      </div>
      <LapTimes session={session} d={d} s={s} race={race} t={t} />
      <TyreStrip session={session} d={d} s={s} t={t} />
    </section>
  );
}
