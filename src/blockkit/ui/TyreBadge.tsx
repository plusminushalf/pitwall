import { COMPOUND } from "../../lib/format";

/** Compound circle with the tyre age next to it. */
export function TyreBadge({ compound, age, size = 18 }: { compound: string | null; age?: number | null; size?: number }) {
  const c = COMPOUND[compound ?? "UNKNOWN"] ?? COMPOUND.UNKNOWN;
  return (
    <span className="inline-flex items-center gap-1" title={compound ? `${compound.toLowerCase()}${age != null ? `, ${age} laps old` : ""}` : "unknown tyre"}>
      <span
        className="inline-flex items-center justify-center rounded-full border-2 bg-zinc-950 font-bold leading-none"
        style={{ borderColor: c.color, color: c.color, width: size, height: size, fontSize: size * 0.5 }}
      >
        {c.letter}
      </span>
      {age != null && <span className="w-4 text-right text-xs tabular-nums text-zinc-400">{age}</span>}
    </span>
  );
}
