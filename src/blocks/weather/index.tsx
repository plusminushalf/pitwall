import { defineBlock, Icon, Stat, useWeather } from "block-kit";

/** Air and track temperature, humidity and wind at the circuit now. */
function Weather() {
  const w = useWeather();
  if (!w) return <div className="flex h-full items-center justify-center text-xs text-zinc-400">No weather data</div>;
  const items: [string, string, string?][] = [
    ["Air", `${w.airTemp.toFixed(1)}°`],
    ["Track", `${w.trackTemp.toFixed(1)}°`],
    ["Hum", `${Math.round(w.humidity)}%`],
    ["Wind", `${w.windSpeed.toFixed(1)} m/s`, `Wind ${w.windSpeed.toFixed(1)} m/s from ${Math.round(w.windDirection)}°`],
  ];
  return (
    <div className="relative grid h-full grid-cols-2 content-center gap-x-3 gap-y-1.5 px-3">
      {items.map(([label, value, title]) => (
        <Stat key={label} label={label} title={title} className="leading-tight">
          <span className="text-xs tabular-nums text-zinc-200">{value}</span>
        </Stat>
      ))}
      {w.rainfall > 0 && (
        <span className="absolute right-1.5 top-1.5 flex items-center gap-1 rounded bg-sky-500/20 px-1 text-[11px] font-semibold text-sky-300" title="Rainfall reported">
          <Icon name="rain" size={11} />
          Rain
        </span>
      )}
    </div>
  );
}

export default defineBlock({
  id: "weather",
  name: "Weather",
  description: "Air and track temperature, humidity and wind at the circuit.",
  version: "1.0.0",
  height: 72,
  width: { min: 8, default: 10, max: 25 },
  sessions: ["race"],
  settings: {},
  Component: Weather,
});
