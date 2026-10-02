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
    for (const url of ["/session/11377?t=3725&drivers=1,63,55&focus=63", "/session/11228?view=laps&t=600&drivers=1,63", "/live?session=11377&t=90&drivers=4", "/live"]) {
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
