import { expect, test } from "bun:test";
import { FREE_PACE, nextStart, queryString } from "./openf1Http";

test("pace: a burst at the gap, then no more than the per-minute cap in any 60 s", () => {
  const starts: number[] = [];
  let notBefore = 0;
  for (let i = 0; i < 30; i++) {
    const at = nextStart(starts, 0, notBefore, FREE_PACE);
    starts.push(at);
    notBefore = at + FREE_PACE.gapMs;
  }
  // The first 24 come 0.5 s apart; the 25th waits for the first to leave the minute.
  expect(starts.slice(0, 24)).toEqual(Array.from({ length: 24 }, (_, i) => i * 500));
  expect(starts[24]).toBe(60_000);
  for (let i = FREE_PACE.perMinute; i < starts.length; i++) expect(starts[i]! - starts[i - FREE_PACE.perMinute]!).toBeGreaterThanOrEqual(60_000);
});

test("query: comparison suffixes are written the way OpenF1 reads them", () => {
  expect(queryString({ session_key: 11377, "date>=": "2026-09-26T11:00:00.000Z", "date<": "2026-09-26T11:20:00.000Z" })).toBe(
    "session_key=11377&date>=2026-09-26T11%3A00%3A00.000Z&date<2026-09-26T11%3A20%3A00.000Z",
  );
  expect(queryString({ "date>": "2026-01-01" })).toBe("date>2026-01-01");
});
