import { defineBlock, drsEligible, drsOpen, useCar, useDriver, useSelectedDriver, type DriverSetting } from "block-kit";

function DrsPill({ code }: { code: number | null }) {
  const open = drsOpen(code);
  const eligible = drsEligible(code);
  const cls = open
    ? "border-emerald-500 bg-emerald-500 text-zinc-950"
    : eligible
      ? "border-emerald-500 text-emerald-400"
      : "border-zinc-700 text-zinc-400";
  return (
    <span
      className={`flex h-5 items-center rounded border px-1.5 text-[10px] font-bold tracking-wider ${cls}`}
      title={open ? "DRS open" : eligible ? "DRS eligible (within a second in a DRS zone)" : "DRS off"}
    >
      DRS
    </span>
  );
}

function SpeedGear() {
  const n = useSelectedDriver();
  // What's shown: whole km/h, the gear and the DRS state (not every rpm or throttle change).
  const tel = useCar(n, (c) => ({ speed: Math.round(c.speed), gear: c.gear, drs: c.drs }));
  const out = useDriver(n, (d) => d.status === "OUT");
  return (
    // No right padding: the throttle, brake and RPM bars sit just right of "km/h" (109 px in).
    <div className={`h-full pl-3 pt-2.5 text-sm ${out ? "opacity-40" : ""}`}>
      <div className="flex h-[60px] flex-col justify-center">
        <div className="flex items-baseline gap-1">
          <span className="w-[3ch] text-right text-3xl font-bold leading-none tabular-nums">{tel ? tel.speed : "—"}</span>
          {/* A unit, not a label: no tracking, so the column stays 3 wide at 1440 px. */}
          <span className="text-[10px] font-semibold uppercase text-zinc-400">km/h</span>
        </div>
        <div className="mt-2 flex items-center gap-1.5">
          <span className="flex h-5 items-center gap-1 rounded bg-zinc-800 px-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">Gear</span>
            <span className="w-[1ch] text-center text-xs font-bold tabular-nums">{tel ? (tel.gear === 0 ? "N" : tel.gear) : "–"}</span>
          </span>
          {/* No DRS channel from 2026 on. */}
          {tel?.drs != null && <DrsPill code={tel.drs} />}
        </div>
      </div>
    </div>
  );
}

export default defineBlock({
  id: "speed-gear",
  name: "Speed & gear",
  description: "The driver's speed, gear and DRS.",
  version: "1.0.0",
  // pt-2.5 and a 60 px row: the height of the bars beside it (throttle-brake-rpm).
  height: 70,
  width: { min: 7, default: 7, max: 12 },
  sessions: ["race", "practice"],
  settings: { driver: "follow-selection" as DriverSetting },
  Component: SpeedGear,
});
