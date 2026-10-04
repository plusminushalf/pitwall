// Export one session as spreadsheets and a stats summary, for charts and posts (Datawrapper, Flourish, Sheets...).
//
//   bun run export <session_key> [--trace VER:12 ...]     (find keys with: bun run races <year> --quali --practice)
//
// Ingests the session first if data/sessions/<key>/ doesn't have it (bun run ingest). Writes, to
// data/exports/<key>-<slug>/ (git-ignored like the rest of data/: F1 timing data isn't redistributable):
//   summary.md          headline stats: winner or pole, fastest lap, strategies, team-mates, ideal laps...
//   results.csv         classification (quali: Q1/Q2/Q3 times)
//   laps.csv            every lap: time, sectors, tyre, position and gap (races), track status, speed traps
//   stints.csv, pits.csv, race_control.csv, weather.csv
//   telemetry.csv       each driver's fastest lap over distance (speed, throttle, brake, gear), long format
//   speed_trace.csv     the same fastest laps' speed on a 10 m grid, one column per driver (wide: ready to chart)
// --trace DRV:LAP (repeatable) adds that lap to telemetry.csv and speed_trace.csv as "DRV L12".

import { mkdir } from "node:fs/promises";
import { decodeLapTrace } from "../src/engine/compare";
import type { DriverInfo, DriverLapTraces, DriverTelemetry, Lap, Ms, SessionMeta, TrackStatus } from "../src/types";

const args = process.argv.slice(2);
const extraTraces: string[] = [];
const positional: string[] = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--trace") extraTraces.push(args[++i] ?? "");
  else if (args[i].startsWith("--trace=")) extraTraces.push(args[i].slice("--trace=".length));
  else positional.push(args[i]);
}
const sessionKey = Number(positional[0]);
if (!Number.isInteger(sessionKey)) {
  console.error("usage: bun run export <session_key> [--trace VER:12 ...]   (find keys with: bun run races <year> --quali --practice)");
  process.exit(1);
}

const SESSION_DIR = `data/sessions/${sessionKey}`;
if (!(await Bun.file(`${SESSION_DIR}/meta.json`).exists())) {
  console.log(`${sessionKey} isn't ingested yet: bun run ingest ${sessionKey}\n`);
  const ingest = Bun.spawnSync(["bun", `${import.meta.dir}/ingest.ts`, String(sessionKey)], { stdout: "inherit", stderr: "inherit" });
  if (ingest.exitCode !== 0) process.exit(ingest.exitCode ?? 1);
  console.log();
}
const meta: SessionMeta = await Bun.file(`${SESSION_DIR}/meta.json`).json();
const isRace = !meta.quali && !meta.practice;

const slug = `${meta.year}-${meta.meetingName}-${meta.sessionName}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const OUT_DIR = `data/exports/${sessionKey}-${slug}`;
await mkdir(OUT_DIR, { recursive: true });

// ---------------------------------------------------------------- helpers

const driverInfo = new Map(meta.drivers.map((d) => [d.number, d]));
const info = (n: number): DriverInfo =>
  driverInfo.get(n) ?? { number: n, acronym: `#${n}`, fullName: `#${n}`, broadcastName: `#${n}`, team: "", teamColour: "888888", headshotUrl: null };
const acr = (n: number) => info(n).acronym;
const byAcronym = new Map(meta.drivers.map((d) => [d.acronym, d.number]));

/** 95.13 -> "1:35.130", 5882.143 -> "1:38:02.143". */
function lapTime(s: number | null | undefined): string {
  if (s == null) return "";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = (s % 60).toFixed(3).padStart(6, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : m ? `${m}:${sec}` : (s % 60).toFixed(3);
}
const gap = (s: number) => `+${s.toFixed(3)}`;
const num = (x: number | null | undefined, digits = 3) => (x == null || !Number.isFinite(x) ? "" : String(+x.toFixed(digits)));
/** Session clock: ms since t0 -> "h:mm:ss". */
function clock(t: Ms): string {
  const s = Math.max(0, Math.round(t / 1000));
  return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}
const utc = (t: Ms) => new Date(Date.parse(meta.t0) + t).toISOString();

type Cell = string | number | boolean | null | undefined;
function csv(header: string[], rows: Cell[][]): string {
  const cell = (v: Cell) => {
    const s = v == null ? "" : typeof v === "boolean" ? (v ? "yes" : "") : String(v);
    return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  return [header, ...rows].map((r) => r.map(cell).join(",")).join("\n") + "\n";
}
const written: string[] = [];
async function write(name: string, text: string) {
  await Bun.write(`${OUT_DIR}/${name}`, text);
  written.push(name);
}

// ---------------------------------------------------------------- laps

const lapsOf = new Map<number, Lap[]>();
for (const l of meta.laps) lapsOf.set(l.driver, [...(lapsOf.get(l.driver) ?? []), l]);
for (const ls of lapsOf.values()) ls.sort((a, b) => a.lap - b.lap);

const qualiLap = new Map(meta.quali?.laps.map((q) => [`${q.driver}:${q.lap}`, q]));
const segmentName = (n: number | null) => meta.quali?.segments.find((s) => s.number === n)?.name ?? "";
const deletedReason = (l: Lap) => qualiLap.get(`${l.driver}:${l.lap}`)?.deleted ?? l.deleted?.reason ?? null;
/** A driver's last segment time in qualifying (their classification time), and which segment set it. */
const lastSegment = (times: (number | null)[]) => times.reduce<number>((last, t, i) => (t != null ? i : last), -1);
const lastTime = (times: (number | null)[]) => times[lastSegment(times)] ?? null;
const isValid = (l: Lap) => l.duration != null && deletedReason(l) == null;

const stintOf = (l: Lap) => meta.stints.find((s) => s.driver === l.driver && s.lapStart <= l.lap && l.lap <= s.lapEnd) ?? null;
const pitIn = new Set(meta.pits.map((p) => `${p.driver}:${p.lap}`));

// Races: running order and gap at the end of each lap, from the order the cars completed it.
const lapEnd = new Map<string, { position: number; gap: number }>();
if (isRace) {
  const byLap = new Map<number, Lap[]>();
  for (const l of meta.laps) if (l.end != null) byLap.set(l.lap, [...(byLap.get(l.lap) ?? []), l]);
  for (const ls of byLap.values()) {
    ls.sort((a, b) => a.end! - b.end!);
    ls.forEach((l, i) => lapEnd.set(`${l.driver}:${l.lap}`, { position: i + 1, gap: (l.end! - ls[0].end!) / 1000 }));
  }
}

// Track status: the worst one shown while the lap ran.
const SEVERITY: Record<string, number> = { GREEN: 0, VSC: 1, SC: 2, RED: 3 };
const statusName = (s: TrackStatus) => (s === "SC_ENDING" ? "SC" : s === "VSC_ENDING" ? "VSC" : s);
function lapStatus(l: Lap): string {
  const end = l.end ?? l.start;
  let worst = "GREEN";
  for (const [i, e] of meta.trackStatus.entries()) {
    const next = meta.trackStatus[i + 1];
    // Shown at some point between the lap's start and end.
    if (e.t > end || (next && next.t <= l.start) || e.status === "CHEQUERED") continue;
    const s = statusName(e.status);
    if (SEVERITY[s] > SEVERITY[worst]) worst = s;
  }
  return worst;
}

// Drivers in classification order, then anyone else who set a lap.
const order = [...new Set([...meta.results.map((r) => r.driver), ...meta.drivers.map((d) => d.number)])].filter((n) => lapsOf.has(n) || meta.results.some((r) => r.driver === n));

const lapRows: Cell[][] = [];
for (const n of order) {
  for (const l of lapsOf.get(n) ?? []) {
    const stint = stintOf(l);
    const q = qualiLap.get(`${n}:${l.lap}`);
    const end = lapEnd.get(`${n}:${l.lap}`);
    lapRows.push([
      acr(n),
      info(n).team,
      l.lap,
      num(l.duration),
      lapTime(l.duration),
      num(l.sectors[0]),
      num(l.sectors[1]),
      num(l.sectors[2]),
      stint?.compound ?? "",
      stint?.ageAtStart != null ? stint.ageAtStart + l.lap - stint.lapStart : "",
      stint?.stint ?? "",
      l.pitOut,
      pitIn.has(`${n}:${l.lap}`),
      ...(isRace ? [end?.position ?? "", end ? num(end.gap) : ""] : []),
      ...(meta.quali ? [segmentName(q?.segment ?? null), q?.kind ?? "", q?.best ?? false] : []),
      deletedReason(l) ?? "",
      lapStatus(l),
      l.speedTrap.i1,
      l.speedTrap.i2,
      l.speedTrap.st,
      clock(l.start),
    ]);
  }
}
await write(
  "laps.csv",
  csv(
    [
      "driver",
      "team",
      "lap",
      "lap_time_s",
      "lap_time",
      "s1",
      "s2",
      "s3",
      "compound",
      "tyre_age",
      "stint",
      "pit_out",
      "pit_in",
      ...(isRace ? ["position", "gap_to_leader_s"] : []),
      ...(meta.quali ? ["segment", "kind", "counted"] : []),
      "deleted",
      "track_status",
      "speed_i1",
      "speed_i2",
      "speed_trap",
      "session_clock",
    ],
    lapRows,
  ),
);

// ---------------------------------------------------------------- results

const gridOf = new Map(meta.grid.map((g) => [g.driver, g.position]));
const status = (r: SessionMeta["results"][number]) => (r.dsq ? "DSQ" : r.dns ? "DNS" : r.dnf ? "DNF" : "");
const lapsDone = (n: number) => (lapsOf.get(n) ?? []).filter((l) => l.end != null).length;

if (meta.quali) {
  const segs = meta.quali.segments;
  const pole = (meta.quali.results[0] ? lastTime(meta.quali.results[0].times) : null);
  await write(
    "results.csv",
    csv(
      ["position", "driver", "name", "team", ...segs.map((s) => s.name), "best", "gap_to_pole", "knocked_out_in", "laps"],
      meta.quali.results.map((r) => {
        const best = lastTime(r.times);
        return [
          r.position,
          acr(r.driver),
          info(r.driver).fullName,
          info(r.driver).team,
          ...segs.map((_, i) => lapTime(r.times[i])),
          lapTime(best),
          best != null && pole != null && r.position !== 1 && r.eliminated == null ? gap(best - pole) : "",
          r.eliminated ? segmentName(r.eliminated) : "",
          lapsDone(r.driver),
        ];
      }),
    ),
  );
} else {
  await write(
    "results.csv",
    csv(
      isRace
        ? ["position", "driver", "name", "team", "grid", "places_gained", "laps", "time", "gap", "points", "status"]
        : ["position", "driver", "name", "team", "best_lap", "gap", "laps"],
      meta.results.map((r) => {
        const head = [r.position ?? "", acr(r.driver), info(r.driver).fullName, info(r.driver).team];
        const gapCell = typeof r.gapToLeader === "number" ? (r.gapToLeader ? gap(r.gapToLeader) : "") : (r.gapToLeader ?? "");
        if (!isRace) return [...head, lapTime(r.duration), gapCell, lapsDone(r.driver)];
        const grid = gridOf.get(r.driver);
        return [...head, grid ?? "pit lane", grid && r.position ? grid - r.position : "", r.laps, lapTime(r.duration), gapCell, r.points, status(r)];
      }),
    ),
  );
}

// ---------------------------------------------------------------- stints, pits, race control, weather

await write(
  "stints.csv",
  csv(
    ["driver", "team", "stint", "compound", "lap_start", "lap_end", "laps", "tyre_age_at_start"],
    order.flatMap((n) =>
      meta.stints
        .filter((s) => s.driver === n)
        .sort((a, b) => a.stint - b.stint)
        .map((s) => [acr(n), info(n).team, s.stint, s.compound, s.lapStart, s.lapEnd, s.lapEnd - s.lapStart + 1, s.ageAtStart]),
    ),
  ),
);

const compoundOn = (driver: number, lap: number) => meta.stints.find((s) => s.driver === driver && s.lapStart <= lap && lap <= s.lapEnd)?.compound ?? "";
await write(
  "pits.csv",
  csv(
    ["driver", "team", "lap", "stationary_s", "pit_lane_s", "tyres_off", "tyres_on", "session_clock"],
    [...meta.pits]
      .sort((a, b) => a.entry - b.entry)
      .map((p) => [acr(p.driver), info(p.driver).team, p.lap, num(p.stopDuration, 1), num(p.laneDuration, 1), compoundOn(p.driver, p.lap), compoundOn(p.driver, p.lap + 1), clock(p.entry)]),
  ),
);

await write(
  "race_control.csv",
  csv(
    ["session_clock", "utc", "lap", "category", "flag", "driver", "message"],
    meta.raceControl.map((m) => [clock(m.t), utc(m.t), m.lap ?? "", m.category, m.flag ?? "", m.driver != null ? acr(m.driver) : "", m.message]),
  ),
);

await write(
  "weather.csv",
  csv(
    ["session_clock", "utc", "air_c", "track_c", "humidity_pct", "pressure_mbar", "rain", "wind_ms", "wind_dir_deg"],
    meta.weather.map((w) => [clock(w.t), utc(w.t), w.airTemp, w.trackTemp, w.humidity, w.pressure, w.rainfall > 0 ? "yes" : "no", w.windSpeed, w.windDirection]),
  ),
);

// ---------------------------------------------------------------- telemetry

interface Trace {
  label: string;
  driver: number;
  lap: number;
  d: ArrayLike<number>; // m from the timing line
  t: ArrayLike<number>; // ms since the lap start
  speed: ArrayLike<number>;
  throttle: ArrayLike<number>;
  brake: ArrayLike<number>;
  gear: ArrayLike<number>;
  integrated?: boolean; // distance from speed (races): off by a few metres a lap, so stretched to a common length
}

const lapTraceFiles = new Map<number, DriverLapTraces | null>();
async function lapTraceFile(driver: number) {
  if (!lapTraceFiles.has(driver)) {
    const f = Bun.file(`${SESSION_DIR}/laps/${driver}.json`);
    lapTraceFiles.set(driver, (await f.exists()) ? await f.json() : null);
  }
  return lapTraceFiles.get(driver)!;
}

/** A lap over distance: qualifying and practice store aligned traces; for races, cut the car data and integrate speed. */
async function traceOf(driver: number, lapNumber: number, label: string): Promise<Trace | null> {
  const stored = (await lapTraceFile(driver))?.laps.find((l) => l.lap === lapNumber);
  if (stored) return { label, ...decodeLapTrace(driver, stored) };
  const lap = lapsOf.get(driver)?.find((l) => l.lap === lapNumber);
  const f = Bun.file(`${SESSION_DIR}/drivers/${driver}.json`);
  if (!lap?.end || !(await f.exists())) return null;
  const { car }: DriverTelemetry = await f.json();
  const idx: number[] = [];
  const t: number[] = [];
  let abs = 0;
  for (let i = 0; i < car.t.length; i++) {
    abs += car.t[i];
    if (abs >= lap.start && abs <= lap.end) {
      idx.push(i);
      t.push(abs - lap.start);
    }
  }
  if (idx.length < 2) return null;
  const d = [0];
  for (let k = 1; k < idx.length; k++) d.push(d[k - 1] + (((car.speed[idx[k]] + car.speed[idx[k - 1]]) / 2) * (t[k] - t[k - 1])) / 3.6 / 1000);
  const pick = (a: number[]) => idx.map((i) => a[i]);
  return { label, driver, lap: lapNumber, d, t, speed: pick(car.speed), throttle: pick(car.throttle), brake: pick(car.brake), gear: pick(car.gear), integrated: true };
}

const fastestLap = (n: number) => (lapsOf.get(n) ?? []).filter(isValid).reduce<Lap | null>((best, l) => (best == null || l.duration! < best.duration! ? l : best), null);

const traces: Trace[] = [];
for (const n of order) {
  const lap = fastestLap(n);
  const tr = lap && (await traceOf(n, lap.lap, acr(n)));
  if (tr) traces.push(tr);
}
for (const spec of extraTraces) {
  const [who, lapText] = spec.split(":");
  const driver = byAcronym.get(who.toUpperCase()) ?? Number(who);
  const tr = driverInfo.has(driver) ? await traceOf(driver, Number(lapText), `${acr(driver)} L${lapText}`) : null;
  if (tr) traces.push(tr);
  else console.warn(`--trace ${spec}: no such lap (driver acronym or number, then lap number)`);
}

// Stretch integrated distances to the median lap length so the laps line up over distance.
const integrated = traces.filter((tr) => tr.integrated);
if (integrated.length) {
  const lengths = integrated.map((tr) => tr.d[tr.d.length - 1]).sort((a, b) => a - b);
  const median = lengths[Math.floor(lengths.length / 2)];
  for (const tr of integrated) {
    const k = median / tr.d[tr.d.length - 1];
    tr.d = Array.from(tr.d, (d) => d * k);
  }
}

if (traces.length) {
  const rows: Cell[][] = [];
  for (const tr of traces) {
    for (let i = 0; i < tr.d.length; i++) {
      rows.push([tr.label, info(tr.driver).team, tr.lap, num(tr.d[i], 1), num(tr.t[i] / 1000), Math.round(tr.speed[i]), Math.round(tr.throttle[i]), tr.brake[i] > 0 ? 1 : 0, tr.gear[i]]);
    }
  }
  await write("telemetry.csv", csv(["driver", "team", "lap", "distance_m", "time_s", "speed_kph", "throttle_pct", "brake", "gear"], rows));

  const STEP = 10;
  const length = Math.max(...traces.map((tr) => tr.d[tr.d.length - 1]));
  const speedAt = (tr: Trace, d: number) => {
    const n = tr.d.length;
    if (d > tr.d[n - 1]) return null;
    let i = 0;
    while (i < n - 2 && tr.d[i + 1] < d) i++;
    const span = tr.d[i + 1] - tr.d[i];
    return span > 0 ? tr.speed[i] + ((d - tr.d[i]) / span) * (tr.speed[i + 1] - tr.speed[i]) : tr.speed[i];
  };
  const grid: Cell[][] = [];
  for (let d = 0; d <= length; d += STEP) grid.push([d, ...traces.map((tr) => num(speedAt(tr, d), 0))]);
  await write("speed_trace.csv", csv(["distance_m", ...traces.map((tr) => tr.label)], grid));
}

// ---------------------------------------------------------------- summary

const md: string[] = [];
const line = (s = "") => md.push(s);
const table = (header: string[], rows: Cell[][]) => {
  line(`| ${header.join(" | ")} |`);
  line(`|${header.map(() => " --- ").join("|")}|`);
  for (const r of rows) line(`| ${r.map((c) => (c == null ? "" : String(c))).join(" | ")} |`);
  line();
};
const who = (n: number) => `${info(n).fullName} (${info(n).team})`;

line(`# ${meta.year} ${meta.meetingName}: ${meta.sessionName}`);
line();
line(`${meta.circuit}, ${meta.country} · ${new Date(Date.parse(meta.t0) + meta.lightsOut).toUTCString()} · session ${sessionKey}`);
line();

const allValid = meta.laps.filter(isValid);
const fastest = allValid.reduce<Lap | null>((b, l) => (b == null || l.duration! < b.duration! ? l : b), null);

if (isRace) {
  const finishers = meta.results.filter((r) => r.position != null);
  const [winner] = finishers;
  line("## Headlines");
  line();
  if (winner) {
    const grid = gridOf.get(winner.driver);
    line(`- **Winner:** ${who(winner.driver)} in ${lapTime(winner.duration)}${grid ? grid === 1 ? ", from pole" : `, from P${grid} on the grid` : ""}`);
  }
  line(`- **Podium:** ${finishers.slice(0, 3).map((r) => acr(r.driver)).join(", ")}`);
  if (fastest) line(`- **Fastest lap:** ${who(fastest.driver)}, ${lapTime(fastest.duration)} on lap ${fastest.lap}`);
  const trap = meta.laps.filter((l) => l.speedTrap.st != null).reduce<Lap | null>((b, l) => (b == null || l.speedTrap.st! > b.speedTrap.st! ? l : b), null);
  if (trap) line(`- **Top speed (speed trap):** ${acr(trap.driver)}, ${trap.speedTrap.st} km/h on lap ${trap.lap}`);
  const stops = meta.pits.filter((p) => p.stopDuration != null).sort((a, b) => a.stopDuration! - b.stopDuration!);
  const lanes = meta.pits.filter((p) => p.laneDuration != null).sort((a, b) => a.laneDuration! - b.laneDuration!);
  if (stops[0]) line(`- **Fastest pit stop:** ${acr(stops[0].driver)}, ${stops[0].stopDuration!.toFixed(1)} s stationary on lap ${stops[0].lap}`);
  if (lanes[0]) line(`- **Quickest time through the pit lane:** ${acr(lanes[0].driver)}, ${lanes[0].laneDuration!.toFixed(1)} s on lap ${lanes[0].lap}`);
  line(`- **Pit stops:** ${meta.pits.length}`);

  // Neutralisations, by the leader's lap.
  const leaderLapAt = (t: Ms) => Math.max(0, ...meta.laps.filter((l) => l.start <= t).map((l) => l.lap));
  const periods: string[] = [];
  for (let i = 0; i < meta.trackStatus.length; i++) {
    const e = meta.trackStatus[i];
    if (e.status !== "SC" && e.status !== "VSC" && e.status !== "RED") continue;
    if (i > 0 && statusName(meta.trackStatus[i - 1].status) === e.status) continue;
    const end = meta.trackStatus.slice(i + 1).find((n) => statusName(n.status) !== e.status);
    periods.push(`${e.status} laps ${leaderLapAt(e.t)}–${end ? leaderLapAt(end.t) : meta.totalLaps}`);
  }
  line(`- **Neutralisations:** ${periods.length ? periods.join(", ") : "none"}`);

  if (meta.overtakes.length) {
    const count = new Map<number, number>();
    for (const o of meta.overtakes) count.set(o.overtaker, (count.get(o.overtaker) ?? 0) + 1);
    const top = [...count].sort((a, b) => b[1] - a[1]).slice(0, 3);
    line(`- **Overtakes:** ${meta.overtakes.length} (most: ${top.map(([n, c]) => `${acr(n)} ${c}`).join(", ")})`);
  }

  const led = new Map<number, number>();
  for (const [key, e] of lapEnd) if (e.position === 1) led.set(Number(key.split(":")[0]), (led.get(Number(key.split(":")[0])) ?? 0) + 1);
  line(`- **Laps led:** ${[...led].sort((a, b) => b[1] - a[1]).map(([n, c]) => `${acr(n)} ${c}`).join(", ")}`);

  const moves = finishers.filter((r) => gridOf.has(r.driver)).map((r) => ({ driver: r.driver, from: gridOf.get(r.driver)!, to: r.position!, gained: gridOf.get(r.driver)! - r.position! }));
  const up = [...moves].sort((a, b) => b.gained - a.gained)[0];
  const down = [...moves].sort((a, b) => a.gained - b.gained)[0];
  if (up?.gained > 0) line(`- **Biggest climber:** ${acr(up.driver)}, P${up.from} → P${up.to} (+${up.gained})`);
  if (down?.gained < 0) line(`- **Biggest drop:** ${acr(down.driver)}, P${down.from} → P${down.to} (${down.gained})`);
  const out = meta.results.filter((r) => r.dnf || r.dns || r.dsq);
  if (out.length) line(`- **Out:** ${out.map((r) => `${acr(r.driver)} (${status(r)}${r.dnf ? `, lap ${r.laps + 1}` : ""})`).join(", ")}`);
  line();

  line("## Classification");
  line();
  table(
    ["Pos", "Driver", "Team", "Grid", "+/-", "Time / gap", "Pts"],
    meta.results.map((r) => {
      const grid = gridOf.get(r.driver);
      const g = grid && r.position ? grid - r.position : null;
      const gapCell = r.position === 1 ? lapTime(r.duration) : typeof r.gapToLeader === "number" ? gap(r.gapToLeader) : (r.gapToLeader ?? status(r));
      return [r.position ?? status(r), acr(r.driver), info(r.driver).team, grid ?? "PL", g == null ? "" : g > 0 ? `+${g}` : g, gapCell, r.points || ""];
    }),
  );

  line("## Strategies");
  line();
  const short: Record<string, string> = { SOFT: "S", MEDIUM: "M", HARD: "H", INTERMEDIATE: "I", WET: "W" };
  table(
    ["Driver", "Stops", "Stints"],
    order.map((n) => {
      const ss = meta.stints.filter((s) => s.driver === n).sort((a, b) => a.stint - b.stint);
      return [acr(n), meta.pits.filter((p) => p.driver === n).length, ss.map((s) => `${short[s.compound] ?? "?"} ${s.lapStart}–${s.lapEnd}${s.ageAtStart ? ` (used ${s.ageAtStart})` : ""}`).join(" → ")];
    }),
  );
} else if (meta.quali) {
  const q = meta.quali;
  const best = (r: (typeof q.results)[number]) => lastTime(r.times);
  const [p1, p2] = q.results;
  line("## Headlines");
  line();
  if (p1 && best(p1) != null) line(`- **Pole:** ${who(p1.driver)}, ${lapTime(best(p1))}${p2 && best(p2) != null ? `, ${gap(best(p2)! - best(p1)!)} ahead of ${acr(p2.driver)}` : ""}`);
  for (const s of q.segments) {
    const outHere = q.results.filter((r) => r.eliminated === s.number);
    if (!outHere.length) continue;
    const i = s.number - 1;
    const lastIn = q.results.filter((r) => r.eliminated == null || r.eliminated > s.number).at(-1);
    const firstOut = outHere[0];
    const cut = lastIn?.times[i] != null && firstOut.times[i] != null ? ` (cut line: ${acr(lastIn.driver)} ${lapTime(lastIn.times[i])}, ${acr(firstOut.driver)} ${gap(firstOut.times[i]! - lastIn.times[i]!)} short)` : "";
    line(`- **Out in ${s.name}:** ${outHere.map((r) => acr(r.driver)).join(", ")}${cut}`);
  }
  const trap = meta.laps.filter((l) => l.speedTrap.st != null).reduce<Lap | null>((b, l) => (b == null || l.speedTrap.st! > b.speedTrap.st! ? l : b), null);
  if (trap) line(`- **Top speed (speed trap):** ${acr(trap.driver)}, ${trap.speedTrap.st} km/h`);
  const deleted = q.laps.filter((l) => l.deleted);
  if (deleted.length) line(`- **Deleted laps:** ${deleted.length} (${deleted.map((l) => `${acr(l.driver)} ${segmentName(l.segment)}`).join(", ")})`);
  line();
  line("## Classification");
  line();
  table(
    ["Pos", "Driver", "Team", ...q.segments.map((s) => s.name), "Gap"],
    q.results.map((r) => {
      const b = best(r);
      const pole = p1 ? best(p1) : null;
      return [r.position, acr(r.driver), info(r.driver).team, ...q.segments.map((_, i) => lapTime(r.times[i])), r.position !== 1 && r.eliminated == null && b != null && pole != null ? gap(b - pole) : ""];
    }),
  );
} else {
  line("## Headlines");
  line();
  const [p1, p2] = meta.results;
  if (p1?.duration != null) line(`- **Fastest:** ${who(p1.driver)}, ${lapTime(p1.duration)}${p2?.duration != null ? `, ${gap(p2.duration - p1.duration)} ahead of ${acr(p2.driver)}` : ""}`);
  const most = [...order].sort((a, b) => lapsDone(b) - lapsDone(a))[0];
  if (most != null) line(`- **Most laps:** ${acr(most)}, ${lapsDone(most)}`);
  const trap = meta.laps.filter((l) => l.speedTrap.st != null).reduce<Lap | null>((b, l) => (b == null || l.speedTrap.st! > b.speedTrap.st! ? l : b), null);
  if (trap) line(`- **Top speed (speed trap):** ${acr(trap.driver)}, ${trap.speedTrap.st} km/h`);
  line();
  line("## Timesheet");
  line();
  table(
    ["Pos", "Driver", "Team", "Best", "Gap", "Laps"],
    meta.results.map((r) => [r.position ?? "", acr(r.driver), info(r.driver).team, lapTime(r.duration), r.position !== 1 && r.duration != null && p1?.duration != null ? gap(r.duration - p1.duration) : "", lapsDone(r.driver)]),
  );
}

// Team-mates: race finish, or the qualifying/practice time in the last segment both drivers ran.
line("## Team-mates");
line();
const teams = new Map<string, number[]>();
for (const n of order) teams.set(info(n).team, [...(teams.get(info(n).team) ?? []), n]);
const pairRows: Cell[][] = [];
for (const [team, ds] of teams) {
  if (ds.length !== 2) continue;
  const [a, b] = ds; // classification order: a is ahead
  if (meta.quali) {
    const ra = meta.quali.results.find((r) => r.driver === a);
    const rb = meta.quali.results.find((r) => r.driver === b);
    const seg = ra && rb ? Math.min(...[ra, rb].map((r) => lastSegment(r.times))) : -1;
    const delta = seg >= 0 ? rb!.times[seg]! - ra!.times[seg]! : null;
    pairRows.push([team, acr(a), acr(b), delta != null ? `${gap(delta)} (${meta.quali.segments[seg]?.name})` : ""]);
  } else {
    const ra = meta.results.find((r) => r.driver === a);
    const rb = meta.results.find((r) => r.driver === b);
    const place = (r: SessionMeta["results"][number] | undefined) => (r?.position ? `P${r.position}` : r ? status(r) : "");
    const detail = isRace ? `${place(ra)} vs ${place(rb)}` : ra?.duration != null && rb?.duration != null ? gap(rb.duration - ra.duration) : "";
    pairRows.push([team, acr(a), acr(b), detail]);
  }
}
table(["Team", "Ahead", "Behind", isRace ? "Result" : "Gap"], pairRows);

// Ideal laps: each driver's best sectors (valid laps) against their best lap.
line("## Best sectors and ideal laps");
line();
const sectorBest = [0, 1, 2].map((i) => allValid.filter((l) => l.sectors[i] != null).reduce<Lap | null>((b, l) => (b == null || l.sectors[i]! < b.sectors[i]! ? l : b), null));
sectorBest.forEach((l, i) => l && line(`- **Sector ${i + 1}:** ${acr(l.driver)}, ${l.sectors[i]!.toFixed(3)}`));
const sumBest = sectorBest.every(Boolean) ? sectorBest.reduce((s, l, i) => s + l!.sectors[i]!, 0) : null;
if (sumBest != null) line(`- **Ideal lap (fastest sectors of anyone):** ${lapTime(sumBest)}${fastest ? ` vs the fastest lap ${lapTime(fastest.duration)}` : ""}`);
line();
const ideal = order
  .map((n) => {
    const ls = (lapsOf.get(n) ?? []).filter(isValid);
    const sectors = [0, 1, 2].map((i) => Math.min(...ls.map((l) => l.sectors[i] ?? Infinity)));
    const bestLap = fastestLap(n)?.duration ?? null;
    return { n, ideal: sectors.every(Number.isFinite) ? sectors.reduce((a, b) => a + b, 0) : null, bestLap };
  })
  .filter((r) => r.ideal != null && r.bestLap != null)
  .sort((a, b) => a.ideal! - b.ideal!);
table(
  ["Driver", "Ideal lap", "Best lap", "Left on the table"],
  ideal.map((r) => [acr(r.n), lapTime(r.ideal), lapTime(r.bestLap), (r.bestLap! - r.ideal!).toFixed(3)]),
);

if (meta.weather.length) {
  // The feed sometimes reports 0 for a reading it doesn't have.
  const range = (all: number[]) => {
    const xs = all.filter((x) => x !== 0);
    return !xs.length ? "?" : Math.min(...xs) === Math.max(...xs) ? `${xs[0]}` : `${Math.min(...xs)}–${Math.max(...xs)}`;
  };
  line("## Weather");
  line();
  line(`Air ${range(meta.weather.map((w) => w.airTemp))} °C, track ${range(meta.weather.map((w) => w.trackTemp))} °C, humidity ${range(meta.weather.map((w) => w.humidity))} %, rain: ${meta.weather.some((w) => w.rainfall > 0) ? "yes" : "no"}`);
  line();
}

await write("summary.md", md.join("\n"));

console.log(md.join("\n"));
console.log(`wrote ${written.join(", ")}\n  to ${OUT_DIR}/`);
