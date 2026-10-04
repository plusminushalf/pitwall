// Lap picks on synthetic lap lists. describe/test/expect are bun test's globals: a widget folder may only import react,
// widget-kit and its own files (bun run lint), so not "bun:test".
import { FOLLOWING, isFollowing, latestCommonLap, pick, resolveLaps, stepLap, toggleLink, type Picks } from "./laps";

const completed = new Map<number, number[]>([
  [14, [1, 2, 3, 4, 5, 6]],
  [41, [1, 2, 3, 4]],
  [99, []],
]);

describe("lap picks", () => {
  test("following the replay shows the lap both cars have finished", () => {
    expect(latestCommonLap([[1, 2, 3], [1, 2]])).toBe(2);
    expect(latestCommonLap([[1, 2], []])).toBeNull();
    expect(latestCommonLap([])).toBeNull();
    expect(resolveLaps([14, 41], completed, FOLLOWING)).toEqual([
      { driver: 14, lap: 4 },
      { driver: 41, lap: 4 },
    ]);
    // A car that hasn't completed a lap yet leaves everyone without one (there's nothing shared to show).
    expect(resolveLaps([14, 99], completed, FOLLOWING).map((c) => c.lap)).toEqual([null, null]);
  });

  test("a pinned shared lap applies to everyone who has run it", () => {
    const p = pick(FOLLOWING, 41, 6);
    expect(p.shared).toBe(6);
    expect(isFollowing(p)).toBe(false);
    expect(resolveLaps([14, 41], completed, p)).toEqual([
      { driver: 14, lap: 6 },
      { driver: 41, lap: null },
    ]);
  });

  test("unlinked, each driver keeps their own lap and defaults to their latest", () => {
    const p: Picks = { linked: false, shared: null, own: { 14: 2 } };
    expect(resolveLaps([14, 41], completed, p)).toEqual([
      { driver: 14, lap: 2 },
      { driver: 41, lap: 4 },
    ]);
    expect(isFollowing(p)).toBe(false);
    expect(isFollowing({ linked: false, shared: null, own: {} })).toBe(true);
    expect(pick(p, 41, 3).own).toEqual({ 14: 2, 41: 3 });
  });

  test("flipping the link keeps what's on the screen", () => {
    const linked = pick(FOLLOWING, 14, 3);
    const choices = resolveLaps([14, 41], completed, linked);
    const unlinked = toggleLink(linked, choices);
    expect(unlinked).toEqual({ linked: false, shared: null, own: { 14: 3, 41: 3 } });
    expect(toggleLink(unlinked, resolveLaps([14, 41], completed, unlinked))).toEqual({ linked: true, shared: 3, own: {} });
  });

  test("stepping moves through the completed laps", () => {
    expect(stepLap([1, 2, 4], 2, 1)).toBe(4);
    expect(stepLap([1, 2, 4], 4, 1)).toBeNull();
    expect(stepLap([1, 2, 4], 4, -1)).toBe(2);
    expect(stepLap([1, 2, 4], 1, -1)).toBeNull();
    expect(stepLap([1, 2, 4], null, 1)).toBe(1);
    expect(stepLap([1, 2, 4], null, -1)).toBe(4);
    expect(stepLap([], null, 1)).toBeNull();
  });
});
