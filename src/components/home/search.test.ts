import { describe, expect, test } from "bun:test";
import type { CatalogRow } from "../../ingest/catalog";
import { queryWords, searchSessions } from "./search";

let key = 0;
const row = (year: number, round: number, meetingName: string, circuit: string, country: string, sessionName: string, dateStart: string): CatalogRow => ({
  sessionKey: ++key,
  sessionName,
  sessionType: sessionName.includes("Qualifying") || sessionName === "Sprint Shootout" ? "Qualifying" : sessionName.startsWith("Practice") ? "Practice" : "Race",
  meetingKey: year * 100 + round,
  meetingName,
  round,
  year,
  dateStart,
  dateEnd: dateStart,
  circuit,
  country,
  cancelled: false,
});

const rows = [
  row(2024, 16, "Italian Grand Prix", "Monza", "Italy", "Practice 1", "2024-08-30T11:30:00Z"),
  row(2024, 16, "Italian Grand Prix", "Monza", "Italy", "Practice 2", "2024-08-30T15:00:00Z"),
  row(2024, 16, "Italian Grand Prix", "Monza", "Italy", "Practice 3", "2024-08-31T10:30:00Z"),
  row(2024, 16, "Italian Grand Prix", "Monza", "Italy", "Qualifying", "2024-08-31T14:00:00Z"),
  row(2024, 16, "Italian Grand Prix", "Monza", "Italy", "Race", "2024-09-01T13:00:00Z"),
  row(2025, 16, "Italian Grand Prix", "Monza", "Italy", "Race", "2025-09-07T13:00:00Z"),
  row(2023, 13, "Belgian Grand Prix", "Spa-Francorchamps", "Belgium", "Sprint Shootout", "2023-07-29T11:00:00Z"),
  row(2023, 13, "Belgian Grand Prix", "Spa-Francorchamps", "Belgium", "Sprint", "2023-07-29T15:00:00Z"),
  row(2023, 13, "Belgian Grand Prix", "Spa-Francorchamps", "Belgium", "Race", "2023-07-30T13:00:00Z"),
  row(2024, 21, "São Paulo Grand Prix", "Interlagos", "Brazil", "Sprint Qualifying", "2024-11-01T18:30:00Z"),
  row(2024, 21, "São Paulo Grand Prix", "Interlagos", "Brazil", "Qualifying", "2024-11-03T10:30:00Z"),
  row(2026, 17, "Qatar Grand Prix", "Lusail", "Qatar", "Race", "2026-12-31T16:00:00Z"),
];
const now = Date.parse("2026-10-01T00:00:00Z");
const names = (q: string) => searchSessions(q, rows, now).map((r) => `${r.year} ${r.circuit} ${r.sessionName}`);

describe("searchSessions", () => {
  test("circuit, two-digit year and a session word", () => {
    expect(names("monza 24 q")).toEqual(["2024 Monza Qualifying"]);
  });
  test("newest first across years", () => {
    expect(names("monza race")).toEqual(["2025 Monza Race", "2024 Monza Race"]);
  });
  test("country and Grand Prix words", () => {
    expect(names("italian gp 2025")).toEqual(["2025 Monza Race"]);
    expect(names("belgium race")).toEqual(["2023 Spa-Francorchamps Race"]);
  });
  test("sprint qualifying and the 2023 sprint shootout read as one session", () => {
    expect(names("spa sprint quali")).toEqual(["2023 Spa-Francorchamps Sprint Shootout"]);
    expect(names("brazil sq")).toEqual(["2024 Interlagos Sprint Qualifying"]);
    expect(names("spa sprint")).toEqual(["2023 Spa-Francorchamps Sprint"]);
  });
  test("accents fold: sao matches São Paulo", () => {
    expect(names("sao q")).toEqual(["2024 Interlagos Qualifying"]);
  });
  test("a round", () => {
    expect(names("r13 race")).toEqual(["2023 Spa-Francorchamps Race"]);
  });
  test("a single-letter session word doesn't match places (q isn't Qatar)", () => {
    expect(names("q 2026")).toEqual([]);
  });
  test("sessions more than a week away are left out", () => {
    expect(names("qatar")).toEqual([]);
  });
  test("free practice: fp1..fp3, p1..p3, \"practice 2\" and \"free practice 2\", or every practice session", () => {
    expect(names("monza fp2")).toEqual(["2024 Monza Practice 2"]);
    expect(names("monza p3")).toEqual(["2024 Monza Practice 3"]);
    expect(names("monza free practice 1")).toEqual(["2024 Monza Practice 1"]);
    expect(names("practice 2 monza")).toEqual(["2024 Monza Practice 2"]);
    expect(names("monza practice")).toEqual(["2024 Monza Practice 3", "2024 Monza Practice 2", "2024 Monza Practice 1"]);
    expect(queryWords("Free Practice 3 Monza")).toEqual(["fp3", "monza"]);
  });
  test("an empty query finds nothing", () => {
    expect(searchSessions("  gp ", rows, now)).toEqual([]);
    expect(queryWords("Sprint Shootout spa")).toEqual(["sq", "spa"]);
  });
});
