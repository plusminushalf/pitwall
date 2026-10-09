// Which screen a finished session shows: its replay or its laps compared (store.ts's comparing and friends).

import { describe, expect, test } from "bun:test";
import type { Session } from "./data/session";
import { comparing, firstScreen, hasScreens, screenInLink } from "./store";
import type { SessionMeta } from "./types";

const quali = { quali: { segments: [] } } as unknown as SessionMeta;
const segments = { segments: [] };
const of = (meta: SessionMeta) => ({ meta }) as Session;

describe("a session's screens", () => {
  test("qualifying opens on its laps compared; it has a replay too once it's timed as live (Qualifying format 3)", () => {
    const timed = { ...quali, qualiLive: segments } as SessionMeta;
    expect(firstScreen(quali)).toBe("laps");
    expect(hasScreens(timed)).toBe(true);
    expect(comparing({ session: of(timed), screen: "laps" })).toBe(true);
    expect(comparing({ session: of(timed), screen: "replay" })).toBe(false);
    expect(screenInLink({ session: of(timed), screen: "replay" })).toBe("replay");
    expect(screenInLink({ session: of(timed), screen: "laps" })).toBeUndefined();
  });

  test("qualifying stored before then has only its laps compared, whatever the screen asked for", () => {
    expect(hasScreens(quali)).toBe(false);
    expect(comparing({ session: of(quali), screen: "replay" })).toBe(true);
    expect(screenInLink({ session: of(quali), screen: "replay" })).toBeUndefined();
  });

  test("live qualifying and races have only the replay", () => {
    const live = { qualiLive: segments } as unknown as SessionMeta;
    expect(firstScreen(live)).toBe("replay");
    expect(hasScreens(live)).toBe(false);
    expect(comparing({ session: of(live), screen: "laps" })).toBe(false);
    expect(comparing({ session: of({} as SessionMeta), screen: "laps" })).toBe(false);
  });
});
