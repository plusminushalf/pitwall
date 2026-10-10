// describe/test/expect are bun test's globals: a widget folder may only import react, widget-kit and its own
// files (bun run lint), so not "bun:test".

import { displayName, gapText, sessionBests, type BestLap, type CarInput } from "./bests";

/** A lap from t = start (s), its sectors adding up to its time (null: untimed). */
function lap(n: number, start: number, sectors: [number, number, number] | null, extra: Partial<BestLap> = {}): BestLap {
  const duration = sectors ? sectors[0] + sectors[1] + sectors[2] : null;
  return {
    lap: n,
    start: start * 1000,
    end: (start + (duration ?? 100)) * 1000,
    duration,
    sectors: sectors ?? [null, null, null],
    speedTrap: { i1: null, i2: null, st: null },
    ...extra,
  };
}

const HAM: CarInput = {
  driver: 44,
  laps: [lap(1, 0, [32.0, 44.0, 30.0], { speedTrap: { i1: null, i2: null, st: 300 } }), lap(2, 106, [31.8, 43.4, 29.9], { speedTrap: { i1: null, i2: null, st: 305 } })],
  stints: [{ lapStart: 1, compound: "INTERMEDIATE", ageAtStart: 0 }],
  pits: [{ lap: 2, entry: 200_000, exit: 222_000, laneDuration: 22.0, stopDuration: 2.4 }],
};
const VER: CarInput = {
  driver: 1,
  laps: [lap(1, 0, [31.7, 44.5, 30.1], { speedTrap: { i1: null, i2: null, st: 312 } }), lap(2, 106.3, [32.0, 43.9, 30.0])],
  stints: [
    { lapStart: 1, compound: "WET", ageAtStart: 2 },
    { lapStart: 2, compound: "INTERMEDIATE", ageAtStart: null },
  ],
  pits: [{ lap: 1, entry: 100_000, exit: 121_000, laneDuration: 21.0, stopDuration: 3.1 }],
};

const ids = (b: ReturnType<typeof sessionBests>) => b.records.map((r) => r.id);

describe("session bests", () => {
  test("each record's best and the next driver behind it", () => {
    const b = sessionBests([HAM, VER], Infinity, true);
    expect(ids(b)).toEqual(["s1", "s2", "s3", "lap", "speed", "stop", "lane"]);
    const by = Object.fromEntries(b.records.map((r) => [r.id, [r.best.driver, r.best.value, r.next?.driver, r.next?.value]]));
    expect(by.s1).toEqual([1, 31.7, 44, 31.8]);
    expect(by.s2).toEqual([44, 43.4, 1, 43.9]);
    expect(by.s3).toEqual([44, 29.9, 1, 30.0]);
    expect(by.lap[0]).toBe(44);
    expect(by.lap[1]).toBeCloseTo(105.1, 9);
    expect(by.speed).toEqual([1, 312, 44, 305]);
    expect(by.stop).toEqual([44, 2.4, 1, 3.1]);
    expect(by.lane).toEqual([1, 21.0, 44, 22.0]);
  });

  test("the lap and tyres a best was set on, and where to watch it", () => {
    const s1 = sessionBests([HAM, VER], Infinity, true).records[0].best;
    expect(s1).toMatchObject({ driver: 1, lap: 1, at: 0, compound: "WET", age: 2 });
    const s2 = sessionBests([HAM, VER], Infinity, true).records[1].best;
    expect(s2).toMatchObject({ driver: 44, lap: 2, at: 106_000, compound: "INTERMEDIATE", age: 1 });
  });

  test("the ideal lap: the fastest sectors added up, and how far under the fastest lap", () => {
    const { ideal } = sessionBests([HAM, VER], Infinity, true);
    expect(ideal!.value).toBeCloseTo(31.7 + 43.4 + 29.9, 9);
    expect(ideal!.drivers).toEqual([1, 44, 44]);
    expect(ideal!.under).toBeCloseTo(0.1, 9);
  });

  test("only what's done by t: laps finished, stops left", () => {
    const b = sessionBests([HAM, VER], 110_000, true);
    expect(ids(b)).toEqual(["s1", "s2", "s3", "lap", "speed"]);
    expect(b.records.every((r) => r.best.lap === 1)).toBe(true);
    expect(sessionBests([HAM, VER], 0, true)).toEqual({ records: [], ideal: null });
  });

  test("no pit stops outside a race", () => {
    expect(ids(sessionBests([HAM, VER], Infinity, false))).toEqual(["s1", "s2", "s3", "lap", "speed"]);
  });

  test("a lap deleted by t isn't the fastest lap (until then it is); its sectors still count", () => {
    const deleted = { ...HAM, laps: HAM.laps.map((l) => (l.lap === 2 ? { ...l, deleted: { t: 300_000, reason: "TRACK LIMITS" } } : l)) };
    expect(sessionBests([deleted, VER], 299_999, true).records.find((r) => r.id === "lap")!.best.driver).toBe(44);
    const after = sessionBests([deleted, VER], 300_000, true);
    expect(after.records.find((r) => r.id === "lap")!.best).toMatchObject({ driver: 1, lap: 2 });
    expect(after.records.find((r) => r.id === "s2")!.best.driver).toBe(44);
  });

  test("a tie goes to whoever set it first; one driver alone has nobody behind", () => {
    const a: CarInput = { driver: 4, laps: [lap(1, 10, [30, 40, 30])], stints: [], pits: [] };
    const b: CarInput = { driver: 81, laps: [lap(1, 0, [30, 40, 30])], stints: [], pits: [] };
    expect(sessionBests([a, b], Infinity, false).records[0].best.driver).toBe(81);
    const alone = sessionBests([a], Infinity, false).records[0];
    expect(alone.next).toBeNull();
    expect(alone.best.compound).toBeNull();
  });
});

describe("text", () => {
  const m = (value: number) => ({ driver: 1, value, lap: 1, at: 0, set: 0, compound: null, age: null });
  test("gaps", () => {
    expect(gapText("s1", m(31.7), m(31.8))).toBe("+0.100");
    expect(gapText("speed", m(312), m(305))).toBe("−7");
    expect(gapText("stop", m(2.4), m(3.1))).toBe("+0.7");
  });
  test("names", () => {
    expect(displayName("Lewis HAMILTON")).toBe("Lewis Hamilton");
    expect(displayName("Andrea Kimi ANTONELLI")).toBe("Andrea Kimi Antonelli");
  });
});
