import { Icon } from "../widgetkit/ui/Icon";
import { Label, Stat } from "../widgetkit/ui/Label";
import { canCompare } from "../data/compare";
import { raceDistanceAt } from "../engine/raceDistance";
import type { RaceState } from "../engine/raceState";
import { useLayout } from "../grid/store";
import { localTime, raceClock, TRACK_STATUS } from "../lib/format";
import { useQuali } from "../qualiStore";
import { comparing, useReplay, type PracticeView } from "../store";
import type { SessionMeta, WeatherSample } from "../types";
import { ShareButton } from "../share/ShareShot";
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
  ["Esc", "Shrink a full-screen widget, or clear selection"],
  ["S", "Share a screenshot and a link"],
];

const sessionLabel = (s: { year: number; meetingName: string; sessionName: string }) =>
  `${s.year} ${s.meetingName} · ${s.sessionName}`;

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
          // From practice's Fastest laps, another practice session opens in its Fastest laps too.
          const s = useReplay.getState();
          loadSession(Number(e.target.value), { view: comparing(s) && s.session?.meta.practice ? "laps" : undefined });
        }}
        className="max-w-full cursor-pointer self-start truncate field-sizing-content rounded bg-transparent py-0.5 pr-1 text-sm font-semibold text-zinc-100 hover:bg-zinc-900"
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
      <span className="truncate text-[11px] text-zinc-400">
        {meta.circuit}
        {meta.country ? ` · ${meta.country}` : ""}
      </span>
    </div>
  );
}

const VIEWS: { id: PracticeView; label: string; title: string }[] = [
  { id: "replay", label: "Replay", title: "The session as it happened" },
  { id: "laps", label: "Fastest laps", title: "The whole session's laps compared: speed, throttle, brake and gear along the lap, and who's fastest where" },
];

/**
 * Finished practice: the replay, or its laps compared as in qualifying. Only once it's downloaded (the comparison needs
 * every lap's trace): live, and while it streams, there's only the replay.
 */
export function PracticeViewSwitch() {
  const shown = useReplay((s) => (s.session?.meta.practice && s.mode === "replay" && canCompare(s.session.meta) ? (comparing(s) ? "laps" : "replay") : null));
  if (!shown) return null;
  const choose = (view: PracticeView, e: { currentTarget: HTMLButtonElement }) => {
    e.currentTarget.blur();
    const s = useReplay.getState();
    // Back to the replay: if the comparison picked its drivers itself, the replay's selection goes back to none.
    const picked = useQuali.getState().autoPicked;
    if (view === "replay" && picked && picked.length === s.selected.length && picked.every((n, i) => s.selected[i] === n)) s.clearSelection();
    s.setPracticeView(view);
  };
  return (
    <div className="flex shrink-0 rounded-md bg-zinc-900 p-0.5" role="group" aria-label="Screen">
      {VIEWS.map((v) => (
        <button
          key={v.id}
          type="button"
          onClick={(e) => choose(v.id, e)}
          aria-pressed={shown === v.id}
          title={v.title}
          className={`whitespace-nowrap rounded px-2 py-0.5 text-xs font-semibold ${shown === v.id ? "bg-zinc-100 text-zinc-900" : "text-zinc-400 hover:text-zinc-100"}`}
        >
          {v.label}
        </button>
      ))}
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
      <span className="text-zinc-400" title={distance.estimated ? "Estimated race distance" : undefined}>
        {" "}
        / {distance.estimated ? "~" : ""}
        {distance.totalLaps}
      </span>
    </span>
  );
}

/** Practice runs to the clock: the time left (it keeps running under a red flag), as on the timing screens. */
function SessionClock({ race, meta }: { race: RaceState; meta: SessionMeta }) {
  const finished = race.trackStatus === "CHEQUERED" || (meta.chequered != null && race.t >= meta.chequered);
  // Live, before the green light, the start is only the scheduled one.
  if (race.raceTime < 0) {
    return (
      <span className="text-xl font-black tracking-tight tabular-nums">
        {meta.lightsOutEstimated ? "PRE-SESSION" : `STARTS IN ${raceClock(-race.raceTime)}`}
      </span>
    );
  }
  if (finished) return <span className="text-xl font-black tracking-tight">FINISHED</span>;
  const left = Math.max(0, (meta.practice?.scheduledEnd ?? race.t) - race.t);
  return (
    <span className="text-xl font-black tracking-tight tabular-nums" title="Session time left">
      {raceClock(left + 999)}
      <span className="text-zinc-400"> LEFT</span>
    </span>
  );
}

function Weather({ w }: { w: WeatherSample | null }) {
  if (!w) return <span className="text-xs text-zinc-400">No weather data</span>;
  const items: [string, string, string?][] = [
    ["Air", `${w.airTemp.toFixed(1)}°`],
    ["Track", `${w.trackTemp.toFixed(1)}°`],
    ["Hum", `${Math.round(w.humidity)}%`],
    ["Wind", `${w.windSpeed.toFixed(1)} m/s`, `Wind ${w.windSpeed.toFixed(1)} m/s from ${Math.round(w.windDirection)}°`],
  ];
  return (
    <div className="flex items-center gap-3">
      {w.rainfall > 0 && (
        <span className="flex items-center gap-1 rounded bg-sky-500/20 px-1.5 py-0.5 text-[11px] font-semibold text-sky-300" title="Rainfall reported">
          <Icon name="rain" size={12} />
          Rain
        </span>
      )}
      {items.map(([label, value, title]) => (
        <Stat key={label} label={label} title={title} className="items-end leading-tight">
          <span className="text-xs tabular-nums text-zinc-200">{value}</span>
        </Stat>
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
      <div className="pointer-events-none absolute right-0 top-full z-30 mt-2 hidden w-64 rounded-lg border border-zinc-800 bg-zinc-900 p-3 shadow-xl group-focus-within:block group-hover:block">
        <Label as="div" className="mb-2">Keyboard shortcuts</Label>
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
  const paused = useLayout((s) => s.pausedPlayback);
  const shared = useLayout((s) => s.shared);
  const blur = (e: { currentTarget: HTMLButtonElement }) => e.currentTarget.blur();
  if (shared && !editing) {
    return (
      <div className="flex items-center gap-1.5">
        <span className="mr-1.5 whitespace-nowrap" title="The layout the link was shared with. Yours is kept unless you keep this one.">
          <Label>Shared layout</Label>
        </span>
        <button
          type="button"
          onClick={(e) => {
            blur(e);
            useLayout.getState().keepShared();
          }}
          className={`${TOP_BUTTON} bg-zinc-800 text-zinc-100 hover:bg-zinc-700 hover:text-white`}
          title="Make this layout yours"
        >
          Keep
        </button>
        <button
          type="button"
          onClick={(e) => {
            blur(e);
            useLayout.getState().dropShared();
          }}
          className={`${TOP_BUTTON} bg-zinc-800 text-zinc-100 hover:bg-zinc-700 hover:text-white`}
          title="Back to your own layout"
        >
          Use mine
        </button>
      </div>
    );
  }
  if (!editing) {
    return (
      <button
        type="button"
        onClick={(e) => {
          blur(e);
          useLayout.getState().startEdit();
        }}
        className={`${TOP_BUTTON} bg-zinc-800 text-zinc-100 hover:bg-zinc-700 hover:text-white`}
        title="Move, resize, add and remove widgets"
      >
        Edit layout
      </button>
    );
  }
  const s = useLayout.getState();
  return (
    <div className="flex items-center gap-1.5">
      {paused && (
        <span className="mr-1.5 whitespace-nowrap" title="Done resumes playback">
          <Label>Paused while editing</Label>
        </span>
      )}
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
        + Add widget
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
        <PracticeViewSwitch />
        <LiveControl />
      </div>

      <div className="flex items-center gap-5">
        {race && (meta.practice ? <SessionClock race={race} meta={meta} /> : <LapCounter race={race} meta={meta} />)}
        <div className="flex items-center gap-4">
          <Stat label={meta.practice ? "Session" : "Race"} className="leading-tight" title={meta.practice ? "Time since the green light" : undefined}>
            <span className="text-sm tabular-nums text-zinc-100">{race ? raceClock(race.raceTime) : "—"}</span>
          </Stat>
          <Stat label="Local" className="leading-tight" title={`Local time at the circuit (UTC${meta.gmtOffset.startsWith("-") ? "" : "+"}${meta.gmtOffset.slice(0, -3)})`}>
            <span className="text-sm tabular-nums text-zinc-300">{localTime(meta.t0, t, meta.gmtOffset)}</span>
          </Stat>
        </div>
        {status && <span className={`whitespace-nowrap rounded px-2 py-0.5 text-xs font-bold uppercase tracking-wide ${status.className}`}>{status.label}</span>}
      </div>

      <div className="flex items-center justify-end gap-4">
        <Weather w={race?.weather ?? null} />
        {!meta.quali && <LayoutControls />}
        <ShareButton />
        <ShortcutsHelp />
      </div>
    </header>
  );
}
