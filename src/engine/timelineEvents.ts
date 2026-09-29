// Substantial race events for the timeline's marker lane: derived once per session,
// then clustered for the bar's current width.

import type { Ms, SessionMeta, TrackStatus } from "../types";

export type TimelineEventKind = "red" | "sc" | "vsc" | "retired" | "penalty" | "double-yellow" | "yellow";

export interface TimelineEvent {
  t: Ms;
  kind: TimelineEventKind;
  text: string;
  driver: number | null;
}

/** When markers are clustered, the highest-priority kind is shown. */
export const EVENT_PRIORITY: Record<TimelineEventKind, number> = {
  red: 6,
  sc: 5,
  vsc: 4,
  retired: 3,
  penalty: 2,
  "double-yellow": 1,
  yellow: 0,
};

type Period = "red" | "sc" | "vsc";

// "Ending" statuses continue a period rather than start a new one.
const PERIOD: Partial<Record<TrackStatus, Period>> = {
  RED: "red",
  SC: "sc",
  SC_ENDING: "sc",
  VSC: "vsc",
  VSC_ENDING: "vsc",
};

const PERIOD_TEXT: Record<Period, string> = {
  red: "Red flag",
  sc: "Safety car deployed",
  vsc: "Virtual safety car deployed",
};

/** "FIA STEWARDS: 10 SECOND TIME PENALTY FOR CAR 43 (COL) - CAUSING A COLLISION (16:11:31)" -> "10 SECOND ... COLLISION" */
const stewardsText = (message: string) => message.replace(/^FIA STEWARDS:\s*/, "").replace(/\s*\(\d{1,2}:\d{2}:\d{2}\)$/, "");

/**
 * Safety car / VSC / red flag starts, sector yellow flags, retirements and stewards' penalties
 * within the replay window, sorted by time (ties: highest priority first).
 */
export function timelineEvents(meta: SessionMeta): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  const inWindow = (t: Ms) => t >= 0 && t <= meta.duration;

  let previous: Period | undefined;
  for (const s of meta.trackStatus) {
    const period = PERIOD[s.status];
    if (period && period !== previous && inWindow(s.t)) events.push({ t: s.t, kind: period, text: PERIOD_TEXT[period], driver: null });
    previous = period;
  }

  for (const m of meta.raceControl) {
    if (!inWindow(m.t)) continue;
    if (m.category === "Flag" && m.scope === "Sector" && (m.flag === "YELLOW" || m.flag === "DOUBLE YELLOW")) {
      const double = m.flag === "DOUBLE YELLOW";
      const where = m.sector != null ? `sector ${m.sector}` : m.message;
      events.push({ t: m.t, kind: double ? "double-yellow" : "yellow", text: `${double ? "Double yellow" : "Yellow"} · ${where}`, driver: m.driver });
    } else if (m.message.startsWith("FIA STEWARDS") && m.message.includes("PENALTY")) {
      events.push({ t: m.t, kind: "penalty", text: stewardsText(m.message), driver: m.driver });
    }
  }

  const acronym = new Map(meta.drivers.map((d) => [d.number, d.acronym]));
  for (const r of meta.results) {
    if (r.retired == null || !inWindow(r.retired)) continue;
    const name = acronym.get(r.driver) ?? `#${r.driver}`;
    events.push({ t: r.retired, kind: "retired", text: `${name} ${r.dns ? "did not start" : "retired"}`, driver: r.driver });
  }

  return events.sort((a, b) => a.t - b.t || EVENT_PRIORITY[b.kind] - EVENT_PRIORITY[a.kind]);
}

export interface EventCluster {
  /** Where the marker goes: the time of its highest-priority event. */
  t: Ms;
  kind: TimelineEventKind;
  primary: TimelineEvent;
  events: TimelineEvent[]; // sorted by time
}

/**
 * Groups time-sorted events whose markers would overlap on a bar `widthPx` wide spanning `duration`.
 * Each event's marker is centred on its time and takes max(`minGapPx`, `markerPx(kind)`), so small ticks
 * merge when within `minGapPx` of each other and wider labels when they'd touch. A cluster shows its
 * highest-priority event (earliest on ties).
 */
export function clusterEvents(
  events: TimelineEvent[],
  duration: Ms,
  widthPx: number,
  markerPx: (kind: TimelineEventKind) => number = () => 0,
  minGapPx = 6,
): EventCluster[] {
  if (widthPx <= 0 || duration <= 0) return [];
  const clusters: EventCluster[] = [];
  let current: TimelineEvent[] = [];
  let right = 0; // right edge (px) of the current cluster's markers
  const flush = () => {
    if (current.length === 0) return;
    const primary = current.reduce((best, e) => (EVENT_PRIORITY[e.kind] > EVENT_PRIORITY[best.kind] ? e : best));
    clusters.push({ t: primary.t, kind: primary.kind, primary, events: current });
    current = [];
  };
  for (const e of events) {
    const x = (e.t / duration) * widthPx;
    const half = Math.max(minGapPx, markerPx(e.kind)) / 2;
    if (current.length > 0 && x - half >= right) flush();
    right = current.length === 0 ? x + half : Math.max(right, x + half);
    current.push(e);
  }
  flush();
  return clusters;
}
