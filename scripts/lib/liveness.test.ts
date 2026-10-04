// Whether a session is still running past its scheduled end (./liveness.ts), from race control and laps.

import { describe, expect, test } from "bun:test";
import { AFTER_FLAG_MS, endBy, evidenceOf, fetchEvidence, MAX_OVERRUN_MS, PROBE_BEFORE_END_MS, QUIET_MS, shouldProbe } from "./liveness";

const MIN = 60_000;
const end = Date.parse("2026-10-04T09:00:00Z"); // scheduled
const iso = (t: number) => new Date(t).toISOString();
const rc = (t: number, flag: string | null = null) => ({ date: iso(t), flag });

describe("endBy", () => {
  test("nothing from OpenF1: the scheduled end", () => {
    expect(endBy(end, evidenceOf([], [], "Race"), end + 10 * MIN)).toBe(end);
  });

  test("a delayed race: laps still starting an hour after the scheduled end keep it live", () => {
    const now = end + 60 * MIN;
    const e = evidenceOf([rc(end - 30 * MIN, "GREEN")], [iso(now - 2 * MIN), iso(now - MIN)], "Race");
    expect(e.lastDataAt).toBe(now - MIN);
    expect(endBy(end, e, now)).toBe(now - MIN + QUIET_MS);
  });

  test("the data dried up: over QUIET_MS after the last of it", () => {
    const now = end + 60 * MIN;
    const e = evidenceOf([], [iso(now - QUIET_MS - MIN)], "Race");
    expect(endBy(end, e, now)).toBeLessThan(now);
  });

  test("the chequered flag ends it a few minutes on, whatever trickles in meanwhile", () => {
    const flag = end + 40 * MIN;
    const e = evidenceOf([rc(flag, "CHEQUERED"), rc(flag + 2 * MIN)], [iso(flag + MIN)], "Race");
    expect(endBy(end, e, flag + 3 * MIN)).toBe(flag + AFTER_FLAG_MS);
  });

  test("qualifying: Q1's flag doesn't end it; the third does", () => {
    const q1 = end + 10 * MIN;
    const laps = [iso(q1 + 20 * MIN)];
    const one = evidenceOf([rc(q1, "CHEQUERED")], laps, "Qualifying");
    expect(one.chequeredAt).toBeNull();
    expect(endBy(end, one, q1 + 21 * MIN)).toBe(q1 + 20 * MIN + QUIET_MS);
    const three = evidenceOf([rc(q1, "CHEQUERED"), rc(q1 + 20 * MIN, "CHEQUERED"), rc(q1 + 40 * MIN, "CHEQUERED")], laps, "Qualifying");
    expect(three.chequeredAt).toBe(q1 + 40 * MIN);
    expect(endBy(end, three, q1 + 42 * MIN)).toBe(q1 + 40 * MIN + AFTER_FLAG_MS);
  });

  test("a red flag keeps it live with no laps at all; a green after it hands over to the data", () => {
    const now = end + 50 * MIN;
    const red = evidenceOf([rc(end - 20 * MIN, "RED")], [], "Race");
    expect(red.redFlag).toBe(true);
    expect(endBy(end, red, now)).toBe(now + QUIET_MS);
    const green = evidenceOf([rc(end - 20 * MIN, "RED"), rc(end - 5 * MIN, "GREEN")], [], "Race");
    expect(green.redFlag).toBe(false);
    expect(endBy(end, green, now)).toBe(end - 5 * MIN + QUIET_MS); // the green itself is the latest data
  });

  test("never past the cap, never before the schedule", () => {
    const now = end + MAX_OVERRUN_MS - MIN;
    expect(endBy(end, evidenceOf([rc(now, "RED")], [], "Race"), now)).toBe(end + MAX_OVERRUN_MS);
    expect(endBy(end, evidenceOf([rc(end - 60 * MIN, "CHEQUERED")], [], "Race"), end - 30 * MIN)).toBe(end);
  });
});

test("shouldProbe: from shortly before the scheduled end to the cap", () => {
  expect(shouldProbe(end, end - PROBE_BEFORE_END_MS - 1)).toBe(false);
  expect(shouldProbe(end, end - PROBE_BEFORE_END_MS)).toBe(true);
  expect(shouldProbe(end, end + MAX_OVERRUN_MS)).toBe(true);
  expect(shouldProbe(end, end + MAX_OVERRUN_MS + 1)).toBe(false);
});

test("fetchEvidence: every race control message, and the laps started lately", async () => {
  const now = end + 30 * MIN;
  const calls: [string, Record<string, string | number>][] = [];
  const fetch = async <T,>(endpoint: string, params: Record<string, string | number>): Promise<T[]> => {
    calls.push([endpoint, params]);
    if (endpoint === "race_control") return [rc(end - 10 * MIN, "GREEN")] as T[];
    return [{ date_start: iso(now - MIN) }, { date_start: null }] as T[];
  };
  const e = await fetchEvidence(11731, "Race", now, fetch);
  expect(e).toEqual({ lastDataAt: now - MIN, chequeredAt: null, redFlag: false });
  expect(calls).toEqual([
    ["race_control", { session_key: 11731 }],
    ["laps", { session_key: 11731, "date_start>": iso(now - 20 * MIN) }],
  ]);
});
