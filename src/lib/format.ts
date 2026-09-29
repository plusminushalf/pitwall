import type { TrackStatus } from "../types";

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** 104.916 -> "1:44.916" */
export function lapTime(seconds: number | null | undefined): string {
  if (seconds == null) return "—";
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return m > 0 ? `${m}:${s.toFixed(3).padStart(6, "0")}` : s.toFixed(3);
}

/** Race clock: 3723000 -> "1:02:03", negative values -> "-4:12". */
export function raceClock(ms: number): string {
  const sign = ms < 0 ? "-" : "";
  const total = Math.floor(Math.abs(ms) / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${sign}${h}:${pad(m)}:${pad(s)}` : `${sign}${m}:${pad(s)}`;
}

export function gap(value: number | string | null): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  return value === 0 ? "" : `+${value.toFixed(3)}`;
}

/** Wall-clock time at the circuit for replay time t. */
export function localTime(t0Iso: string, t: number, gmtOffset: string): string {
  const [h, m] = gmtOffset.replace("-", "").split(":").map(Number);
  const offsetMs = (gmtOffset.startsWith("-") ? -1 : 1) * ((h || 0) * 60 + (m || 0)) * 60_000;
  const d = new Date(Date.parse(t0Iso) + t + offsetMs);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

export const COMPOUND: Record<string, { color: string; letter: string }> = {
  SOFT: { color: "#ef4444", letter: "S" },
  MEDIUM: { color: "#facc15", letter: "M" },
  HARD: { color: "#f4f4f5", letter: "H" },
  INTERMEDIATE: { color: "#22c55e", letter: "I" },
  WET: { color: "#3b82f6", letter: "W" },
  UNKNOWN: { color: "#71717a", letter: "?" },
};

export const TRACK_STATUS: Record<TrackStatus, { label: string; className: string }> = {
  GREEN: { label: "Green flag", className: "bg-emerald-600 text-white" },
  SC: { label: "Safety car", className: "bg-amber-400 text-black" },
  SC_ENDING: { label: "Safety car in this lap", className: "bg-amber-400 text-black" },
  VSC: { label: "Virtual safety car", className: "bg-amber-300 text-black" },
  VSC_ENDING: { label: "VSC ending", className: "bg-amber-300 text-black" },
  RED: { label: "Red flag", className: "bg-red-600 text-white" },
  CHEQUERED: { label: "Chequered flag", className: "bg-white text-black" },
};

export const teamColor = (hex: string) => `#${hex}`;

/** Black or white text, whichever reads better on the given team colour. */
export function textOn(hex: string): string {
  const n = parseInt(hex, 16);
  if (Number.isNaN(n)) return "#fff";
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? "#000" : "#fff";
}

/** Team name for tight spaces: "Red Bull Racing" -> "Red Bull", "Haas F1 Team" -> "Haas". */
export const shortTeam = (team: string) => team.replace(/ F1 Team$/, "").replace(/^Red Bull Racing$/, "Red Bull");
