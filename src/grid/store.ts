// The dashboard on screen and edit mode (H3.10, H3.11). In normal mode a widget's own setting changes (the
// tower's Gap/Int toggle) are saved at once; in edit mode everything is saved on Done. Playback pauses
// in edit mode (dragging with the race playing janks) and resumes on Done, unless the user pressed play
// meanwhile, in which case it's left as they set it. Races, free practice and live qualifying each have their dashboards
// (dashboards.ts): opening a session of the other kind shows (and edits) that kind's active one. A shared link's
// layout (share/layoutCode.ts) is shown instead of the dashboard without replacing it: Save as dashboard (or editing
// it) makes it one of the user's own, Use mine goes back. A link's `dash=` shows that dashboard once its session is open.

import { create } from "zustand";
import type { WidgetSettings } from "../widgetkit/defineWidget";
import type { Session } from "../data/session";
import { track } from "../posthog";
import { useReplay } from "../store";
import { BUILTIN_WIDGETS } from "./builtins";
import {
  activeOf,
  addOwn,
  freeName,
  hasDashboard,
  layoutOf,
  loadDashboards,
  PRESETS,
  remove,
  rename,
  saveDashboards,
  setActive,
  withLayout,
  type Dashboards,
} from "./dashboards";
import type { Slot } from "./edit";
import type { Layout } from "./layout";
import type { GridKind } from "./storage";

/** Which layout a session is shown with. */
const gridKindOf = (session: Session | null): GridKind | null =>
  session ? (session.meta.practice ? "practice" : session.meta.qualiLive ? "qualifying" : "race") : null;

interface LayoutState {
  /** The kind of session the layout is for. */
  kind: GridKind;
  dashboards: Dashboards;
  /** The dashboard on screen (of `kind`). */
  dashboard: string;
  layout: Layout;
  editing: boolean;
  /** Edit mode is for a dashboard just made: its name is ready to type over. */
  fresh: boolean;
  /** The layout on screen is a shared link's, not saved. */
  shared: boolean;
  /** Edit mode paused the race, and Done will resume it. */
  pausedPlayback: boolean;
  /** The widget picker, open for a free slot or (without one) wherever the widget fits. */
  picker: { slot?: Slot } | null;
  startEdit: () => void;
  /** Saves the layout and leaves edit mode. */
  done: () => void;
  /** The preset as it ships, saved on Done. */
  reset: () => void;
  setLayout: (layout: Layout) => void;
  setSettings: (id: string, settings: Partial<WidgetSettings>) => void;
  openPicker: (slot?: Slot) => void;
  closePicker: () => void;
  /** Shows another dashboard of this kind (not while editing). */
  switchTo: (id: string) => void;
  /** A dashboard of the user's own, starting as a copy of what's on screen, opened in edit mode. */
  newDashboard: () => void;
  /** Renames the user's own dashboard on screen. */
  renameDashboard: (name: string) => void;
  /** Deletes the user's own dashboard on screen (edits and all), and shows the first preset. */
  deleteDashboard: () => void;
  /** A link's `dash=`: shown now if `sessionKey`'s on screen (null: live), else once a session is opened. */
  requestDashboard: (id: string, sessionKey: number | null) => void;
  /** A shared link's layout for `kind` sessions: shown now if that's the kind on screen, else once it is. */
  showShared: (kind: GridKind, layout: Layout) => void;
  /** Saves the shared layout as a dashboard of the user's own. */
  keepShared: () => void;
  /** Back to the dashboard. */
  dropShared: () => void;
}

/** A shared link's layout waiting for a session of its kind. */
let pendingShared: { kind: GridKind; layout: Layout } | null = null;
/** A link's dashboard waiting for its session. */
let pendingDashboard: string | null = null;

/** While edit mode has the race paused: the watch for the user pressing play. */
let stopWatching: (() => void) | null = null;

/** The kind on screen when this store is made (a hot reload can make it with a session open); "race" before one is. */
const initialKind = gridKindOf(useReplay.getState().session) ?? "race";
const initialDashboards = loadDashboards(BUILTIN_WIDGETS);
const initialActive = activeOf(initialDashboards, initialKind);

/** Whether a dashboard is a preset or the user's own, for analytics (their own's ids mean nothing). */
const dashboardProp = (kind: GridKind, id: string) => (PRESETS[kind].some((p) => p.id === id) ? id : "own");

export const useLayout = create<LayoutState>((set, get) => {
  const store = (dashboards: Dashboards) => {
    saveDashboards(dashboards);
    set({ dashboards });
  };
  /** Out of edit mode without saving; playback resumes if edit mode paused it. */
  const leaveEdit = () => {
    const resume = get().pausedPlayback;
    stopWatching?.();
    stopWatching = null;
    set({ editing: false, fresh: false, pausedPlayback: false, picker: null });
    // Paused and unlatched, toggling plays and latches again, as before edit mode.
    if (resume && !useReplay.getState().playing) useReplay.getState().togglePlay();
  };
  /** What's on screen saved: over the dashboard, or (a shared link's) as a new one of the user's own. */
  const saveScreen = () => {
    const { dashboards, kind, dashboard, layout, shared } = get();
    if (!shared) return store(withLayout(dashboards, kind, dashboard, layout));
    const [next, id] = addOwn(dashboards, kind, freeName(dashboards, kind, "Shared dashboard"), layout);
    store(next);
    set({ dashboard: id, shared: false });
    track("dashboard_created", { from: "shared", session_kind: kind });
  };

  return {
    kind: initialKind,
    dashboards: initialDashboards,
    dashboard: initialActive,
    layout: layoutOf(initialDashboards, initialKind, initialActive),
    editing: false,
    fresh: false,
    shared: false,
    pausedPlayback: false,
    picker: null,
    startEdit: () => {
      const replay = useReplay.getState();
      // Playing on a held space isn't resumed: its release would have paused it anyway.
      const resume = replay.playing && replay.latched;
      if (replay.playing) replay.setPlaying(false);
      set({ editing: true, pausedPlayback: resume });
      if (!resume) return;
      // Pressing play (or opening another race) while editing hands playback back to the user.
      const session = replay.session;
      const unsubscribe = useReplay.subscribe((s) => {
        if (!get().editing || s.playing || s.session !== session) {
          unsubscribe();
          stopWatching = null;
          if (get().editing) set({ pausedPlayback: false });
        }
      });
      stopWatching = unsubscribe;
    },
    done: () => {
      saveScreen();
      leaveEdit();
    },
    reset: () => {
      const { kind, dashboard } = get();
      const preset = PRESETS[kind].find((p) => p.id === dashboard);
      if (preset) set({ layout: preset.layout, picker: null });
    },
    setLayout: (layout) => set({ layout }),
    setSettings: (id, settings) => {
      const { layout, editing, kind, shared, dashboard, dashboards } = get();
      const entry = layout.widgets[id];
      if (!entry) return;
      const next = { ...layout, widgets: { ...layout.widgets, [id]: { ...entry, settings } } };
      set({ layout: next });
      if (!editing && !shared) store(withLayout(dashboards, kind, dashboard, next));
    },
    openPicker: (slot) => set({ picker: slot ? { slot } : {} }),
    closePicker: () => set({ picker: null }),
    switchTo: (id) => {
      const { editing, kind, dashboards, dashboard, shared } = get();
      if (editing || !hasDashboard(dashboards, kind, id) || (id === dashboard && !shared)) return;
      store(setActive(dashboards, kind, id));
      set({ dashboard: id, layout: layoutOf(get().dashboards, kind, id), shared: false });
      track("dashboard_switched", { dashboard: dashboardProp(kind, id), session_kind: kind });
    },
    newDashboard: () => {
      const { editing, kind, dashboards, layout } = get();
      if (editing) return;
      const [next, id] = addOwn(dashboards, kind, freeName(dashboards, kind, "My dashboard"), layout);
      store(next);
      set({ dashboard: id, shared: false, fresh: true });
      track("dashboard_created", { from: "copy", session_kind: kind });
      get().startEdit();
    },
    renameDashboard: (name) => {
      const { kind, dashboards, dashboard } = get();
      store(rename(dashboards, kind, dashboard, name));
    },
    deleteDashboard: () => {
      const { kind, dashboards, dashboard } = get();
      if (PRESETS[kind].some((p) => p.id === dashboard)) return;
      const next = remove(dashboards, kind, dashboard);
      store(next);
      const shown = activeOf(next, kind);
      set({ dashboard: shown, layout: layoutOf(next, kind, shown), shared: false });
      if (get().editing) leaveEdit();
      track("dashboard_deleted", { session_kind: kind });
    },
    requestDashboard: (id, sessionKey) => {
      const replay = useReplay.getState();
      const open = replay.session != null && (sessionKey == null ? replay.mode === "live" : replay.session.meta.sessionKey === sessionKey);
      if (!open) {
        pendingDashboard = id;
        return;
      }
      pendingDashboard = null;
      if (get().editing) get().done();
      get().switchTo(id);
    },
    showShared: (kind, layout) => {
      if (kind !== get().kind) {
        pendingShared = { kind, layout };
        return;
      }
      pendingShared = null;
      if (get().editing) get().done();
      set({ layout, shared: true });
    },
    keepShared: () => saveScreen(),
    dropShared: () => {
      const { dashboards, kind, dashboard } = get();
      set({ layout: layoutOf(dashboards, kind, dashboard), shared: false });
    },
  };
});

// Another session: a link's dashboard, if it asked for one this kind has; a session of the other kind shows its
// kind's dashboard. Editing the one on screen ends as Done would (saved), so nothing's lost.
let lastSession = useReplay.getState().session;
useReplay.subscribe((s) => {
  if (s.session === lastSession) return;
  lastSession = s.session;
  const kind = gridKindOf(s.session);
  if (kind == null) return;
  const state = useLayout.getState();
  const wanted = pendingDashboard;
  pendingDashboard = null;
  const shared = pendingShared?.kind === kind ? pendingShared.layout : null;
  if (shared) pendingShared = null;
  const asked = wanted != null && hasDashboard(state.dashboards, kind, wanted) ? wanted : null;
  if (kind === state.kind && asked == null && shared == null) return;
  let dashboards = state.dashboards;
  if (state.editing) {
    // As Done, without resuming: another session is opening.
    const { kind: was, layout } = state;
    dashboards = state.shared ? addOwn(dashboards, was, freeName(dashboards, was, "Shared dashboard"), layout)[0] : withLayout(dashboards, was, state.dashboard, layout);
    stopWatching?.();
    stopWatching = null;
  }
  if (asked != null) dashboards = setActive(dashboards, kind, asked);
  if (dashboards !== state.dashboards) saveDashboards(dashboards);
  const dashboard = activeOf(dashboards, kind);
  useLayout.setState({
    kind,
    dashboards,
    dashboard,
    layout: shared ?? layoutOf(dashboards, kind, dashboard),
    shared: shared != null,
    editing: false,
    fresh: false,
    pausedPlayback: false,
    picker: null,
  });
});
