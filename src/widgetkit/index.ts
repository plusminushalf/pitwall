// widget-kit: the public API for widgets (docs/hypotheses.md, want 3). Widgets import only
// this ("widget-kit") and React; everything else in src/widgetkit/ is the core's side.
//
// Widgets are drawn at a fixed type size in CSS px: a wider widget gets more room, not bigger contents.
//
// Every hook returns data up to the current replay time only (spoiler-free), except useWholeSession().
// React hooks update at most 10 times a second and only when their own data changed; useFrame draws
// every animation frame. Off-screen widgets pause.
//
// Hooks that return an object or a collection take an optional last `select` argument: the widget gets
// select(value) and re-renders only when that result changes (compared structurally), e.g.
// useDriver(n, d => d.position) or useFeed(f => f.length). Selectors see the same spoiler-free value.
//
//   defineWidget(def)             id, name, group, version, height, width, sessions, settings, Component
//     group                      the picker tab: "session", "driver", "telemetry" or "analysis"
//     height                     px (fixed: what the contents take at the fixed type size), or a function
//                                of HeightInput (session info, selection, the widget's settings; never
//                                live data); { min } to stretch: the last stretching widget in each grid
//                                column fills it to the bottom of the screen
//     width                      { min, default, max } in percent of the grid's width, snapped to columns
//
//   Time and playback
//     useTime(select?)           replay time, 10 Hz
//     useFrame(draw)             draw({ t, now, car(n) }) every animation frame, no re-render; now is the
//                                frame's wall-clock time, for animation at any replay speed and while paused
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
//     useLapTrace(n, lap, select?)  one completed lap as a distance-aligned trace, to overlay laps (race laps
//                                are built from the telemetry; see lapDelta and the other compare helpers)
//     useLapGeometry(select?)    lap length, sector boundaries and corners as distances along the lap
//     useStints(n, select?)      stints started so far (the current one open)
//     usePitStops(n, select?)    pit stops finished so far: entry, exit, pit lane and stationary time
//     useFeed(select?)           race feed so far, newest first
//     useBestSectors(select?)    fastest time in each sector by anyone so far
//   The whole field at t (for widgets about every car: one hook, not one per car)
//     useAllLaps(select?)        every car's completed laps, by driver number
//     useAllStints(select?)      every car's stints so far
//     useAllPitStops(select?)    every car's pit stops finished so far
//     useNeutralPeriods(select?) safety car, VSC and red flag periods so far (the top bar's track status)
//   The lap window
//     useLapWindow(totalLaps)    the laps picked on the timeline's zoom rail (the whole race if none), for
//                                charts by lap: the user zooms every lap chart at once
//   Selection
//     useSelection(select?)      selected and focused drivers, with setters
//     useSelectedDriver()        pinned by settings, else focused, else best-placed selected, else leader
//   The widget itself
//     useSettings()              [settings, update]
//     useWidgetSize()             { width, height } in CSS px, and the display's pixelRatio
//     usePhone()                 the app is in its phone layout (narrow viewport, or a short touch screen)
//     useCoarsePointer()         a touch screen with no hover: wording ("tap", not "click") and hover-only
//                                controls shown; sizes come from the widget's width, not from this
//   Media
//     useRadio(select?)          playing, unavailable, play(url), stop()
//   Opt-out
//     useWholeSession(select?)   the whole session, future included
//   Sharing: clicked to share, a widget is mounted again on a share card 480 px wide, as tall as on screen;
//   one with no canvas only as tall as its contents. Mark controls a picture can't use (All / Selected,
//   filters) data-shot-control: they're left off the card.
//
//   API gaps found rebuilding today's screen (step 2), marked "API gap" where they're defined:
//     useWidgetSize().pixelRatio  device px per CSS px, for sharp canvases (redraw when it changes)
//     usePositions()             every car's position at once (map labels)
//     useBestSectors()           fastest sector times by anyone so far
//     useFeed() entries          `id` (stable key, kept across live rebuilds) and `postRace`
//     useFeed() entries          `inferred`: cars that caused a sector yellow, inferred from telemetry
//     useRadio()                 team radio played by the core, one clip at a time app-wide
//     useFrame() frame.now       the frame's wall-clock time (rAF timestamp), for real-time animation
//     usePitStops()              pit stop timing (pit lane and stationary time), not just the stints
//     useFrame() car(n).pit      the car is in the pit lane (map: a smaller, fainter dot); .pitLane: on
//                                useTrack().pitLane's stretch, 2 s more each side (map: cars ride the drawn lane)
//
//   API gaps found building the analysis widgets (gaps, stint pace, pit stops, battles):
//     useAllLaps(), useAllStints(), useAllPitStops()   the whole field in one hook, not a hook per car (widgets
//                                had to remount whenever the driver list changed to keep their hook order)
//     useNeutralPeriods()        SC / VSC / red periods, so widgets stop parsing race control messages
//     useFeed() entries          `passed` on overtakes: the car passed, so widgets stop parsing the text
//
//   UI kit (H3.7, build step 4, started): the pieces widgets share so they look like the app (DESIGN.md).
//     Label, LABEL_CLASS, Stat    the 11 px uppercase label, alone or over a value
//     TAP_CLASS                   a finger-sized hit area for a small inline control, on touch screens only
//     Icon                        the app's icons (16-unit SVG, 1.5 stroke): never Unicode or emoji
//     DriverTag                   a driver's acronym on their team colour
//     TyreBadge                   compound circle and tyre age
//   and, still as they were lifted from the core: format helpers, colours, the track projection and corner labels.

export { defineWidget } from "./defineWidget";
export { useCircuitRaces, type CircuitRaceEntry, type CircuitRaces } from "./circuit";
export { CircuitAxis, CircuitFrame, circuitNotice, CircuitProgress, CircuitYearRows, RetryButton, Skeleton } from "./ui/CircuitStates";
export type { NeutralKind, NeutralLaps, PastDriver, PastFinisher, PastRace, PastStint } from "../history/pastRaces";
export { median, stopsOf, strategies } from "../history/pastRaces";
export type { PastPace, PastPass, PastPit } from "../history/pastRaces";
export type { WidgetDefinition, WidgetGroup, WidgetSettings, DriverSetting, HeightInput, Px, SettingValue } from "./defineWidget";

export {
  useAllLaps,
  useAllPitStops,
  useAllStints,
  useBestSectors,
  useWidgetSize,
  useCar,
  useCarHistory,
  useDriver,
  useDrivers,
  useFastestLap,
  useFeed,
  useFrame,
  useLapGeometry,
  useLapTrace,
  useLapWindow,
  useLaps,
  useLeaderLap,
  useNeutralPeriods,
  usePitStops,
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
export type { LapWindow } from "../engine/lapWindow";
export { isPhone, useCoarsePointer, usePhone } from "../hooks/usePhone";

export type { WidgetSize } from "./context";
export type { LapGeometry } from "../engine/lapTrace";
/** Lap traces (useLapTrace) and what to read off them: values and times at a distance, deltas between laps, mini-sectors. */
export { deltaAt, deltaSeries, distanceAtTime, miniSectors, positionAtDistance, timeAtDistance, topSpeed, valueAtDistance } from "../engine/compare";
export type { Channel, DecodedLap as LapTrace, DeltaSeries, MiniSector } from "../engine/compare";
/** Colours for compared drivers: team colours, told apart when two are alike (a lighter shade and a dashed line). */
export { compareStyles, dashArray, type CompareStyle } from "../lib/compareColors";
export type { DrawFn, Frame } from "./frame";
export type { CarHistory, CarPosition, FeedEntry, NeutralPeriod, SessionInfo, SessionKind, StintView, Track, WholeSession } from "./select";
export type { FeedItem, FeedKind } from "../data/session";
export type { DriverState, DriverStatus, SectorFlag, Telemetry } from "../engine/raceState";
export type { DriverInfo, Lap, PitStop, SessionMeta, Stint, TrackStatus, WeatherSample } from "../types";

// ---------------------------------------------------------------- UI kit

export { COMPOUND, gap, lapTime, raceClock, sectorTime, shortTeam, teamColor, textOn, TRACK_STATUS } from "../lib/format";
export { drsEligible, drsOpen } from "../engine/raceState";
/** Track coordinates to canvas px: rotated to the circuit's usual orientation and fitted with padding. */
export { makeTrackTransform as trackTransform, type TrackTransform } from "../lib/trackTransform";
/** Corner numbers, and names if asked, on a canvas drawn with trackTransform. */
export { drawCornerLabels, type CornerLabelStyle } from "../lib/cornerLabels";
export { DriverTag } from "./ui/DriverTag";
export { Icon, type IconName } from "./ui/Icon";
export { Label, LABEL_CLASS, Stat, TAP_CLASS } from "./ui/Label";
export { TyreBadge } from "./ui/TyreBadge";
