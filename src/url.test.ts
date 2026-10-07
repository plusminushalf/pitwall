import { describe, expect, test } from "bun:test";
import { readUrl, upgradeUrl, urlFor } from "./url";

describe("readUrl", () => {
  test("Home", () => {
    expect(readUrl("/", "")).toEqual({ live: false, session: null, t: undefined, drivers: [], focus: null });
  });

  test("a session, with its moment and drivers", () => {
    expect(readUrl("/session/11377", "?t=3725&drivers=1,63,55&focus=63")).toEqual({
      live: false,
      session: 11377,
      t: 3_725_000,
      drivers: [1, 63, 55],
      focus: 63,
    });
    expect(readUrl("/session/11377/", "").session).toBe(11377);
  });

  test("practice's Fastest laps", () => {
    expect(readUrl("/session/11228", "?view=laps&t=600&drivers=1,63")).toEqual({ live: false, session: 11228, t: 600_000, drivers: [1, 63], focus: null, view: "laps" });
    expect(readUrl("/session/11228", "?view=replay").view).toBeUndefined();
    expect(readUrl("/live", "?view=laps").view).toBeUndefined();
  });

  test("live, following or watching back", () => {
    expect(readUrl("/live", "?drivers=1&focus=1")).toMatchObject({ live: true, session: null, t: undefined, drivers: [1], focus: 1 });
    expect(readUrl("/live", "?session=11377&t=90")).toMatchObject({ live: true, session: 11377, t: 90_000 });
  });

  test("links from before paths", () => {
    expect(readUrl("/", "?session=11377&t=3725&driver=63")).toEqual({ live: false, session: 11377, t: 3_725_000, drivers: [63], focus: 63 });
    expect(readUrl("/", "?live=1").live).toBe(true);
  });

  test("a shared link's set-up", () => {
    expect(readUrl("/session/11730", "?drivers=1,44&zoom=120-560&preset=2&laps=1:14,44:12&mini=50&names=1").compare).toEqual({
      zoom: [120, 560],
      preset: 2,
      laps: { 1: 14, 44: 12 },
      mini: 50,
      names: true,
    });
    expect(readUrl("/session/11731", "?t=60&layout=abc_-9").layout).toBe("abc_-9");
    // What doesn't parse is left out.
    expect(readUrl("/session/11730", "?zoom=560-120&preset=0&laps=1:x&mini=-1&names=yes&layout=a%2Fb")).toEqual({ live: false, session: 11730, t: undefined, drivers: [], focus: null });
    expect(readUrl("/live", "?zoom=1-2&layout=abc").compare).toBeUndefined();
  });

  test("the lap charts' lap window", () => {
    expect(readUrl("/session/11731", "?t=60&range=12-30").range).toEqual([12, 30]);
    // Backwards, from lap 0, or on live mode's path: left out.
    expect(readUrl("/session/11731", "?range=30-12").range).toBeUndefined();
    expect(readUrl("/session/11731", "?range=0-12").range).toBeUndefined();
    expect(readUrl("/live", "?range=12-30").range).toBeUndefined();
  });

  test("the dashboard, on a session or live; an id that can't be one is left out", () => {
    expect(readUrl("/session/11377", "?dash=strategy").dash).toBe("strategy");
    expect(readUrl("/live", "?dash=my-2").dash).toBe("my-2");
    expect(readUrl("/session/11377", "?dash=Strategy").dash).toBeUndefined();
    expect(readUrl("/session/11377", "?dash=").dash).toBeUndefined();
    expect(urlFor({ live: false, session: 11377, t: 60_000, drivers: [1], focus: null, dash: "telemetry" })).toBe("/session/11377?t=60&drivers=1&dash=telemetry");
    expect(urlFor({ live: true, session: null, drivers: [], focus: null, dash: "strategy" })).toBe("/live?dash=strategy");
    expect(upgradeUrl("/session/11377", "?dash=strategy")).toBeNull();
  });

  test("a path the app doesn't have is Home", () => {
    expect(readUrl("/session/abc", "")).toMatchObject({ live: false, session: null });
    expect(readUrl("/races", "")).toMatchObject({ live: false, session: null });
  });
});

describe("urlFor", () => {
  test("each view", () => {
    expect(urlFor({ live: false, session: null, drivers: [1], focus: 1 })).toBe("/");
    expect(urlFor({ live: false, session: 11377, t: 3_725_900, drivers: [1, 63], focus: 63 })).toBe("/session/11377?t=3725&drivers=1,63&focus=63");
    expect(urlFor({ live: false, session: 11377, drivers: [], focus: null })).toBe("/session/11377");
    expect(urlFor({ live: true, session: 11377, drivers: [4], focus: null })).toBe("/live?drivers=4");
    expect(urlFor({ live: true, session: 11377, t: 90_000, drivers: [], focus: null })).toBe("/live?session=11377&t=90");
    expect(urlFor({ live: false, session: 11228, t: 600_000, drivers: [1, 63], focus: null, view: "laps" })).toBe("/session/11228?view=laps&t=600&drivers=1,63");
  });

  test("round-trips through readUrl", () => {
    for (const url of [
      "/session/11377?t=3725&drivers=1,63,55&focus=63",
      "/session/11228?view=laps&t=600&drivers=1,63",
      "/session/11730?drivers=1,44&zoom=120-560&preset=2&laps=1:14,44:12&mini=50&names=1",
      "/session/11731?t=60&layout=abc_-9", "/session/11731?t=60&drivers=1,44&range=12-30", "/live?session=11377&t=90&drivers=4", "/live"]) {
      const [path, search = ""] = url.split("?");
      expect(urlFor(readUrl(path!, search ? `?${search}` : ""))).toBe(url);
    }
  });
});

describe("upgradeUrl", () => {
  test("today's addresses stay as they are", () => {
    expect(upgradeUrl("/", "")).toBeNull();
    expect(upgradeUrl("/", "?vault=debug")).toBeNull();
    expect(upgradeUrl("/session/11377", "?t=3725&drivers=1,63")).toBeNull();
    expect(upgradeUrl("/live", "?session=11377&t=90")).toBeNull();
  });

  test("links from before paths, keeping other parameters", () => {
    expect(upgradeUrl("/", "?session=11377&t=3725&drivers=1,63&focus=63")).toBe("/session/11377?t=3725&drivers=1,63&focus=63");
    expect(upgradeUrl("/", "?session=11377&driver=63")).toBe("/session/11377?drivers=63&focus=63");
    expect(upgradeUrl("/", "?live=1&session=11377&t=90")).toBe("/live?session=11377&t=90");
    expect(upgradeUrl("/", "?session=11377&vault=debug")).toBe("/session/11377?vault=debug");
  });

  test("a path the app doesn't have goes Home", () => {
    expect(upgradeUrl("/races", "")).toBe("/");
    expect(upgradeUrl("/races", "?vault=debug")).toBe("/?vault=debug");
  });
});
