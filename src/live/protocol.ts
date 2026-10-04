// WebSocket protocol between the live relay (server/live.ts) and the app.
// The app connects to `/relay` (proxied to the relay by Vite in dev). Server -> client only.
//
// Live sessions use the same processed format as replays (src/types.ts), so the app can
// build a normal `Session` from a snapshot and keep it growing:
//   - `snapshot` on connect and whenever the live session changes: full state so far.
//   - `meta`: the whole SessionMeta recomputed (laps, positions, gaps, race control...), as soon as timing
//     changes (within ~0.1 s of a lap, position, interval, pit or race control record, at most every 0.25 s),
//     else every ~2 s.
//   - `tel` every ~0.5 s: only the new car/location samples since the previous `tel`.
// Times are ms since `meta.t0`, which stays fixed for the whole live session.
// In live metas, `duration` equals `now` (the live edge) and grows; `chequered` is null until shown;
// `results` only holds what OpenF1 has published so far.

import type { DriverTelemetry, Ms, SessionMeta } from "../types";

export type LiveState =
  | "idle" // no live race/sprint right now (see `next`)
  | "connecting" // authenticating / subscribing / backfilling
  | "live" // streaming
  | "ended" // session finished; data stays available until the next one starts
  | "error"; // e.g. missing or rejected credentials (see `detail`)

export interface LiveStatus {
  type: "status";
  state: LiveState;
  source: "openf1" | "simulate";
  sessionKey: number | null;
  detail?: string;
  next?: { sessionKey: number; name: string; dateStart: string } | null;
}

export interface LiveSnapshot {
  type: "snapshot";
  meta: SessionMeta;
  telemetry: DriverTelemetry[]; // same encoding as drivers/<n>.json (t delta-encoded, t[0] absolute)
  now: Ms;
}

export interface LiveMetaUpdate {
  type: "meta";
  meta: SessionMeta;
  now: Ms;
}

export interface LiveTelemetryUpdate {
  type: "tel";
  now: Ms;
  // New samples only, one chunk per driver that has any; same encoding as DriverTelemetry
  // (chunk t[0] is absolute ms since meta.t0), to be appended to what the client already has.
  chunks: DriverTelemetry[];
}

export type LiveMessage = LiveStatus | LiveSnapshot | LiveMetaUpdate | LiveTelemetryUpdate;
