import { describe, expect, test } from "bun:test";
import { DEFAULT_LAYOUTS } from "../grid/defaultLayout";
import { decodeLayout, encodeLayout } from "./layoutCode";

describe("layout codes", () => {
  test("a layout round-trips, in a link-sized code", async () => {
    const layout = { ...DEFAULT_LAYOUTS.race, widgets: { ...DEFAULT_LAYOUTS.race.widgets, weather: { widgetVersion: "1.0.0", x: 0, y: 3, width: 10, settings: {} } } };
    const code = await encodeLayout("race", layout);
    expect(code).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(code.length).toBeLessThan(500);
    const back = await decodeLayout(code);
    expect(back?.kind).toBe("race");
    expect(Object.keys(back!.layout.widgets)).toEqual(Object.keys(layout.widgets));
    expect(back!.layout.widgets["timing-tower"]).toMatchObject({ x: 0, width: 15, settings: { gapMode: "interval" } });
  });

  test("keeps the kind", async () => {
    expect((await decodeLayout(await encodeLayout("practice", DEFAULT_LAYOUTS.practice)))?.kind).toBe("practice");
  });

  test("anything else is null", async () => {
    expect(await decodeLayout("not-a-layout")).toBeNull();
    expect(await decodeLayout("")).toBeNull();
  });
});
