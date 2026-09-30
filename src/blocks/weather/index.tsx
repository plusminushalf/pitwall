import { defineBlock, useWeather } from "block-kit";

const LABEL = "text-[10px] font-semibold uppercase tracking-wider text-zinc-500";

/** Air and track temperature, humidity and wind at the circuit now. */
function Weather() {
  const w = useWeather();
  if (!w) return <div className="flex h-full items-center justify-center text-xs text-zinc-600">No weather data</div>;
  const items: [string, string, string?][] = [
    ["Air", `${w.airTemp.toFixed(1)}°`],
    ["Track", `${w.trackTemp.toFixed(1)}°`],
    ["Hum", `${Math.round(w.humidity)}%`],
    ["Wind", `${w.windSpeed.toFixed(1)} m/s`, `Wind ${w.windSpeed.toFixed(1)} m/s from ${Math.round(w.windDirection)}°`],
  ];
  return (
    <div className="relative grid h-full grid-cols-2 content-center gap-x-3 gap-y-1.5 px-3">
      {items.map(([label, value, title]) => (
        <span key={label} className="flex flex-col leading-tight" title={title}>
          <span className={LABEL}>{label}</span>
          <span className="text-xs tabular-nums text-zinc-200">{value}</span>
        </span>
      ))}
      {w.rainfall > 0 && (
        <span className="absolute right-1.5 top-1.5 rounded bg-sky-500/20 px-1 text-[10px] font-semibold text-sky-300" title="Rainfall reported">
          🌧 Rain
        </span>
      )}
    </div>
  );
}

export default defineBlock({
  id: "weather",
  name: "Weather",
  version: "1.0.0",
  shape: 2,
  width: { min: 1, default: 1, max: 2 },
  sessions: ["race"],
  settings: {},
  Component: Weather,
});
