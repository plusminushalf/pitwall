// block-kit: the public API for blocks (docs/modular-hypotheses.md, want 3). Blocks import only
// this ("block-kit") and React; everything else in src/blockkit/ is the core's side.
//
// Every hook returns data up to the current replay time only (spoiler-free), except useWholeSession().
// React hooks update at most 10 times a second and only when their own data changed; useFrame draws
// every animation frame. Off-screen blocks pause.
//
//   defineBlock(def)             id, name, version, shape, width, sessions, settings, Component
//
//   Time and playback
//     useTime()                  replay time, 10 Hz
//     useFrame(draw)             draw({ t, car(n) }) every animation frame, no re-render
//     usePlayback()              playing, speed, speeds, play, pause, seek, seekToLap, setSpeed
//   Session info (fixed for the session)
//     useDrivers()               names, teams, colours, headshots
//     useTrack()                 outline, pit lane, corners, sector marks, marshal sectors
//     useSessionInfo()           circuit, session name, total laps, t0 and UTC offset, lights out
//   The race at t
//     useRace()                  track status, sector flags, weather, fastest lap, running order
//     useDriver(n)               position, gaps, tyres, lap, status
//     useCar(n)                  speed, gear, RPM, throttle, brake, DRS
//     useCarHistory(n, windowMs) telemetry samples in [t - windowMs, t]
//     useLaps(n)                 completed laps
//     useStints(n)               stints started so far (the current one open)
//     useFeed()                  race feed so far, newest first
//     useBestSectors()           fastest time in each sector by anyone so far
//   Selection
//     useSelection()             selected and focused drivers, with setters
//     useSelectedDriver()        pinned by settings, else focused, else best-placed selected, else leader
//   The block itself
//     useSettings()              [settings, update]
//     useBlockSize()             { width, height, pixelRatio } in layout px
//     useLayoutPoint()           pointer event -> { x, y } in layout px
//   Media
//     useRadio()                 playing, unavailable, play(url), stop()
//   Opt-out
//     useWholeSession()          the whole session, future included
//
//   API gaps found rebuilding today's screen (step 2), marked "API gap" where they're defined:
//     COLUMN_WIDTH               layout px per column, so a shape can come from content in px
//     useBlockSize().pixelRatio  device px per layout px (the grid scales blocks), for canvases
//     useRace().positions        every car's position at once (map labels)
//     useBestSectors()           fastest sector times by anyone so far
//     useFeed() entries          `id` (stable key, kept across live rebuilds) and `postRace`
//     useLayoutPoint()           pointer events to layout px (clickable canvases in a zoomed block)
//     useRadio()                 team radio played by the core, one clip at a time app-wide
//
//   Provisional UI kit (until the shared UI kit, step 4): format helpers, colours, the track
//   projection and aspect, and TyreBadge, lifted as they are from the core.

export { COLUMN_WIDTH, defineBlock } from "./defineBlock";
export type { BlockDefinition, BlockSettings, DriverSetting, SettingValue, ShapeInput } from "./defineBlock";

export {
  useBestSectors,
  useBlockSize,
  useCar,
  useCarHistory,
  useDriver,
  useDrivers,
  useFeed,
  useFrame,
  useLaps,
  useLayoutPoint,
  usePlayback,
  useRadio,
  useRace,
  useSelectedDriver,
  useSelection,
  useSessionInfo,
  useSettings,
  useStints,
  useTime,
  useTrack,
  useWholeSession,
} from "./hooks";
export type { Playback, Radio, Selection } from "./hooks";

export type { BlockSize } from "./context";
export type { DrawFn, Frame } from "./frame";
export type { CarHistory, CarPosition, FeedEntry, RaceView, SessionInfo, SessionKind, StintView, Track, WholeSession } from "./select";
export type { FeedItem, FeedKind } from "../data/session";
export type { DriverState, DriverStatus, SectorFlag, Telemetry } from "../engine/raceState";
export type { DriverInfo, Lap, SessionMeta, Stint, TrackStatus, WeatherSample } from "../types";

// ---------------------------------------------------------------- provisional UI kit (step 4 replaces it)

export { COMPOUND, gap, lapTime, raceClock, shortTeam, teamColor, textOn, TRACK_STATUS } from "../lib/format";
export { drsEligible, drsOpen } from "../engine/raceState";
/** Track coordinates to canvas px: rotated to the circuit's usual orientation and fitted with padding. */
export { makeTrackTransform as trackTransform, trackAspect, type TrackTransform } from "../lib/trackTransform";
export { TyreBadge } from "./provisional/TyreBadge";
