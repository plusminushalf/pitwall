// The widgets that ship with the app (compiled in: trust phase P1, H3.13).

import type { WidgetDefinition } from "../widgetkit/defineWidget";
import battles from "../widgets/battles";
import driverHeader from "../widgets/driver-header";
import gapChart from "../widgets/gap-chart";
import lapCompare from "../widgets/lap-compare";
import lapTimes from "../widgets/lap-times";
import longRuns from "../widgets/long-runs";
import pitStrategy from "../widgets/pit-strategy";
import safetyCars from "../widgets/safety-cars";
import strategyHistory from "../widgets/strategy-history";
import overtakesHistory from "../widgets/overtakes-history";
import racePace from "../widgets/race-pace";
import pitHistory from "../widgets/pit-history";
import raceFeed from "../widgets/race-feed";
import sectors from "../widgets/sectors";
import speedGear from "../widgets/speed-gear";
import speedTrace from "../widgets/speed-trace";
import stintPace from "../widgets/stint-pace";
import throttleBrakeRpm from "../widgets/throttle-brake-rpm";
import timingTower from "../widgets/timing-tower";
import trackMap from "../widgets/track-map";
import tyreStrip from "../widgets/tyre-strip";
import weather from "../widgets/weather";

const ALL: WidgetDefinition<any>[] = [timingTower, trackMap, driverHeader, speedGear, throttleBrakeRpm, speedTrace, lapTimes, sectors, tyreStrip, raceFeed, weather, gapChart, stintPace, pitStrategy, battles, longRuns, lapCompare, safetyCars, strategyHistory, overtakesHistory, racePace, pitHistory];

export const BUILTIN_WIDGETS: ReadonlyMap<string, WidgetDefinition> = new Map(ALL.map((b) => [b.id, b as WidgetDefinition]));
