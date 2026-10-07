import { Icon } from "../widgetkit/ui/Icon";
import { Label, Stat } from "../widgetkit/ui/Label";
import { circuitSlug } from "../circuit";
import { canCompare } from "../data/compare";
import { raceDistanceAt } from "../engine/raceDistance";
import type { RaceState } from "../engine/raceState";
import { dashboardList, NAME_MAX, PRESETS } from "../grid/dashboards";
import { useLayout } from "../grid/store";
import { localTime, raceClock, TRACK_STATUS } from "../lib/format";
import { useQuali } from "../qualiStore";
import { usePhone } from "../hooks/usePhone";
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

/** `compact`: a phone's header row, where the select fills what's left and the circuit line is dropped. */
export function SessionPicker({ meta, compact = false }: { meta: SessionMeta; compact?: boolean }) {
  const index = useReplay((s) => s.index);
  const loadingKey = useReplay((s) => s.loading?.key);
  const loadSession = useReplay((s) => s.loadSession);
  const current = loadingKey ?? meta.sessionKey;
  const inIndex = index.some((e) => e.sessionKey === meta.sessionKey);

  return (
    <div className={`flex min-w-0 flex-col justify-center ${compact ? "flex-1" : ""}`}>
      <select
        value={current}
        onChange={(e) => {
          // Blur so the keyboard shortcuts (ignored while a <select> has focus) keep working.
          e.currentTarget.blur();
          // From practice's Fastest laps, another practice session opens in its Fastest laps too.
          const s = useReplay.getState();
          loadSession(Number(e.target.value), { view: comparing(s) && s.session?.meta.practice ? "laps" : undefined });
        }}
        className={`max-w-full cursor-pointer self-start truncate field-sizing-content rounded bg-transparent pr-1 text-sm font-semibold text-zinc-100 hover:bg-zinc-900 ${compact ? "h-11" : "py-0.5"}`}
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
      {!compact && (
        <span className="truncate text-[11px] text-zinc-400">
          <button
            type="button"
            onClick={(e) => {
              e.currentTarget.blur();
              useReplay.getState().openCircuit(circuitSlug(meta.circuit));
            }}
            className="rounded-sm hover:text-zinc-100 hover:underline hover:decoration-zinc-500 hover:underline-offset-2"
            title={`${meta.circuit}: every session there, and its history`}
          >
            {meta.circuit}
          </button>
          {meta.country ? ` · ${meta.country}` : ""}
        </span>
      )}
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
  // Keyboard shortcuts mean nothing on a touch screen, and the popover opens on hover: not shown there.
  return (
    <div className="group relative hidden pointer-fine:block">
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
const QUIET_BUTTON = `${TOP_BUTTON} bg-zinc-800 text-zinc-100 hover:bg-zinc-700 hover:text-white`;
/** The switcher's option that makes a dashboard instead of showing one. */
const NEW_DASHBOARD = "+new";

/**
 * The dashboards of the kind on screen, to switch between, and a new one, a copy of what's on screen. Not while
 * editing (edit mode shows the dashboard's name instead).
 */
function DashboardPicker() {
  const kind = useLayout((s) => s.kind);
  const dashboards = useLayout((s) => s.dashboards);
  const active = useLayout((s) => s.dashboard);
  const shared = useLayout((s) => s.shared);
  const grid = useReplay((s) => !comparing(s));
  if (!grid) return null;
  const items = dashboardList(dashboards, kind);
  const own = items.filter((i) => !i.preset);
  return (
    // The app's chevron, not the browser's: a native one brings its own padding and height, so the select stood
    // taller and off-centre beside the buttons next to it.
    <span className="relative inline-flex shrink-0">
      <select
        value={shared ? "" : active}
        onChange={(e) => {
          // Blur so the keyboard shortcuts (ignored while a <select> has focus) keep working.
          e.currentTarget.blur();
          const s = useLayout.getState();
          if (e.target.value === NEW_DASHBOARD) s.newDashboard();
          else s.switchTo(e.target.value);
        }}
        className={`${TOP_BUTTON} max-w-44 cursor-pointer appearance-none truncate field-sizing-content bg-zinc-800 pr-6 text-zinc-100 hover:bg-zinc-700`}
        title="Dashboard: the widgets on screen, for any session"
        aria-label="Dashboard"
      >
        {shared && (
          <option value="" disabled className="bg-zinc-900">
            Shared dashboard
          </option>
        )}
        <optgroup label="Built in" className="bg-zinc-900">
          {items
            .filter((i) => i.preset)
            .map((i) => (
              <option key={i.id} value={i.id} title={i.description}>
                {i.name}
              </option>
            ))}
        </optgroup>
        {own.length > 0 && (
          <optgroup label="Yours" className="bg-zinc-900">
            {own.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name}
              </option>
            ))}
          </optgroup>
        )}
        <option value={NEW_DASHBOARD} className="bg-zinc-900">
          + New dashboard
        </option>
      </select>
      <Icon name="chevron-left" size={12} className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 -rotate-90 text-zinc-400" />
    </span>
  );
}

/** Edit mode's name for the dashboard: a field for the user's own, the preset's name for a preset. */
function DashboardName() {
  const kind = useLayout((s) => s.kind);
  const dashboards = useLayout((s) => s.dashboards);
  const active = useLayout((s) => s.dashboard);
  const shared = useLayout((s) => s.shared);
  const fresh = useLayout((s) => s.fresh);
  const item = dashboardList(dashboards, kind).find((i) => i.id === active);
  if (shared || !item) return <Label className="mr-1.5 whitespace-nowrap">Shared dashboard</Label>;
  if (item.preset) return <span className="mr-1.5 whitespace-nowrap text-xs font-semibold text-zinc-300">{item.name}</span>;
  return (
    <input
      key={item.id}
      defaultValue={item.name}
      maxLength={NAME_MAX}
      aria-label="Dashboard name"
      title="The dashboard's name"
      // A new one's name is a placeholder: ready to type over.
      autoFocus={fresh}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => useLayout.getState().renameDashboard(e.target.value)}
      onBlur={(e) => {
        // Left empty: the name it has.
        if (e.currentTarget.value.trim() === "") e.currentTarget.value = item.name;
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter" || e.key === "Escape") e.currentTarget.blur();
      }}
      className="w-32 rounded-md border border-zinc-700 bg-zinc-900 px-2 py-0.5 text-xs font-semibold text-zinc-100 outline-none focus:border-zinc-500"
    />
  );
}

/** The dashboard switcher and "Edit dashboard", or in edit mode what edit mode needs (H3.10). */
function LayoutControls() {
  const editing = useLayout((s) => s.editing);
  const pickerOpen = useLayout((s) => s.picker != null && s.picker.slot == null);
  const paused = useLayout((s) => s.pausedPlayback);
  const shared = useLayout((s) => s.shared);
  const preset = useLayout((s) => PRESETS[s.kind].some((p) => p.id === s.dashboard));
  const blur = (e: { currentTarget: HTMLButtonElement }) => e.currentTarget.blur();
  if (shared && !editing) {
    return (
      <div className="flex items-center gap-1.5">
        <span className="mr-1.5 whitespace-nowrap" title="The dashboard the link was shared with. Yours are kept unless you save this one.">
          <Label>Shared dashboard</Label>
        </span>
        <button
          type="button"
          onClick={(e) => {
            blur(e);
            useLayout.getState().keepShared();
          }}
          className={QUIET_BUTTON}
          title="Save it as a dashboard of your own"
        >
          Save
        </button>
        <button
          type="button"
          onClick={(e) => {
            blur(e);
            useLayout.getState().dropShared();
          }}
          className={QUIET_BUTTON}
          title="Back to your own dashboard"
        >
          Use mine
        </button>
      </div>
    );
  }
  if (!editing) {
    return (
      <div className="flex items-center gap-1.5">
        <DashboardPicker />
        <button
          type="button"
          onClick={(e) => {
            blur(e);
            useLayout.getState().startEdit();
          }}
          className={QUIET_BUTTON}
          title="Move, resize, add and remove widgets"
        >
          Edit
        </button>
      </div>
    );
  }
  const s = useLayout.getState();
  return (
    <div className="flex items-center gap-1.5">
      {paused && (
        <span className="mr-1.5 whitespace-nowrap" title="Paused while editing: Done resumes playback">
          <Label>Paused</Label>
        </span>
      )}
      <DashboardName />
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
      {preset && !shared ? (
        <button
          type="button"
          onClick={(e) => {
            blur(e);
            s.reset();
          }}
          className={QUIET_BUTTON}
          title="Back to the dashboard as it ships (saved on Done)"
        >
          Reset
        </button>
      ) : (
        !shared && (
          <button
            type="button"
            onClick={(e) => {
              blur(e);
              const name = s.dashboards[s.kind].own.find((o) => o.id === s.dashboard)?.name ?? "this dashboard";
              if (confirm(`Delete “${name}”?`)) s.deleteDashboard();
            }}
            className={`${TOP_BUTTON} bg-zinc-800 text-zinc-100 hover:bg-red-500/20 hover:text-red-200`}
            title="Delete this dashboard"
          >
            Delete
          </button>
        )
      )}
      <button
        type="button"
        onClick={(e) => {
          blur(e);
          s.done();
        }}
        className={`${TOP_BUTTON} bg-zinc-100 text-zinc-950 hover:bg-white`}
        title="Save the dashboard"
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
  const phone = usePhone();
  // Edit mode's controls take the room of the weather, Share and the keyboard help.
  const editing = useLayout((s) => s.editing);
  if (!session) return null;
  const { meta } = session;
  const status = race ? TRACK_STATUS[race.trackStatus] : null;
  const statusPill = status && <span className={`whitespace-nowrap rounded px-2 py-0.5 text-xs font-bold uppercase tracking-wide ${status.className}`}>{status.label}</span>;

  if (phone) {
    // Two rows: the way around (Races, the session, live mode's controls), then the race's state. Weather, the
    // dashboards (the phone column starts with them: grid/Grid.tsx), editing (it's for desktops), the keyboard help, the local clock and Share (ShareShot.tsx) are
    // left out.
    return (
      <header className="border-b border-zinc-800 bg-zinc-950 pt-[env(safe-area-inset-top)]">
        <div className="flex h-11 items-center gap-2 px-3">
          <RacesButton />
          <SessionPicker meta={meta} compact />
          <LiveControl />
        </div>
        <div className="flex h-9 items-center gap-3 px-3 pb-1">
          {race && (meta.practice ? <SessionClock race={race} meta={meta} /> : <LapCounter race={race} meta={meta} />)}
          <Stat label={meta.practice ? "Session" : "Race"} className="leading-tight" title={meta.practice ? "Time since the green light" : undefined}>
            <span className="text-sm tabular-nums text-zinc-100">{race ? raceClock(race.raceTime) : "—"}</span>
          </Stat>
          {statusPill}
          <span className="flex-1" />
          <PracticeViewSwitch />
        </div>
      </header>
    );
  }

  return (
    <header className="grid h-[calc(52px_+_env(safe-area-inset-top))] grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-4 border-b border-zinc-800 bg-zinc-950 px-4 pt-[env(safe-area-inset-top)]">
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
        {statusPill}
      </div>

      <div className="flex items-center justify-end gap-4">
        {!editing && <Weather w={race?.weather ?? null} />}
        {!meta.quali && <LayoutControls />}
        {!editing && <ShareButton />}
        {!editing && <ShortcutsHelp />}
      </div>
    </header>
  );
}
