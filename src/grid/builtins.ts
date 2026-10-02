// The blocks that ship with the app (compiled in: trust phase P1, H3.13).

import type { BlockDefinition } from "../blockkit/defineBlock";
import battles from "../blocks/battles";
import driverHeader from "../blocks/driver-header";
import gapChart from "../blocks/gap-chart";
import lapTimes from "../blocks/lap-times";
import longRuns from "../blocks/long-runs";
import pitStrategy from "../blocks/pit-strategy";
import raceFeed from "../blocks/race-feed";
import sectors from "../blocks/sectors";
import speedGear from "../blocks/speed-gear";
import speedTrace from "../blocks/speed-trace";
import stintPace from "../blocks/stint-pace";
import throttleBrakeRpm from "../blocks/throttle-brake-rpm";
import timingTower from "../blocks/timing-tower";
import trackMap from "../blocks/track-map";
import tyreStrip from "../blocks/tyre-strip";
import weather from "../blocks/weather";

const ALL: BlockDefinition<any>[] = [timingTower, trackMap, driverHeader, speedGear, throttleBrakeRpm, speedTrace, lapTimes, sectors, tyreStrip, raceFeed, weather, gapChart, stintPace, pitStrategy, battles, longRuns];

export const BUILTIN_BLOCKS: ReadonlyMap<string, BlockDefinition> = new Map(ALL.map((b) => [b.id, b as BlockDefinition]));
