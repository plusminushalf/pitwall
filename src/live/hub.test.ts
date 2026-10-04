// The hub's metas follow timing: one soon after a timing record (records that come together share it), never closer
// than MIN_META_GAP_MS; telemetry alone leaves the ~2 s clock cadence.

import { describe, expect, test } from "bun:test";
import type { RawSession } from "../../scripts/lib/openf1Types";
import { LiveHub, MIN_META_GAP_MS, PROMPT_MS } from "./hub";
import type { LiveMessage } from "./protocol";
import { LiveStore } from "./store";

const start = Date.parse("2026-10-04T08:00:00Z");
const session: RawSession = {
  session_key: 99,
  meeting_key: 9,
  session_name: "Race",
  session_type: "Race",
  date_start: new Date(start).toISOString(),
  date_end: new Date(start + 2 * 3600_000).toISOString(),
  year: 2026,
  circuit_short_name: "Test",
  country_name: "Testland",
  location: "Testville",
  gmt_offset: "00:00:00",
} as RawSession;
const at = (s: number) => new Date(start + s * 1000).toISOString();
const driver = { driver_number: 1, name_acronym: "TST", full_name: "Test Driver", broadcast_name: "T DRIVER", team_name: "Team", team_colour: "ff0000", headshot_url: null, session_key: 99 };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A hub with a session on, its snapshot's recompute at least MIN_META_GAP_MS ago. */
async function setup() {
  const sent: LiveMessage[] = [];
  const hub = new LiveHub("simulate", { clients: () => 1, broadcast: (m) => (sent.push(m), 0) }, () => {});
  const store = new LiveStore({ session, meeting: null, circuit: null, t0: start - 600_000, clock: () => start + 60_000 });
  store.ingest("drivers", driver);
  store.ingest("location", { driver_number: 1, date: at(50), x: 1, y: 1, z: 0, session_key: 99 });
  hub.startSession(store);
  await sleep(MIN_META_GAP_MS);
  const metas = () => sent.filter((m) => m.type === "meta").length;
  return { hub, store, sent, metas };
}

describe("LiveHub metas follow timing", () => {
  test("a timing record brings a meta within PROMPT_MS; records arriving together share it", async () => {
    const { hub, store, metas } = await setup();
    expect(metas()).toBe(0);
    store.ingest("position", { driver_number: 1, position: 1, date: at(55), session_key: 99 });
    store.ingest("intervals", { driver_number: 1, gap_to_leader: 0, interval: 0, date: at(55), session_key: 99 });
    expect(metas()).toBe(0); // not synchronously: the batch is still coming in
    await sleep(PROMPT_MS + 60);
    expect(metas()).toBe(1);
    hub.stop();
  });

  test("a second record right after waits for MIN_META_GAP_MS since the last meta", async () => {
    const { hub, store, metas } = await setup();
    store.ingest("position", { driver_number: 1, position: 1, date: at(55), session_key: 99 });
    await sleep(PROMPT_MS + 60);
    expect(metas()).toBe(1);
    store.ingest("position", { driver_number: 1, position: 2, date: at(56), session_key: 99 });
    await sleep(PROMPT_MS + 20);
    expect(metas()).toBe(1); // too soon after the last one
    await sleep(MIN_META_GAP_MS);
    expect(metas()).toBe(2);
    hub.stop();
  });

  test("telemetry alone doesn't prompt a meta; the session's end stops listening", async () => {
    const { hub, store, metas } = await setup();
    store.ingest("location", { driver_number: 1, date: at(56), x: 2, y: 2, z: 0, session_key: 99 });
    await sleep(PROMPT_MS + 60);
    expect(metas()).toBe(0);
    hub.endSession();
    const after = metas(); // the end's own flush
    store.ingest("position", { driver_number: 1, position: 1, date: at(57), session_key: 99 });
    await sleep(PROMPT_MS + 60);
    expect(metas()).toBe(after);
    hub.stop();
  });
});
