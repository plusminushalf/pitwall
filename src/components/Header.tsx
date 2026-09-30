import type { ReactNode } from "react";
import { raceDistanceAt } from "../engine/raceDistance";
import type { RaceState } from "../engine/raceState";
import { useLayout } from "../grid/store";
import { localTime, raceClock, TRACK_STATUS } from "../lib/format";
import { useReplay } from "../store";
import type { SessionMeta, WeatherSample } from "../types";
import { LiveControl } from "./LiveControl";
import { RacesButton } from "./Navigation";

const SHORTCUTS: [string, string][] = [
  ["Hold space", "Play (release to pause)"],
  ["P", "Play / pause (keeps playing)"],
  ["← / →", "Back / forward 5 s"],
  ["Shift ← / →", "Back / forward 30 s"],
  ["[ / ]", "Previous / next lap"],
  ["− / +", "Slower / faster"],
  ["1 – 7", "Speed 1× · 2× · 4× … 64×"],
  ["Esc", "Clear selection"],
];

const sessionLabel = (s: { year: number; meetingName: string; sessionName: string }) =>
  `${s.year} ${s.meetingName} · ${s.sessionName}`;

function Label({ children }: { children: ReactNode }) {
  return <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">{children}</span>;
}

export function SessionPicker({ meta }: { meta: SessionMeta }) {
  const index = useReplay((s) => s.index);
  const loadingKey = useReplay((s) => s.loading?.key);
  const loadSession = useReplay((s) => s.loadSession);
  const current = loadingKey ?? meta.sessionKey;
  const inIndex = index.some((e) => e.sessionKey === meta.sessionKey);

  return (
    <div className="flex min-w-0 flex-col justify-center">
      <select
        value={current}
        onChange={(e) => {
          // Blur so the keyboard shortcuts (ignored while a <select> has focus) keep working.
          e.currentTarget.blur();
          loadSession(Number(e.target.value));
        }}
        className="max-w-full cursor-pointer self-start truncate field-sizing-content rounded bg-transparent py-0.5 pr-1 text-sm font-semibold text-zinc-100 outline-none hover:bg-zinc-900 focus-visible:ring-1 focus-visible:ring-zinc-600"
        title="Choose a session"
      >
        {!inIndex && (
          <option value={meta.sessionKey} className="bg-zinc-900">
            {sessionLabel(meta)}
          </option>
        )}
        {index.map((e) => (
          <option key={e.sessionKey} value={e.sessionKey} className="bg-zinc-900">
            {sessionLabel(e)}
          </option>
        ))}
      </select>
      <span className="truncate text-[11px] text-zinc-500">
        {meta.circuit}
        {meta.country ? ` · ${meta.country}` : ""}
      </span>
    </div>
  );
}

function LapCounter({ race, meta }: { race: RaceState; meta: SessionMeta }) {
  const finished = race.trackStatus === "CHEQUERED" || (meta.chequered != null && race.t >= meta.chequered);
  // Live, before lap 1 starts, lights out is only a guess.
  if (race.raceTime < 0) return <span className="text-xl font-black tracking-tight">{meta.lightsOutEstimated ? "PRE-RACE" : "FORMATION LAP"}</span>;
  if (finished) return <span className="text-xl font-black tracking-tight">FINISHED</span>;
  const distance = raceDistanceAt(meta, race.t);
  return (
    <span className="text-xl font-black tracking-tight tabular-nums">
      LAP {Math.max(1, race.leaderLap)}
      <span className="text-zinc-500" title={distance.estimated ? "Estimated race distance" : undefined}>
        {" "}
        / {distance.estimated ? "~" : ""}
        {distance.totalLaps}
      </span>
    </span>
  );
}

function Weather({ w }: { w: WeatherSample | null }) {
  if (!w) return <span className="text-xs text-zinc-600">No weather data</span>;
  const items: [string, string, string?][] = [
    ["Air", `${w.airTemp.toFixed(1)}°`],
    ["Track", `${w.trackTemp.toFixed(1)}°`],
    ["Hum", `${Math.round(w.humidity)}%`],
    ["Wind", `${w.windSpeed.toFixed(1)} m/s`, `Wind ${w.windSpeed.toFixed(1)} m/s from ${Math.round(w.windDirection)}°`],
  ];
  return (
    <div className="flex items-center gap-3">
      {w.rainfall > 0 && (
        <span className="rounded bg-sky-500/20 px-1.5 py-0.5 text-[11px] font-semibold text-sky-300" title="Rainfall reported">
          🌧 Rain
        </span>
      )}
      {items.map(([label, value, title]) => (
        <span key={label} className="flex flex-col items-end leading-tight" title={title}>
          <Label>{label}</Label>
          <span className="text-xs tabular-nums text-zinc-200">{value}</span>
        </span>
      ))}
    </div>
  );
}

function ShortcutsHelp() {
  return (
    <div className="group relative">
      <button
        className="flex h-6 w-6 items-center justify-center rounded-full border border-zinc-700 text-xs font-bold text-zinc-400 hover:border-zinc-500 hover:text-zinc-100"
        aria-label="Keyboard shortcuts"
      >
        ?
      </button>
      <div className="pointer-events-none absolute right-0 top-full z-30 mt-2 hidden w-64 rounded-md border border-zinc-800 bg-zinc-900 p-3 shadow-xl group-focus-within:block group-hover:block">
        <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Keyboard shortcuts</p>
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

const TOP_BUTTON = "whitespace-nowrap rounded-md px-2.5 py-1 text-xs font-semibold";

/** "Edit layout", or in edit mode what edit mode needs (H3.10). */
function LayoutControls() {
  const editing = useLayout((s) => s.editing);
  const pickerOpen = useLayout((s) => s.picker != null && s.picker.slot == null);
  const blur = (e: { currentTarget: HTMLButtonElement }) => e.currentTarget.blur();
  if (!editing) {
    return (
      <button
        type="button"
        onClick={(e) => {
          blur(e);
          useLayout.getState().startEdit();
        }}
        className={`${TOP_BUTTON} bg-zinc-800 text-zinc-100 hover:bg-zinc-700 hover:text-white`}
        title="Move, resize, add and remove blocks"
      >
        Edit layout
      </button>
    );
  }
  const s = useLayout.getState();
  return (
    <div className="flex items-center gap-1.5">
      <button
        type="button"
        data-picker-toggle=""
        onClick={(e) => {
          blur(e);
          if (pickerOpen) s.closePicker();
          else s.openPicker();
        }}
        className={`${TOP_BUTTON} ${pickerOpen ? "bg-zinc-700 text-white" : "bg-zinc-800 text-zinc-100 hover:bg-zinc-700 hover:text-white"}`}
      >
        + Add block
      </button>
      <button
        type="button"
        onClick={(e) => {
          blur(e);
          s.reset();
        }}
        className={`${TOP_BUTTON} bg-zinc-800 text-zinc-100 hover:bg-zinc-700 hover:text-white`}
        title="Back to the default layout (saved on Done)"
      >
        Reset
      </button>
      <button
        type="button"
        onClick={(e) => {
          blur(e);
          s.done();
        }}
        className={`${TOP_BUTTON} bg-zinc-100 text-zinc-950 hover:bg-white`}
        title="Save the layout"
      >
        Done
      </button>
    </div>
  );
}

export function Header() {
  const session = useReplay((s) => s.session);
  const race = useReplay((s) => s.race);
  const t = useReplay((s) => s.t);
  if (!session) return null;
  const { meta } = session;
  const status = race ? TRACK_STATUS[race.trackStatus] : null;

  return (
    <header className="grid h-[52px] grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-4 border-b border-zinc-800 bg-zinc-950 px-4">
      <div className="flex min-w-0 items-center gap-3">
        <RacesButton />
        <SessionPicker meta={meta} />
        <LiveControl />
      </div>

      <div className="flex items-center gap-5">
        {race && <LapCounter race={race} meta={meta} />}
        <div className="flex items-center gap-4">
          <span className="flex flex-col leading-tight">
            <Label>Race</Label>
            <span className="text-sm tabular-nums text-zinc-100">{race ? raceClock(race.raceTime) : "—"}</span>
          </span>
          <span className="flex flex-col leading-tight" title={`Local time at the circuit (UTC${meta.gmtOffset.startsWith("-") ? "" : "+"}${meta.gmtOffset.slice(0, -3)})`}>
            <Label>Local</Label>
            <span className="text-sm tabular-nums text-zinc-300">{localTime(meta.t0, t, meta.gmtOffset)}</span>
          </span>
        </div>
        {status && <span className={`whitespace-nowrap rounded px-2 py-0.5 text-xs font-bold uppercase tracking-wide ${status.className}`}>{status.label}</span>}
      </div>

      <div className="flex items-center justify-end gap-4">
        <Weather w={race?.weather ?? null} />
        {!meta.quali && <LayoutControls />}
        <ShortcutsHelp />
      </div>
    </header>
  );
}
