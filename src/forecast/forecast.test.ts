import { describe, expect, test } from "bun:test";
import { F1DB_CIRCUIT } from "../history/circuits";
import { CIRCUIT_COORDS, compass, forecastUrl, sessionForecast, skyText, type Forecast } from "./forecast";

const HOUR = 60 * 60_000;
const T0 = Date.UTC(2026, 9, 25, 12);

/** Hours from T0, each given as [temp, chance, mm, wind, from, code]. */
const forecast = (hours: [number | null, number | null, number, number, number, number][]): Forecast => ({
  fetchedAt: T0,
  times: hours.map((_, i) => T0 + i * HOUR),
  temperature: hours.map((h) => h[0]),
  rainChance: hours.map((h) => h[1]),
  rain: hours.map((h) => h[2]),
  wind: hours.map((h) => h[3]),
  windFrom: hours.map((h) => h[4]),
  code: hours.map((h) => h[5]),
});

describe("sessionForecast", () => {
  const f = forecast([
    [24, 10, 0, 3, 90, 1], // 12:00
    [26, 30, 0, 5, 180, 2], // 13:00
    [27, 70, 1.5, 8, 225, 61], // 14:00
    [25, 20, 0.2, 4, 270, 3], // 15:00
  ]);

  test("takes the hours a session runs over, from the hour it starts in", () => {
    // A qualifying session 13:00–14:00 is the 13:00 hour only.
    expect(sessionForecast(f, T0 + HOUR, T0 + 2 * HOUR)).toEqual({ code: 2, rainChance: 30, rain: 0, tempMin: 26, tempMax: 26, wind: 5, windFrom: 180 });
    // A race 13:03–15:00 runs over 13:00 and 14:00: the worst sky, the likeliest hour, the windiest hour's direction.
    expect(sessionForecast(f, T0 + HOUR + 3 * 60_000, T0 + 3 * HOUR)).toEqual({ code: 61, rainChance: 70, rain: 1.5, tempMin: 26, tempMax: 27, wind: 8, windFrom: 225 });
  });

  test("is null where the forecast doesn't reach", () => {
    expect(sessionForecast(f, T0 + 10 * HOUR, T0 + 11 * HOUR)).toBeNull();
  });

  test("leaves out a chance of rain the model doesn't give", () => {
    const far = forecast([[18, null, 0, 2, 0, 3]]);
    expect(sessionForecast(far, T0, T0 + HOUR)?.rainChance).toBeNull();
  });
});

test("every circuit with a history has coordinates", () => {
  expect(Object.keys(CIRCUIT_COORDS).sort()).toEqual(Object.keys(F1DB_CIRCUIT).sort());
});

test("asks Open-Meteo for wind in m/s and times in unix seconds", () => {
  const url = new URL(forecastUrl(CIRCUIT_COORDS[9]));
  expect(url.searchParams.get("wind_speed_unit")).toBe("ms");
  expect(url.searchParams.get("timeformat")).toBe("unixtime");
});

test("words", () => {
  expect([0, 2, 3, 45, 53, 63, 65, 80, 82, 95].map(skyText)).toEqual(["Clear", "Partly cloudy", "Overcast", "Fog", "Drizzle", "Rain", "Heavy rain", "Showers", "Heavy showers", "Thunderstorms"]);
  expect([0, 44, 90, 200, 338, -45].map(compass)).toEqual(["N", "NE", "E", "S", "N", "NW"]);
});
