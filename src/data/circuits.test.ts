import { describe, expect, test } from "bun:test";
import type { TrackGeometry } from "../types";
import { cornerLabel, withCircuit } from "./circuits";

const track = (corners: TrackGeometry["corners"], rotation = 0): TrackGeometry => ({
  outline: { x: [0, 10, 0], y: [0, 10, 20], z: [0, 0, 0] },
  pitLane: null,
  sectorMarks: [],
  bounds: { minX: 0, maxX: 10, minY: 0, maxY: 20 },
  referenceLap: { driver: 1, lap: 2, duration: 90 },
  rotation,
  corners,
  marshalSectors: [],
  pitLoss: null,
});
const numbered = (n: number) => Array.from({ length: n }, (_, i) => ({ number: i + 1, x: i, y: i, angle: 0 }));

describe("withCircuit", () => {
  test("a circuit the circuit API doesn't have gets our corners and rotation", () => {
    const sepang = withCircuit(track([]), "Kuala Lumpur");
    expect(sepang.corners.map(cornerLabel)).toEqual(Array.from({ length: 15 }, (_, i) => String(i + 1)));
    expect(sepang.corners[3].name).toBe("Langkawi");
    const madrid = withCircuit(track([]), "Madring");
    expect(madrid.rotation).toBe(270);
    expect(madrid.corners.map(cornerLabel).slice(3, 7)).toEqual(["4", "5", "5A", "6"]);
    expect(madrid.corners.find((c) => c.number === 12)?.name).toBe("La Monumental");
  });

  test("the API's corners stay, named where the layout has the corner count the names are for", () => {
    const api = numbered(11);
    const monza = withCircuit(track(api, 90), "Monza");
    expect(monza.rotation).toBe(90);
    expect(monza.corners.map((c) => c.name)).toEqual([
      "Rettifilo",
      "Rettifilo",
      "Curva Grande",
      "Roggia",
      "Roggia",
      "Lesmo 1",
      "Lesmo 2",
      "Ascari",
      "Ascari",
      "Ascari",
      "Parabolica",
    ]);
    expect(monza.corners.map(({ name: _, ...c }) => c)).toEqual(api);
    // Another layout (say, before a chicane was added): numbers only.
    const changed = track(numbered(12));
    expect(withCircuit(changed, "Monza")).toBe(changed);
    // Unnamed corners keep no name.
    expect(withCircuit(track(numbered(20)), "Baku").corners.filter((c) => c.name).map((c) => c.number)).toEqual([8, 9]);
  });

  test("the same track gives the same object, and so does what it gave", () => {
    const raw = track(numbered(18));
    const named = withCircuit(raw, "Silverstone");
    expect(named).not.toBe(raw);
    expect(withCircuit(raw, "Silverstone")).toBe(named);
    expect(withCircuit(named, "Silverstone")).toBe(named);
    const plain = track(numbered(16));
    expect(withCircuit(plain, "Shanghai")).toBe(plain);
    const unknown = track([]);
    expect(withCircuit(unknown, "Somewhere new")).toBe(unknown);
  });
});
