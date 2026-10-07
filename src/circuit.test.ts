import { describe, expect, test } from "bun:test";
import { CIRCUIT_SLUG, circuitSlug, rowsAt } from "./circuit";
import type { CatalogRow } from "./ingest/catalog";

const row = (sessionKey: number, circuit: string, dateStart: string, circuitKey: number | null = null): CatalogRow => ({
  sessionKey,
  sessionName: "Race",
  sessionType: "Race",
  meetingKey: sessionKey,
  meetingName: "Grand Prix",
  round: 1,
  year: Number(dateStart.slice(0, 4)),
  dateStart,
  dateEnd: dateStart,
  circuit,
  circuitKey,
  country: "",
  cancelled: false,
});

describe("circuits", () => {
  test("OpenF1's names as slugs the URL accepts", () => {
    for (const [name, slug] of [
      ["Singapore", "singapore"],
      ["Spa-Francorchamps", "spa-francorchamps"],
      ["Yas Marina Circuit", "yas-marina-circuit"],
      ["Kuala Lumpur", "kuala-lumpur"],
      ["São Paulo", "sao-paulo"],
      ["  Monte  Carlo ", "monte-carlo"],
    ]) {
      expect(circuitSlug(name)).toBe(slug);
      expect(CIRCUIT_SLUG.test(slug)).toBe(true);
    }
  });

  test("a circuit's sessions over the seasons, oldest first; other circuits and rows without one left out", () => {
    const y2025 = { rows: [row(3, "Singapore", "2025-10-05"), row(4, "Baku", "2025-09-21")] };
    const y2024 = { rows: [row(1, "Singapore", "2024-09-22", 61), row(2, "", "2024-09-21")] };
    expect(rowsAt("singapore", [y2025, null, y2024, undefined]).map((r) => r.sessionKey)).toEqual([1, 3]);
    expect(rowsAt("nowhere", [y2025, y2024])).toEqual([]);
  });
});
