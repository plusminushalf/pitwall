// What the lap comparison view (components/quali/) compares, for qualifying and for finished free practice (its
// Fastest laps view): the lap length and sector boundaries, each driver's traced laps for the lap picker, the lap
// compared by default, and in practice the tyre each lap was on (practice comparisons mislead without it).

import { defaultLap, type LapPreset } from "./quali";
import { defaultPracticeLap, practiceClassification, practiceComparable, tracedLaps, tyreOn, type PracticeResult, type Tyre } from "./practice";
import type { SessionMeta } from "../types";

export interface LapOption {
  lap: number;
  duration: number | null;
  /** E.g. "★ best", "deleted", "cool-down". */
  notes: string[];
  /** Practice only. */
  tyre: Tyre | null;
}

/** Laps for the lap picker: per segment (qualifying) or per run on a tyre set (practice). */
export interface LapGroup {
  name: string;
  laps: LapOption[];
}

export interface Preset {
  id: LapPreset;
  label: string;
  title: string;
}

export interface CompareModel {
  kind: "qualifying" | "practice";
  lapLength: number;
  sectorDistances: [number, number];
  /** Laps everyone can switch to at once (qualifying: fastest, or per segment); practice has none. */
  presets: Preset[];
  /** Who's compared when nobody is picked: pole and P2, or the session's two fastest. */
  defaultDrivers: number[];
  defaultLap(driver: number, preset: LapPreset): number | null;
  lapGroups(driver: number): LapGroup[];
  /** Race control's reason, if it deleted the lap time. */
  deleted(driver: number, lap: number): string | null;
  /** Practice: the tyre the lap was on. */
  tyre(driver: number, lap: number): Tyre | null;
  /** Practice: the classification at the flag. */
  classification: PracticeResult[];
}

/** Whether the session's laps can be compared: qualifying, or practice once it's downloaded (with lap traces). */
export const canCompare = (meta: SessionMeta) => meta.quali != null || practiceComparable(meta);

const compoundName = (c: string) => c.charAt(0) + c.slice(1).toLowerCase();

function qualiModel(meta: SessionMeta): CompareModel {
  const q = meta.quali!;
  const duration = (driver: number, lap: number) => meta.laps.find((l) => l.driver === driver && l.lap === lap)?.duration ?? null;
  return {
    kind: "qualifying",
    lapLength: q.lapLength,
    sectorDistances: q.sectorDistances,
    presets: [
      { id: "best", label: "Fastest", title: "Each driver's fastest counting lap of the session" },
      ...q.segments.map((s) => ({ id: s.number, label: s.name, title: `Each driver's best ${s.name} lap (fastest overall if they have none)` })),
    ],
    defaultDrivers: q.results.slice(0, 2).map((r) => r.driver),
    defaultLap: (driver, preset) => defaultLap(meta, driver, preset),
    lapGroups: (driver) => {
      const own = q.laps.filter((l) => l.driver === driver && l.trace);
      return [...q.segments.map((s) => ({ name: s.name, laps: own.filter((l) => l.segment === s.number) })), { name: "Other", laps: own.filter((l) => l.segment == null) }]
        .filter((g) => g.laps.length)
        .map((g) => ({
          name: g.name,
          laps: g.laps.map((l) => ({
            lap: l.lap,
            duration: duration(driver, l.lap),
            notes: [l.best ? "★ best" : "", l.deleted ? "deleted" : "", l.kind === "cool" ? "cool-down" : "", l.afterFlag ? "after flag" : ""].filter(Boolean),
            tyre: null,
          })),
        }));
    },
    deleted: (driver, lap) => q.laps.find((l) => l.driver === driver && l.lap === lap)?.deleted ?? null,
    tyre: () => null,
    classification: [],
  };
}

function practiceModel(meta: SessionMeta): CompareModel {
  const p = meta.practice!;
  const classification = practiceClassification(meta);
  const lapOf = (driver: number, lap: number) => meta.laps.find((l) => l.driver === driver && l.lap === lap) ?? null;
  return {
    kind: "practice",
    lapLength: p.lapLength!,
    sectorDistances: p.sectorDistances!,
    presets: [],
    defaultDrivers: classification.filter((r) => r.best != null).slice(0, 2).map((r) => r.driver),
    defaultLap: (driver) => defaultPracticeLap(meta, driver, classification),
    lapGroups: (driver) => {
      const best = classification.find((r) => r.driver === driver)?.lap ?? null;
      const groups: LapGroup[] = [];
      for (const lap of tracedLaps(meta, driver)) {
        const l = lapOf(driver, lap);
        const tyre = tyreOn(meta, driver, lap);
        // One group per run on a set: the stint the lap is in.
        const stint = meta.stints.filter((s) => s.driver === driver && s.lapStart <= lap).at(-1);
        const name = stint ? `Run ${stint.stint} · ${compoundName(stint.compound)}${stint.ageAtStart == null ? "" : stint.ageAtStart === 0 ? ", new" : `, ${stint.ageAtStart} laps old`}` : "Other";
        let group = groups.at(-1);
        if (group?.name !== name) groups.push((group = { name, laps: [] }));
        group.laps.push({ lap, duration: l?.duration ?? null, notes: [lap === best ? "★ best" : "", l?.deleted ? "deleted" : ""].filter(Boolean), tyre });
      }
      return groups;
    },
    deleted: (driver, lap) => lapOf(driver, lap)?.deleted?.reason ?? null,
    tyre: (driver, lap) => tyreOn(meta, driver, lap),
    classification,
  };
}

const models = new WeakMap<SessionMeta, CompareModel | null>();

/** The comparison of a session's laps (worked out once per meta), or null if they can't be compared. */
export function compareModel(meta: SessionMeta): CompareModel | null {
  let m = models.get(meta);
  if (m === undefined) {
    m = meta.quali ? qualiModel(meta) : practiceComparable(meta) ? practiceModel(meta) : null;
    models.set(meta, m);
  }
  return m;
}
