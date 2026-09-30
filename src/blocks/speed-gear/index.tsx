import { defineBlock, drsEligible, drsOpen, useCar, useDriver, useSelectedDriver, type DriverSetting } from "block-kit";

function DrsPill({ code }: { code: number | null }) {
  const open = drsOpen(code);
  const eligible = drsEligible(code);
  const cls = open
    ? "border-emerald-500 bg-emerald-500 text-zinc-950"
    : eligible
      ? "border-emerald-500 text-emerald-400"
      : "border-zinc-700 text-zinc-600";
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
  const tel = useCar(n);
  const out = useDriver(n)?.status === "OUT";
  return (
    <div className={`flex h-full flex-col justify-center px-3 ${out ? "opacity-40" : ""}`}>
      <div className="flex items-baseline gap-1">
        <span className="w-[3ch] text-right text-3xl font-bold leading-none tabular-nums">{tel ? Math.round(tel.speed) : "—"}</span>
        <span className="text-[10px] font-semibold uppercase text-zinc-500">km/h</span>
      </div>
      <div className="mt-2 flex items-center gap-1.5">
        <span className="flex h-5 items-center gap-1 rounded bg-zinc-800 px-1.5">
          <span className="text-[9px] font-semibold uppercase text-zinc-500">Gear</span>
          <span className="w-[1ch] text-center text-xs font-bold tabular-nums">{tel ? (tel.gear === 0 ? "N" : tel.gear) : "–"}</span>
        </span>
        {/* No DRS channel from 2026 on. */}
        {tel?.drs != null && <DrsPill code={tel.drs} />}
      </div>
    </div>
  );
}

export default defineBlock({
  id: "speed-gear",
  name: "Speed & gear",
  version: "1.0.0",
  shape: 2,
  width: { min: 1, default: 1, max: 2 },
  sessions: ["race"],
  settings: { driver: "follow-selection" as DriverSetting },
  Component: SpeedGear,
});
