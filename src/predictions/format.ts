// How Called It writes times.


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

/** How long before lights out a call was locked, for the card: "9 hrs", "1 hr", "45 min", "under 1 min". */
export function lead(ms: number): string {
  const min = Math.floor(ms / 60_000);
  const hrs = Math.floor(min / 60);
  if (hrs >= 1) return `${hrs} ${hrs === 1 ? "hr" : "hrs"}`;
  return min >= 1 ? `${min} min` : "under 1 min";
}

export const localTz = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
