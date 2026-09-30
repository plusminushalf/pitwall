// block-kit: the public API for blocks (docs/modular-hypotheses.md, want 3). Blocks import only
// this ("block-kit") and React; everything else in src/blockkit/ is the core's side.
//
// Blocks are drawn at a fixed type size in CSS px: a wider block gets more room, not bigger contents.
//
// Every hook returns data up to the current replay time only (spoiler-free), except useWholeSession().
// React hooks update at most 10 times a second and only when their own data changed; useFrame draws
// every animation frame. Off-screen blocks pause.
//
// Hooks that return an object or a collection take an optional last `select` argument: the block gets
// select(value) and re-renders only when that result changes (compared structurally), e.g.
// useDriver(n, d => d.position) or useFeed(f => f.length). Selectors see the same spoiler-free value.
//
//   defineBlock(def)             id, name, version, height, width, sessions, settings, Component
//     height                     px (fixed: what the contents take at the fixed type size), or a function
//                                of HeightInput (session info, selection, the block's settings; never
//                                live data); { min } to stretch: the last stretching block in each grid
//                                column fills it to the bottom of the screen
//     width                      { min, default, max } in percent of the grid's width, snapped to columns
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
//     useBlockSize()             { width, height } in CSS px, and the display's pixelRatio
//   Media
//     useRadio(select?)          playing, unavailable, play(url), stop()
//   Opt-out
//     useWholeSession(select?)   the whole session, future included
//
//   API gaps found rebuilding today's screen (step 2), marked "API gap" where they're defined:
//     useBlockSize().pixelRatio  device px per CSS px, for sharp canvases (redraw when it changes)
//     usePositions()             every car's position at once (map labels)
//     useBestSectors()           fastest sector times by anyone so far
//     useFeed() entries          `id` (stable key, kept across live rebuilds) and `postRace`
//     useFeed() entries          `inferred`: cars that caused a sector yellow, inferred from telemetry
//     useRadio()                 team radio played by the core, one clip at a time app-wide
//
//   Provisional UI kit (until the shared UI kit, step 4): format helpers, colours, the track
//   projection, and TyreBadge, lifted as they are from the core.

export { defineBlock } from "./defineBlock";
export type { BlockDefinition, BlockSettings, DriverSetting, HeightInput, Px, SettingValue } from "./defineBlock";

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
export { makeTrackTransform as trackTransform, type TrackTransform } from "../lib/trackTransform";
export { TyreBadge } from "./provisional/TyreBadge";
