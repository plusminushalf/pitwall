import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import type { SessionMeta } from "../types";
import { clusterEvents, EVENT_PRIORITY, timelineEvents, type TimelineEvent, type TimelineEventKind } from "./timelineEvents";

const ev = (t: number, kind: TimelineEventKind): TimelineEvent => ({ t, kind, text: kind, driver: null });

describe("clusterEvents", () => {
  // 1000 ms over 100 px: 6 px = 60 ms.
  const events = [ev(0, "yellow"), ev(50, "sc"), ev(200, "retired"), ev(230, "yellow"), ev(300, "yellow")];

  test("merges neighbours closer than the gap and shows the highest-priority kind", () => {
    const clusters = clusterEvents(events, 1_000, 100);
    expect(clusters.map((c) => [c.kind, c.t, c.events.length])).toEqual([
      ["sc", 50, 2],
      ["retired", 200, 2],
      ["yellow", 300, 1],
    ]);
  });

  test("wide markers merge with neighbours they would touch", () => {
    // A 30 px SC label at 50 ms (5 px) reaches 20 px: it absorbs the tick at 150 ms (15 px) but not the one at 300 ms.
    const wide = clusterEvents([ev(50, "sc"), ev(150, "yellow"), ev(300, "yellow")], 1_000, 100, (k) => (k === "sc" ? 30 : 0));
    expect(wide.map((c) => [c.kind, c.events.length])).toEqual([
      ["sc", 2],
      ["yellow", 1],
    ]);
  });

  test("keeps every event apart when the bar is wide enough", () => {
    expect(clusterEvents(events, 1_000, 10_000)).toHaveLength(events.length);
  });

  test("nothing before the bar has a width", () => {
    expect(clusterEvents(events, 1_000, 0)).toEqual([]);
  });
});

const dir = new URL("../../data/sessions/11377/", import.meta.url).pathname;
const available = existsSync(`${dir}meta.json`);

describe.skipIf(!available)("Baku 2026 timeline events", () => {
  const meta: SessionMeta = available ? JSON.parse(readFileSync(`${dir}meta.json`, "utf8")) : (null as unknown as SessionMeta);
  const events = available ? timelineEvents(meta) : [];
  const of = (kind: TimelineEventKind) => events.filter((e) => e.kind === kind);

  test("two safety cars, marked where each period starts", () => {
    expect(of("sc").map((e) => e.t)).toEqual(meta.trackStatus.filter((s) => s.status === "SC").map((s) => s.t));
    expect(of("sc")).toHaveLength(2);
    expect(of("vsc")).toHaveLength(0);
    expect(of("red")).toHaveLength(0);
  });

  test("yellow and double yellow sector flags", () => {
    expect(of("yellow").length).toBeGreaterThan(0);
    expect(of("double-yellow").length).toBeGreaterThan(0);
    expect(of("yellow")[0].text).toBe("Yellow · sector 15");
  });

  test("seven retirements", () => {
    expect(of("retired").map((e) => e.driver).sort((a, b) => a! - b!)).toEqual([1, 10, 14, 18, 23, 43, 77]);
    expect(of("retired")[0].text).toBe("STR retired");
  });

  test("post-race stewards' penalties are left out", () => {
    expect(meta.raceControl.some((m) => m.t > meta.duration && m.message.includes("PENALTY"))).toBe(true);
    expect(of("penalty")).toHaveLength(0);
    expect(events.every((e) => e.t >= 0 && e.t <= meta.duration)).toBe(true);
  });

  test("sorted by time", () => {
    expect(events.every((e, i) => i === 0 || events[i - 1].t <= e.t)).toBe(true);
  });

  test("clusters at 1000 px: every event kept once, highest priority on top, neighbours apart", () => {
    const clusters = clusterEvents(events, meta.duration, 1_000);
    expect(clusters.reduce((n, c) => n + c.events.length, 0)).toBe(events.length);
    for (const c of clusters) expect(c.events.every((e) => EVENT_PRIORITY[e.kind] <= EVENT_PRIORITY[c.kind])).toBe(true);
    const gap = (6 / 1_000) * meta.duration;
    for (let i = 1; i < clusters.length; i++) expect(clusters[i].events[0].t - clusters[i - 1].events.at(-1)!.t).toBeGreaterThanOrEqual(gap);
    // The first safety car absorbs the incident that caused it: #23's retirement and the yellows just before.
    const sc = clusters.find((c) => c.primary === of("sc")[0])!;
    expect(sc.kind).toBe("sc");
    expect(sc.events.some((e) => e.kind === "retired" && e.driver === 23)).toBe(true);
  });
});
