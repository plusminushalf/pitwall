import { describe, expect, test } from "bun:test";
import type { CatalogRow } from "../../ingest/catalog";
import { circuitCards } from "./circuitCards";

let key = 0;
const row = (circuit: string, meetingName: string, dateStart: string, extra: Partial<CatalogRow> = {}): CatalogRow => ({
  sessionKey: ++key,
  sessionName: "Race",
  sessionType: "Race",
  meetingKey: 0,
  meetingName,
  round: 1,
  year: Number(dateStart.slice(0, 4)),
  dateStart,
  dateEnd: dateStart,
  circuit,
  circuitKey: null,
  country: "",
  cancelled: false,
  ...extra,
});

describe("Home's circuits", () => {
  test("the season's circuits in calendar order, one per circuit, its weekend spanning its sessions", () => {
    const rows = [
      row("Singapore", "Singapore Grand Prix", "2026-10-11T12:00:00Z", { round: 17, circuitKey: 61 }),
      row("Singapore", "Singapore Grand Prix", "2026-10-09T08:30:00Z", { round: 17, sessionName: "Practice 1" }),
      row("Kuala Lumpur", "Bahrain Grand Prix", "2026-10-04T07:00:00Z", { round: 16 }),
    ];
    const { season, earlier } = circuitCards(2026, [{ year: 2026, rows }]);
    expect(season.map((c) => [c.slug, c.meetingName, c.round])).toEqual([
      ["kuala-lumpur", "Bahrain Grand Prix", 16],
      ["singapore", "Singapore Grand Prix", 17],
    ]);
    expect(season[1]).toMatchObject({ dateStart: "2026-10-09T08:30:00Z", dateEnd: "2026-10-11T12:00:00Z", circuitKey: 61 });
    expect(earlier).toEqual([]);
  });

  test("circuits only earlier seasons went to, the latest raced first, from their latest weekend", () => {
    const seasons = [
      { year: 2026, rows: [row("Monza", "Italian Grand Prix", "2026-09-06T13:00:00Z")] },
      { year: 2025, rows: [row("Imola", "Emilia Romagna Grand Prix", "2025-05-18T13:00:00Z"), row("Monza", "Italian Grand Prix", "2025-09-07T13:00:00Z")] },
      { year: 2024, rows: [row("Imola", "Emilia Romagna Grand Prix", "2024-05-19T13:00:00Z"), row("Zhuhai", "Test Grand Prix", "2024-03-01T13:00:00Z")] },
    ];
    const { season, earlier } = circuitCards(2026, seasons);
    expect(season.map((c) => c.slug)).toEqual(["monza"]);
    expect(earlier.map((c) => [c.slug, c.year])).toEqual([
      ["imola", 2025],
      ["zhuhai", 2024],
    ]);
  });

  test("a weekend whose every session was cancelled is marked; one with a session left isn't", () => {
    const rows = [
      row("Sakhir", "Bahrain Grand Prix", "2026-04-10T12:00:00Z", { cancelled: true }),
      row("Sakhir", "Bahrain Grand Prix", "2026-04-12T15:00:00Z", { cancelled: true }),
      row("Jeddah", "Saudi Arabian Grand Prix", "2026-04-17T12:00:00Z", { cancelled: true }),
      row("Jeddah", "Saudi Arabian Grand Prix", "2026-04-19T17:00:00Z"),
    ];
    expect(circuitCards(2026, [{ year: 2026, rows }]).season.map((c) => [c.slug, c.cancelled])).toEqual([
      ["sakhir", true],
      ["jeddah", false],
    ]);
  });
});
