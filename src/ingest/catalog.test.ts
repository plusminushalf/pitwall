// The in-browser calendar and the season rules it shares with the CLI (scripts/lib/season.ts).

import { describe, expect, test } from "bun:test";
import type { RawMeeting, RawSession } from "../../scripts/lib/openf1Types";
import { LIVE_WINDOW_MARGIN_MS, liveWindowAt, seasonStatus } from "../../scripts/lib/season";
import {
  buildCatalog,
  catalogFresh,
  CATALOG_TTL_MS,
  HERO_WINDOW_MS,
  heroWeekend,
  isLive,
  liveWindowNow,
  nextSession,
  nextWeekend,
  windowLabel,
  withCurrentRows,
  type CatalogRow,
} from "./catalog";

let nextKey = 1;
function session(meeting: number, name: string, type: string, start: string, hours = 2, extra: Partial<RawSession> = {}): RawSession {
  const end = new Date(Date.parse(start) + hours * 3600_000).toISOString();
  return {
    session_key: nextKey++,
    meeting_key: meeting,
    session_name: name,
    session_type: type,
    date_start: start,
    date_end: end,
    year: 2026,
    circuit_short_name: `C${meeting}`,
    country_name: `Country ${meeting}`,
    location: `L${meeting}`,
    gmt_offset: "00:00:00",
    is_cancelled: false,
    ...extra,
  };
}

const meetings: RawMeeting[] = [
  { meeting_key: 1, meeting_name: "Australian Grand Prix" },
  { meeting_key: 2, meeting_name: "Bahrain Grand Prix" },
  { meeting_key: 3, meeting_name: "Chinese Grand Prix" },
];
const sessions = [
  session(3, "Race", "Race", "2026-03-15T07:00:00Z"),
  session(1, "Practice 1", "Practice", "2026-03-06T01:30:00Z", 1),
  session(1, "Qualifying", "Qualifying", "2026-03-07T05:00:00Z", 1),
  session(1, "Race", "Race", "2026-03-08T04:00:00Z"),
  session(2, "Race", "Race", "2026-03-12T15:00:00Z", 2, { is_cancelled: true }),
  session(3, "Sprint", "Race", "2026-03-14T03:00:00Z", 1),
  session(4, "Day 1", "Practice", "2026-02-11T07:00:00Z", 9),
];

describe("calendar", () => {
  const c = buildCatalog(2026, sessions, meetings, 1000);

  test("races, sprints, qualifying and free practice, by date, with meeting names", () => {
    expect(c.rows.map((r) => `${r.meetingName} · ${r.sessionName}`)).toEqual([
      "Australian Grand Prix · Practice 1",
      "Australian Grand Prix · Qualifying",
      "Australian Grand Prix · Race",
      "Bahrain Grand Prix · Race",
      "Chinese Grand Prix · Sprint",
      "Chinese Grand Prix · Race",
    ]);
    // Pre-season testing (session_type Practice too) is left out of the rows but kept for live windows.
    expect(c.sessions).toHaveLength(7);
  });

  test("a season cached before practice could be replayed gets its practice rows back, without the network", () => {
    const old = { ...c, rows: c.rows.filter((r) => r.sessionType !== "Practice") };
    const back = withCurrentRows(old);
    expect(back.rows).toEqual(c.rows);
    expect(back.rows[0]).toMatchObject({ sessionName: "Practice 1", meetingName: "Australian Grand Prix", round: 1 });
    expect(back.fetchedAt).toBe(old.fetchedAt);
  });

  test("rounds skip cancelled meetings", () => {
    const round = (name: string) => c.rows.find((r) => r.meetingName === name)?.round;
    expect(round("Australian Grand Prix")).toBe(1);
    expect(round("Bahrain Grand Prix")).toBeNull();
    expect(round("Chinese Grand Prix")).toBe(2);
    expect(c.rows.find((r) => r.meetingName === "Bahrain Grand Prix")?.cancelled).toBe(true);
  });

  test("seasons are re-fetched after their TTL", () => {
    const year = new Date().getUTCFullYear();
    const cur = { ...c, year, fetchedAt: Date.now() };
    expect(catalogFresh(cur)).toBe(true);
    expect(catalogFresh({ ...cur, fetchedAt: Date.now() - CATALOG_TTL_MS.current - 1 })).toBe(false);
    const past = { ...c, year: year - 1, fetchedAt: Date.now() - CATALOG_TTL_MS.current - 1 };
    expect(catalogFresh(past)).toBe(true);
  });
});

describe("season rules", () => {
  const [race] = sessions.filter((s) => s.session_name === "Race" && s.meeting_key === 1);
  const cancelled = sessions.find((s) => s.is_cancelled)!;

  test("status like the CLI's", () => {
    const before = Date.parse(race.date_start);
    const after = Date.parse(race.date_end) + 1;
    expect(seasonStatus(race, before, new Set())).toBe("not run yet");
    expect(seasonStatus(race, after, new Set())).toBe("pending");
    expect(seasonStatus(race, after, new Set([race.session_key]))).toBe("ingested");
    expect(seasonStatus(cancelled, after, new Set())).toBe("cancelled");
  });

  test("the free tier's live window: 30 min either side of any session", () => {
    const fp1 = sessions.find((s) => s.session_name === "Practice 1")!;
    const start = Date.parse(fp1.date_start);
    const end = Date.parse(fp1.date_end);
    expect(liveWindowAt(sessions, start - LIVE_WINDOW_MARGIN_MS - 1)).toBeNull();
    expect(liveWindowAt(sessions, start - LIVE_WINDOW_MARGIN_MS)?.session.session_key).toBe(fp1.session_key);
    expect(liveWindowAt(sessions, end + LIVE_WINDOW_MARGIN_MS - 1)?.to).toBe(end + LIVE_WINDOW_MARGIN_MS);
    expect(liveWindowAt(sessions, end + LIVE_WINDOW_MARGIN_MS)).toBeNull();
    // Cancelled sessions don't lock anything.
    expect(liveWindowAt(sessions, Date.parse(cancelled.date_start) + 60_000)).toBeNull();
  });

  test("overlapping windows: the one ending last", () => {
    const c = buildCatalog(2026, sessions, meetings);
    const sprint = sessions.find((s) => s.session_name === "Sprint")!;
    const w = liveWindowNow([c], Date.parse(sprint.date_start));
    expect(w?.session.session_key).toBe(sprint.session_key);
    expect(windowLabel(w!, [c])).toBe("Chinese Grand Prix · Sprint");
  });
});

describe("venue country", () => {
  test("from the circuit, not OpenF1's country_name (the Grand Prix's nation)", () => {
    const moved = session(9, "Race", "Race", "2026-10-04T07:00:00Z", 2, { circuit_key: 12, circuit_short_name: "Kuala Lumpur", country_name: "Bahrain" });
    const home = session(9, "Qualifying", "Qualifying", "2026-10-03T08:00:00Z", 1, { circuit_key: 63, circuit_short_name: "Sakhir", country_name: "Bahrain" });
    const unknown = session(9, "Sprint", "Race", "2026-10-02T08:00:00Z", 1, { circuit_key: 9999, country_name: "Somewhere" });
    const rows = buildCatalog(2026, [moved, home, unknown], []).rows;
    expect(rows.map((r) => r.country)).toEqual(["Somewhere", "Bahrain", "Malaysia"]);
  });

  test("each row keeps OpenF1's circuit key, the circuit's identity across seasons", () => {
    const moved = session(9, "Race", "Race", "2026-10-04T07:00:00Z", 2, { circuit_key: 12, circuit_short_name: "Kuala Lumpur" });
    const none = session(9, "Qualifying", "Qualifying", "2026-10-03T08:00:00Z", 1, { circuit_key: undefined });
    const catalog = buildCatalog(2026, [moved, none], []);
    expect(catalog.rows.map((r) => r.circuitKey)).toEqual([null, 12]);
    // Read back from this browser, worked out again from its sessions.
    expect(withCurrentRows(catalog).rows.map((r) => r.circuitKey)).toEqual([null, 12]);
  });
});

describe("Home's lead weekend", () => {
  const h = 3600_000;
  // Practice Fri 04:30, qualifying Sat 08:00-09:00, race Sun 07:00-09:00; the weekend before ended a week earlier.
  const catalog = buildCatalog(
    2026,
    [
      session(20, "Race", "Race", "2026-09-26T11:00:00Z"),
      session(21, "Practice 1", "Practice", "2026-10-02T04:30:00Z", 1),
      session(21, "Qualifying", "Qualifying", "2026-10-03T08:00:00Z", 1),
      session(21, "Race", "Race", "2026-10-04T07:00:00Z", 2),
      session(22, "Race", "Race", "2026-10-11T12:00:00Z", 2, { is_cancelled: true }),
      session(23, "Race", "Race", "2026-10-25T20:00:00Z", 2),
    ],
    [],
  );
  const { rows } = catalog;
  const practice = Date.parse("2026-10-02T04:30:00Z");
  const quali = Date.parse("2026-10-03T08:00:00Z");
  const race = Date.parse("2026-10-04T07:00:00Z");
  const names = (w: CatalogRow[] | null) => w?.map((r) => `${r.meetingKey} ${r.sessionName}`) ?? null;

  test("outside the window: none (the latest race leads)", () => {
    expect(heroWeekend(catalog, practice - HERO_WINDOW_MS - 1)).toBeNull();
    expect(names(nextWeekend(rows, practice - HERO_WINDOW_MS - 1))).toEqual(["21 Practice 1", "21 Qualifying", "21 Race"]);
  });

  test("from the window's start before the weekend's first session, through its sessions and between them", () => {
    for (const now of [practice - HERO_WINDOW_MS, quali - 2 * h, quali + 30 * 60_000, quali + 2 * h, race + h]) {
      expect(names(heroWeekend(catalog, now))).toEqual(["21 Practice 1", "21 Qualifying", "21 Race"]);
    }
    expect(nextSession(heroWeekend(catalog, practice - h)!, practice - h)?.sessionName).toBe("Practice 1");
    expect(nextSession(heroWeekend(catalog, quali + 2 * h)!, quali + 2 * h)?.sessionName).toBe("Race");
    const q = rows.find((r) => r.sessionName === "Qualifying")!;
    expect(isLive(q, quali + 30 * 60_000)).toBe(true);
    expect(isLive(q, quali + 2 * h)).toBe(false);
  });

  test("ends with the last session; cancelled weekends are skipped", () => {
    expect(heroWeekend(catalog, race + 2 * h)).toBeNull();
    expect(names(nextWeekend(rows, race + 2 * h))).toEqual(["23 Race"]);
    expect(names(heroWeekend(catalog, Date.parse("2026-10-25T20:00:00Z") - 71 * h))).toEqual(["23 Race"]);
    expect(heroWeekend(catalog, Date.parse("2026-10-26T00:00:00Z"))).toBeNull();
  });

  test("the window can be tuned", () => {
    expect(heroWeekend(catalog, practice - 5 * h, 4 * h)).toBeNull();
    expect(heroWeekend(catalog, practice - 3 * h, 4 * h)).not.toBeNull();
    // After practice, the window counts from qualifying.
    expect(heroWeekend(catalog, quali - 5 * h, 4 * h)).toBeNull();
  });
});
