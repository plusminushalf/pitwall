// block-kit: the public API for blocks (docs/modular-hypotheses.md, want 3). Blocks import only
// this ("block-kit") and React; everything else in src/blockkit/ is the core's side.
//
// Every hook returns data up to the current replay time only (spoiler-free), except useWholeSession().
// React hooks update at most 10 times a second and only when their own data changed; useFrame draws
// every animation frame. Off-screen blocks pause.
//
// Hooks that return an object or a collection take an optional last `select` argument: the block gets
// select(value) and re-renders only when that result changes (compared structurally), e.g.
// useDriver(n, d => d.position) or useFeed(f => f.length). Selectors see the same spoiler-free value.
//
//   defineBlock(def)             id, name, version, shape, width, sessions, settings, Component
//
//   Time and playback
//     useTime(select?)           replay time, 10 Hz
//     useFrame(draw)             draw({ t, car(n) }) every animation frame, no re-render
//     usePlayback(select?)       playing, speed, speeds, play, pause, seek, seekToLap, setSpeed
//   Session info (fixed for the session)
//     useDrivers(select?)        names, teams, colours, headshots
//     useTrack(select?)          outline, pit lane, corners, sector marks, marshal sectors
//     useSessionInfo(select?)    circuit, session name, total laps, t0 and UTC offset, lights out
//   The race at t (one hook per thing, H3.2)
//     useLeaderLap(select?)      the leader's lap
//     useTotalLaps(select?)      race distance in laps
//     useTrackStatus(select?)    green, SC, VSC, red, chequered
//     useSectorFlags(select?)    marshal sector -> yellow / double yellow / red
//     useWeather(select?)        latest weather sample
//     useFastestLap(select?)     fastest completed lap so far
//     useRunningOrder(select?)   driver numbers in tower order
//     usePositions(select?)      car -> position
//     useDriver(n, select?)      position, gaps, tyres, lap, status
//     useCar(n, select?)         speed, gear, RPM, throttle, brake, DRS
//     useCarHistory(n, windowMs, select?)  telemetry samples in [t - windowMs, t]
//     useLaps(n, select?)        completed laps
//     useStints(n, select?)      stints started so far (the current one open)
//     useFeed(select?)           race feed so far, newest first
//     useBestSectors(select?)    fastest time in each sector by anyone so far
//   Selection
//     useSelection(select?)      selected and focused drivers, with setters
//     useSelectedDriver()        pinned by settings, else focused, else best-placed selected, else leader
//   The block itself
//     useSettings()              [settings, update]
//     useBlockSize()             { width, height, pixelRatio } in layout px
//     useLayoutPoint()           pointer event -> { x, y } in layout px
//   Media
//     useRadio(select?)          playing, unavailable, play(url), stop()
//   Opt-out
//     useWholeSession(select?)   the whole session, future included
//
//   API gaps found rebuilding today's screen (step 2), marked "API gap" where they're defined:
//     COLUMN_WIDTH               layout px per column, so a shape can come from content in px
//     useBlockSize().pixelRatio  device px per layout px (the grid scales blocks), for canvases
//     usePositions()             every car's position at once (map labels)
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
  useFastestLap,
  useFeed,
  useFrame,
  useLaps,
  useLayoutPoint,
  useLeaderLap,
  usePlayback,
  usePositions,
  useRadio,
  useRunningOrder,
  useSectorFlags,
  useSelectedDriver,
  useSelection,
  useSessionInfo,
  useSettings,
  useStints,
  useTime,
  useTotalLaps,
  useTrack,
  useTrackStatus,
  useWeather,
  useWholeSession,
} from "./hooks";
export type { Playback, Radio, Select, Selection } from "./hooks";

export type { BlockSize } from "./context";
export type { DrawFn, Frame } from "./frame";
export type { CarHistory, CarPosition, FeedEntry, SessionInfo, SessionKind, StintView, Track, WholeSession } from "./select";
export type { FeedItem, FeedKind } from "../data/session";
export type { DriverState, DriverStatus, SectorFlag, Telemetry } from "../engine/raceState";
export type { DriverInfo, Lap, SessionMeta, Stint, TrackStatus, WeatherSample } from "../types";

// ---------------------------------------------------------------- provisional UI kit (step 4 replaces it)

export { COMPOUND, gap, lapTime, raceClock, shortTeam, teamColor, textOn, TRACK_STATUS } from "../lib/format";
export { drsEligible, drsOpen } from "../engine/raceState";
/** Track coordinates to canvas px: rotated to the circuit's usual orientation and fitted with padding. */
export { makeTrackTransform as trackTransform, trackAspect, type TrackTransform } from "../lib/trackTransform";
export { TyreBadge } from "./provisional/TyreBadge";
