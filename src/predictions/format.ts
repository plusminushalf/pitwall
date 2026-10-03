// How Called It writes times, names and hooks.

import { team, type TeamId } from "./model";

/** A short zone name: "BST", "CEST", "EDT" where some English locale has one, else "GMT+8". */
export function zoneName(ms: number, tz: string): string {
  const names = ["en-GB", "en-US", "en-AU", "en-IN"].map(
    (locale) => new Intl.DateTimeFormat(locale, { timeZone: tz, timeZoneName: "short" }).formatToParts(ms).find((p) => p.type === "timeZoneName")?.value ?? "",
  );
  return names.find((n) => n && !/^(GMT|UTC)[+-]/.test(n)) ?? names[0] ?? "UTC";
}

const part = (ms: number, tz: string, opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-GB", { timeZone: tz, ...opts }).format(ms);

/** "Thu 8 Oct 2026", "14:02", "SGT". */
export function stamp(ms: number, tz: string) {
  return {
    date: part(ms, tz, { weekday: "short", day: "numeric", month: "short", year: "numeric" }).replace(",", ""),
    time: part(ms, tz, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }),
    zone: zoneName(ms, tz),
  };
}

/** "11 Oct". */
export const dayMonth = (ms: number, tz: string) => part(ms, tz, { day: "numeric", month: "short" });

/** A span, as roughly as it reads well: "3 days 4 hrs", "5 hrs 12 min", "48 min", "under a minute". */
export function span(ms: number): string {
  const min = Math.floor(ms / 60_000);
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  if (min < 1) return "under a minute";
  if (min < 60) return `${min} min`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `${plural(hrs, "hr", "hrs")}${min % 60 ? ` ${min % 60} min` : ""}`;
  const days = Math.floor(hrs / 24);
  return `${plural(days, "day", "days")}${hrs % 24 ? ` ${plural(hrs % 24, "hr", "hrs")}` : ""}`;
}

/** The same, for the card: "7D 14H", "5H 12M", "48M". */
export function shortSpan(ms: number): string {
  const min = Math.max(1, Math.floor(ms / 60_000));
  const hrs = Math.floor(min / 60);
  const days = Math.floor(hrs / 24);
  if (days) return `${days}D${hrs % 24 ? ` ${hrs % 24}H` : ""}`;
  if (hrs) return `${hrs}H${min % 60 ? ` ${min % 60}M` : ""}`;
  return `${min}M`;
}

export const localTz = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

/** Hooks to tap, about the teams picked so far (in the order picked). */
export function hookIdeas(teams: TeamId[]): string[] {
  const [p1, p2, p3] = teams.map((t) => team(t).name);
  const last = p3 ?? p2 ?? p1;
  const ideas = [
    last && `${last} will pit too late. As always.`,
    p1 && `${p1} will panic first.`,
    p2 && `${p2} reads this race perfectly.`,
    teams.includes("ferrari") ? "Ferrari being Ferrari." : last && `${last} being ${last}.`,
    p1 && `${p1} blinks first. Watch.`,
    "Trust me, I know this team.",
    last && `${last} stays out way too long.`,
    "Box, box. You heard it here first.",
  ];
  const fallback = ["Ferrari will pit too late. As always.", "Mercedes will panic first.", "McLaren reads this race perfectly.", "Trust me, I know this team."];
  return teams.length ? [...new Set(ideas.filter((s): s is string => !!s && [...s].length <= 60))] : fallback;
}
