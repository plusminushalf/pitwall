// The in-browser calendar and the season rules it shares with the CLI (scripts/lib/season.ts).

import { describe, expect, test } from "bun:test";
import type { RawMeeting, RawSession } from "../../scripts/lib/openf1Types";
import { LIVE_WINDOW_MARGIN_MS, liveWindowAt, seasonStatus } from "../../scripts/lib/season";
import { buildCatalog, catalogFresh, CATALOG_TTL_MS, liveWindowNow, windowLabel } from "./catalog";

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
];

describe("calendar", () => {
  const c = buildCatalog(2026, sessions, meetings, 1000);

  test("races, sprints and qualifying, by date, with meeting names", () => {
    expect(c.rows.map((r) => `${r.meetingName} · ${r.sessionName}`)).toEqual([
      "Australian Grand Prix · Qualifying",
      "Australian Grand Prix · Race",
      "Bahrain Grand Prix · Race",
      "Chinese Grand Prix · Sprint",
      "Chinese Grand Prix · Race",
    ]);
    // Practice is left out of the rows but kept for live windows.
    expect(c.sessions).toHaveLength(6);
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
