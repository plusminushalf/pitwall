// The widgets that ship with the app (compiled in: trust phase P1, H3.13).

import type { WidgetDefinition } from "../widgetkit/defineWidget"
import battles from "../widgets/battles"
import driverHeader from "../widgets/driver-header"
import gapChart from "../widgets/gap-chart"
import lapChart from "../widgets/lap-chart"
import lapCompare from "../widgets/lap-compare"
import lapTimes from "../widgets/lap-times"
import liveLaps from "../widgets/live-laps"
import liveTiming from "../widgets/live-timing"
import longRuns from "../widgets/long-runs"
import overtakesHistory from "../widgets/overtakes-history"
import paceOrder from "../widgets/pace-order"
import paceSpread from "../widgets/pace-spread"
import pitCrews from "../widgets/pit-crews"
import pitHistory from "../widgets/pit-history"
import pitStrategy from "../widgets/pit-strategy"
import placesGained from "../widgets/places-gained"
import pushLaps from "../widgets/push-laps"
import raceFeed from "../widgets/race-feed"
import raceOvertakes from "../widgets/race-overtakes"
import racePace from "../widgets/race-pace"
import raceStrategy from "../widgets/race-strategy"
import runPlans from "../widgets/run-plans"
import safetyCars from "../widgets/safety-cars"
import sectorStrengths from "../widgets/sector-strengths"
import sectors from "../widgets/sectors"
import sessionBests from "../widgets/session-bests"
import speedGear from "../widgets/speed-gear"
import speedTrace from "../widgets/speed-trace"
import speedVsPace from "../widgets/speed-vs-pace"
import stintPace from "../widgets/stint-pace"
import strategyHistory from "../widgets/strategy-history"
import throttleBrakeRpm from "../widgets/throttle-brake-rpm"
import timingTower from "../widgets/timing-tower"
import topSpeeds from "../widgets/top-speeds"
import trackEvolution from "../widgets/track-evolution"
import trackLimits from "../widgets/track-limits"
import trackMap from "../widgets/track-map"
import tyreStrip from "../widgets/tyre-strip"
import weather from "../widgets/weather"

const ALL: WidgetDefinition<any>[] = [
    timingTower,
    trackMap,
    driverHeader,
    speedGear,
    throttleBrakeRpm,
    speedTrace,
    lapTimes,
    sectors,
    tyreStrip,
    raceFeed,
    weather,
    gapChart,
    stintPace,
    pitStrategy,
    battles,
    longRuns,
    lapCompare,
    liveLaps,
    liveTiming,
    safetyCars,
    strategyHistory,
    overtakesHistory,
    racePace,
    pitHistory,
    paceOrder,
    paceSpread,
    placesGained,
    raceOvertakes,
    topSpeeds,
    pitCrews,
    lapChart,
    raceStrategy,
    pushLaps,
    sectorStrengths,
    sessionBests,
    speedVsPace,
    runPlans,
    trackEvolution,
    trackLimits
]

export const BUILTIN_WIDGETS: ReadonlyMap<string, WidgetDefinition> = new Map(
    ALL.map((b) => [b.id, b as WidgetDefinition])
)
