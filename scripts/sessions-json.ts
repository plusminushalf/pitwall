// A season's sessions as JSON, for the in-app race downloader (devserver/ingestPlugin.ts).
//
//   bun scripts/sessions-json.ts <year>
//
// Prints { tier, sessions } to stdout: every session of the year (all types; the caller filters) with
// its meeting name. Two OpenF1 requests, rate-limited and authenticated by openf1.ts.

import { credentials, fetchEndpoint, type RawMeeting, type RawSession } from "./openf1";

const year = Number(process.argv[2]);
if (!Number.isInteger(year)) {
  console.error("usage: bun scripts/sessions-json.ts <year>");
  process.exit(1);
}

// Sequential: openf1.ts spaces out requests one after another, not concurrent ones.
const sessions = await fetchEndpoint<RawSession>("sessions", { year });
const meetings = await fetchEndpoint<RawMeeting>("meetings", { year });
const meetingNames = new Map(meetings.map((m) => [m.meeting_key, m.meeting_name]));

const out = {
  tier: credentials() ? "sponsor" : "free",
  sessions: sessions.map((s) => ({
    session_key: s.session_key,
    session_name: s.session_name,
    session_type: s.session_type,
    meeting_key: s.meeting_key,
    meeting_name: meetingNames.get(s.meeting_key) ?? `${s.country_name} ${s.year}`,
    date_start: s.date_start,
    date_end: s.date_end,
    circuit_short_name: s.circuit_short_name,
    country_name: s.country_name,
    location: s.location,
    is_cancelled: s.is_cancelled ?? false,
  })),
};
process.stdout.write(JSON.stringify(out) + "\n");
