// The weather forecast for a session still to come, from Open-Meteo (open-meteo.com): no key, open to browsers (CORS),
// free for non-commercial use with credit (CC BY 4.0). Its "best match" blends the national weather services' models
// (ECMWF, GFS, ICON, Météo-France, JMA and more) by place, and its hourly forecast reaches 16 days ahead. Air
// temperature only: nobody forecasts track temperature.

/**
 * Where each circuit is, by OpenF1's circuit_key, from F1DB's circuits (latitude, longitude). Keyed as F1DB_CIRCUIT
 * (../history/circuits.ts) is: a circuit OpenF1 adds needs a line in both.
 */
export const CIRCUIT_COORDS: Readonly<Record<number, readonly [lat: number, lng: number]>> = {
  2: [52.078611, -1.016944], // Silverstone
  4: [47.582222, 19.251111], // Hungaroring
  6: [44.341111, 11.713333], // Imola
  7: [50.437222, 5.971389], // Spa-Francorchamps
  9: [30.132778, -97.641111], // Austin
  10: [-37.849722, 144.968333], // Melbourne
  12: [2.760556, 101.7375], // Sepang ("Kuala Lumpur")
  14: [-23.701111, -46.697222], // Interlagos
  15: [41.57, 2.261111], // Catalunya
  19: [47.219722, 14.764722], // Spielberg
  22: [43.734722, 7.420556], // Monaco
  23: [45.500578, -73.522461], // Montréal
  39: [45.620556, 9.289444], // Monza
  46: [34.843056, 136.540556], // Suzuka
  49: [31.338889, 121.219722], // Shanghai
  55: [52.388819, 4.540922], // Zandvoort
  61: [1.291531, 103.86385], // Marina Bay
  63: [26.0325, 50.510556], // Sakhir
  65: [19.404197, -99.088747], // Mexico City
  70: [24.467222, 54.603056], // Yas Marina
  144: [40.3725, 49.853333], // Baku
  149: [21.543333, 39.172778], // Jeddah
  150: [25.49, 51.454167], // Lusail
  151: [25.958056, -80.238889], // Miami
  152: [36.175, -115.136389], // Las Vegas
  153: [40.465278, -3.615278], // Madring
};

/** How far ahead Open-Meteo forecasts. */
export const FORECAST_DAYS = 16;
export const FORECAST_HORIZON_MS = FORECAST_DAYS * 24 * 60 * 60_000;

/** Open-Meteo's hourly forecast for a place: one array per variable, an entry per hour (UTC). */
export interface Forecast {
  fetchedAt: number;
  /** The hours, ms since the epoch. */
  times: number[];
  /** °C. */
  temperature: (number | null)[];
  /** Chance of rain in the hour, %. */
  rainChance: (number | null)[];
  /** mm in the hour. */
  rain: (number | null)[];
  /** m/s, as OpenF1's weather is. */
  wind: (number | null)[];
  /** Degrees, where the wind comes from. */
  windFrom: (number | null)[];
  /** WMO weather code. */
  code: (number | null)[];
}

const VARIABLES = ["temperature_2m", "precipitation_probability", "precipitation", "wind_speed_10m", "wind_direction_10m", "weather_code"] as const;

interface OpenMeteoResponse {
  hourly: Record<(typeof VARIABLES)[number], (number | null)[]> & { time: number[] };
}

export function forecastUrl([lat, lng]: readonly [number, number]): string {
  const q = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lng),
    hourly: VARIABLES.join(","),
    wind_speed_unit: "ms",
    timeformat: "unixtime",
    forecast_days: String(FORECAST_DAYS),
  });
  return `https://api.open-meteo.com/v1/forecast?${q}`;
}

export async function fetchForecast(coords: readonly [number, number], signal?: AbortSignal): Promise<Forecast> {
  const res = await fetch(forecastUrl(coords), { signal });
  if (!res.ok) throw new Error(`Open-Meteo answered ${res.status}`);
  const { hourly: h } = (await res.json()) as OpenMeteoResponse;
  return {
    fetchedAt: Date.now(),
    times: h.time.map((s) => s * 1000),
    temperature: h.temperature_2m,
    rainChance: h.precipitation_probability,
    rain: h.precipitation,
    wind: h.wind_speed_10m,
    windFrom: h.wind_direction_10m,
    code: h.weather_code,
  };
}

/** A session's weather: the hours it runs over, from the hour it starts in to the one it ends in. */
export interface SessionForecast {
  /** The likeliest sky over the session (its worst hour's WMO code). */
  code: number;
  /** The highest chance of rain in any of its hours, %; null where the model gives none (some do past a week). */
  rainChance: number | null;
  /** The rain forecast over the session, mm. */
  rain: number;
  tempMin: number;
  tempMax: number;
  /** The strongest wind, m/s, and where it comes from. */
  wind: number;
  windFrom: number;
}

const HOUR = 60 * 60_000;

/** The forecast for a session from `start` to `end` (ms), or null if the forecast doesn't reach it yet. */
export function sessionForecast(f: Forecast, start: number, end: number): SessionForecast | null {
  const from = Math.floor(start / HOUR) * HOUR;
  const hours = f.times.flatMap((t, i) => (t >= from && t < Math.max(end, from + HOUR) && f.temperature[i] != null ? [i] : []));
  if (!hours.length) return null;
  const nums = (xs: (number | null)[]) => hours.flatMap((i) => (xs[i] != null ? [xs[i]!] : []));
  const temps = nums(f.temperature);
  const chances = nums(f.rainChance);
  const windiest = hours.reduce((a, i) => ((f.wind[i] ?? -1) > (f.wind[a] ?? -1) ? i : a), hours[0]);
  return {
    code: Math.max(0, ...nums(f.code)),
    rainChance: chances.length ? Math.max(...chances) : null,
    rain: nums(f.rain).reduce((a, b) => a + b, 0),
    tempMin: Math.min(...temps),
    tempMax: Math.max(...temps),
    wind: f.wind[windiest] ?? 0,
    windFrom: f.windFrom[windiest] ?? 0,
  };
}

/** The WMO weather codes Open-Meteo uses, in words. */
export function skyText(code: number): string {
  if (code === 0) return "Clear";
  if (code <= 2) return "Partly cloudy";
  if (code === 3) return "Overcast";
  if (code <= 48) return "Fog";
  if (code <= 57) return "Drizzle";
  if (code <= 67) return code >= 65 ? "Heavy rain" : "Rain";
  if (code <= 77) return "Snow";
  if (code <= 82) return code >= 81 ? "Heavy showers" : "Showers";
  if (code <= 86) return "Snow showers";
  return "Thunderstorms";
}

/** Whether the sky's code is a wet one (drizzle, rain, showers, storms). */
export const wetSky = (code: number) => (code >= 51 && code <= 67) || (code >= 80 && code <= 82) || code >= 95;

const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
export const compass = (deg: number) => COMPASS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
