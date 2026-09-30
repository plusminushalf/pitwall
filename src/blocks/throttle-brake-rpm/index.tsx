import { defineBlock, useCar, useDriver, useSelectedDriver, type DriverSetting } from "block-kit";

const LABEL = "text-[10px] font-semibold uppercase tracking-wider text-zinc-500";
const RPM_MAX = 13_000;
const RPM_HIGH = 11_800;

function Bar({ label, pct, color, value, valueClass = "text-zinc-300" }: { label: string; pct: number; color: string; value: string; valueClass?: string }) {
  return (
    <div className="grid grid-cols-[58px_minmax(0,1fr)_40px] items-center gap-2">
      <span className={LABEL}>{label}</span>
      <div className="h-1.5 overflow-hidden rounded-full bg-zinc-800">
        <div
          className="h-full rounded-full transition-[width] duration-100 ease-linear"
          style={{ width: `${Math.min(Math.max(pct, 0), 100)}%`, background: color }}
        />
      </div>
      <span className={`text-right text-xs tabular-nums ${valueClass}`}>{value}</span>
    </div>
  );
}

function ThrottleBrakeRpm() {
  const n = useSelectedDriver();
  // Whole rpm and throttle %, and whether the brake is on: what the bars show.
  const tel = useCar(n, (c) => ({ rpm: Math.round(c.rpm), throttle: Math.round(Math.min(Math.max(c.throttle, 0), 100)), braking: c.brake > 0 }));
  const out = useDriver(n, (d) => d.status === "OUT");
  const rpm = tel?.rpm ?? 0;
  const throttle = tel?.throttle ?? 0;
  const braking = tel?.braking ?? false;
  return (
    // No left padding: made to sit right of speed & gear, whose right side has the gap.
    <div className={`h-full pr-3 pt-2.5 text-sm ${out ? "opacity-40" : ""}`}>
      <div className="flex h-[60px] flex-col justify-center gap-1.5">
        <Bar
          label="RPM"
          pct={(rpm / RPM_MAX) * 100}
          color={rpm >= RPM_HIGH ? "#f59e0b" : "#a1a1aa"}
          value={tel ? rpm.toLocaleString("en-US") : "—"}
        />
        <Bar label="Throttle" pct={throttle} color="#22c55e" value={tel ? `${throttle}%` : "—"} />
        <Bar
          label="Brake"
          pct={braking ? 100 : 0}
          color="#ef4444"
          value={tel ? (braking ? "ON" : "OFF") : "—"}
          valueClass={braking ? "font-semibold text-red-400" : "text-zinc-600"}
        />
      </div>
    </div>
  );
}

export default defineBlock({
  id: "throttle-brake-rpm",
  name: "Throttle, brake & RPM",
  version: "1.0.0",
  // pt-2.5 and three 16 px bars 6 px apart.
  height: 70,
  width: { min: 10, default: 15, max: 30 },
  sessions: ["race"],
  settings: { driver: "follow-selection" as DriverSetting },
  Component: ThrottleBrakeRpm,
});
