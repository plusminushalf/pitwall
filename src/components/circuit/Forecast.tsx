// The weather forecast for a weekend still to come (../../forecast): on its circuit's page, a row per session left
// (practice too); on Home's header, a word on the next session's.

import { useMemo, type ReactNode } from "react";
import type { RawSession } from "../../../scripts/lib/openf1Types";
import { compass, FORECAST_HORIZON_MS, sessionForecast, skyText, wetSky, type SessionForecast } from "../../forecast/forecast";
import { useForecast } from "../../forecast/useForecast";
import { FOCUS, LABEL } from "../controls";
import { clockTime, day, sessionTime, shortGp } from "../home/common";

/** Rain likely enough to change a weekend: the chance at which a strategist starts watching the radar. */
const WET_CHANCE = 40;

const wet = (f: SessionForecast) => (f.rainChance ?? 0) >= WET_CHANCE || wetSky(f.code);

const temps = (f: SessionForecast) => (Math.round(f.tempMin) === Math.round(f.tempMax) ? `${Math.round(f.tempMax)}°` : `${Math.round(f.tempMin)}–${Math.round(f.tempMax)}°`);

/** "40% · 1.2 mm", "5%". */
function rainText(f: SessionForecast) {
  const chance = f.rainChance != null ? `${Math.round(f.rainChance)}%` : "—";
  return f.rain >= 0.1 ? `${chance} · ${f.rain.toFixed(1)} mm` : chance;
}

/** The session's start, if the forecast reaches it yet: when it will. */
const reachedFrom = (start: number) => day(new Date(start - FORECAST_HORIZON_MS).toISOString());

function Credit({ fetchedAt }: { fetchedAt?: number }) {
  return (
    <p data-shot-credit="Forecast: Open-Meteo (CC BY 4.0)" className="mt-3 px-3 text-xs text-zinc-400">
      Forecast from{" "}
      <a href="https://open-meteo.com" target="_blank" rel="noreferrer" className={`rounded-sm text-zinc-300 underline decoration-zinc-600 underline-offset-2 hover:text-zinc-100 ${FOCUS}`}>
        Open-Meteo
      </a>{" "}
      (
      <a
        href="https://creativecommons.org/licenses/by/4.0/"
        target="_blank"
        rel="noreferrer"
        className={`rounded-sm underline decoration-zinc-600 underline-offset-2 hover:text-zinc-200 ${FOCUS}`}
      >
        CC BY 4.0
      </a>
      ){fetchedAt != null && <>, fetched {clockTime(fetchedAt)}</>}. Air temperature at the circuit: nobody forecasts the track's. Rain is the likeliest hour's chance and
      the total over the session.
    </p>
  );
}

/**
 * The weekend's sessions still to finish at a circuit, each with its forecast; nothing once the weekend is over. A
 * weekend further out than the forecast reaches says when it will.
 */
export function WeekendForecast({ sessions, meetingName, circuitKey, now }: { sessions: RawSession[]; meetingName: string; circuitKey: number | null; now: number }) {
  const left = useMemo(() => sessions.filter((s) => !s.is_cancelled && Date.parse(s.date_end) > now).sort((a, b) => a.date_start.localeCompare(b.date_start)), [sessions, now]);
  const first = left[0] ? Date.parse(left[0].date_start) : null;
  const reached = first != null && first - now < FORECAST_HORIZON_MS;
  const state = useForecast(circuitKey, !reached);
  if (first == null || !state) return null;

  let body;
  if (!reached) body = <p className="border-y border-zinc-800 px-3 py-4 text-sm text-zinc-400">The forecast reaches this weekend on {reachedFrom(first)}.</p>;
  else if (state.status === "error") body = <p className="border-y border-zinc-800 px-3 py-4 text-sm text-zinc-400">Couldn't load the forecast from Open-Meteo.</p>;
  else {
    const forecast = state.status === "ready" ? state.forecast : null;
    body = (
      <table className="w-full text-left text-sm">
        <thead>
          <tr className={`${LABEL} border-y border-zinc-800`}>
            <th className="px-3 py-2 font-[inherit]">Session</th>
            <th className="hidden px-3 py-2 font-[inherit] sm:table-cell">Starts</th>
            <th className="px-3 py-2 font-[inherit]">Sky</th>
            <th className="px-3 py-2 font-[inherit]" title="The likeliest hour's chance of rain, and the rain forecast over the session">
              Rain
            </th>
            <th className="px-3 py-2 font-[inherit]">Air</th>
            <th className="hidden px-3 py-2 font-[inherit] md:table-cell" title="The strongest wind, and where it comes from">
              Wind
            </th>
          </tr>
        </thead>
        <tbody>
          {left.map((s) => {
            const start = Date.parse(s.date_start);
            const f = forecast && sessionForecast(forecast, start, Date.parse(s.date_end));
            const cell = (content: ReactNode, className = "") => <td className={`px-3 py-2 ${className}`}>{content}</td>;
            const pending = forecast ? `From ${reachedFrom(start)}` : "…";
            return (
              <tr key={s.session_key} className="border-b border-zinc-800/70">
                <td className="px-3 py-2">
                  <span className="font-semibold text-zinc-50">{s.session_name}</span>
                  <span className="block text-xs tabular-nums text-zinc-400 sm:hidden">{sessionTime(s.date_start)}</span>
                </td>
                {cell(sessionTime(s.date_start), "hidden tabular-nums text-zinc-300 sm:table-cell")}
                {f ? (
                  <>
                    {cell(skyText(f.code), wetSky(f.code) ? "text-sky-300" : "text-zinc-200")}
                    {cell(rainText(f), `tabular-nums ${wet(f) ? "font-semibold text-sky-300" : "text-zinc-300"}`)}
                    {cell(temps(f), "tabular-nums text-zinc-200")}
                    {cell(`${f.wind.toFixed(1)} m/s ${compass(f.windFrom)}`, "hidden tabular-nums text-zinc-300 md:table-cell")}
                  </>
                ) : (
                  <td colSpan={4} className="px-3 py-2 text-zinc-400">
                    {pending}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    );
  }

  return (
    <section data-shot="" aria-labelledby="forecast-title" className="mt-8">
      <h2 id="forecast-title" className={`${LABEL} mb-2 px-3`}>
        Forecast · {shortGp(meetingName)}
      </h2>
      {body}
      {reached && <Credit fetchedAt={state.status === "ready" ? state.forecast.fetchedAt : undefined} />}
    </section>
  );
}

/** Home's header: the next session's chance of rain and air temperature, once the forecast reaches it. */
export function ForecastBrief({ circuitKey, start, end, now }: { circuitKey: number | null; start: number; end: number; now: number }) {
  const state = useForecast(circuitKey, start - now >= FORECAST_HORIZON_MS);
  const f = state?.status === "ready" ? sessionForecast(state.forecast, start, end) : null;
  if (!f) return null;
  return (
    <span className={wet(f) ? "text-sky-300" : "text-zinc-400"} title={`Forecast: ${skyText(f.code)}, ${rainText(f)} rain, ${temps(f)} air (Open-Meteo)`}>
      {" "}
      · {f.rainChance != null ? `${Math.round(f.rainChance)}% rain` : skyText(f.code)} · {temps(f)}
    </span>
  );
}
