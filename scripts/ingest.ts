// Download a race from OpenF1 and write the processed replay format (src/types.ts).
//
//   bun scripts/ingest.ts <session_key>        (find keys with: bun run races <year>)
//
// Raw responses are cached (gzipped) in data/raw/<key>/, output goes to data/sessions/<key>/ (used by the tests
// and the live simulator; the app itself downloads races into the browser, see src/ingest/).

import { bunCacheIO, fetchCircuit, fetchEndpoint } from "./openf1";
import type { Ms, SessionIndexEntry } from "../src/types";
import { runIngest, type IngestIO } from "./lib/ingestCore";

const sessionKey = Number(process.argv[2]);
if (!Number.isInteger(sessionKey)) {
  console.error("usage: bun scripts/ingest.ts <session_key>   (find keys with: bun run races <year>)");
  process.exit(1);
}

// Download, normalize and write (lib/ingestCore.ts, shared with the browser worker), on the local disk.
const io: IngestIO = {
  ...bunCacheIO,
  fetchEndpoint,
  fetchCircuit,
  async writeOutput(path, json) {
    await Bun.write(path, json);
    return Bun.gzipSync(json).length;
  },
  async readIndex(path) {
    const indexFile = Bun.file(path);
    return (await indexFile.exists()) ? ((await indexFile.json()) as SessionIndexEntry[]) : undefined;
  },
  async writeIndex(path, text) {
    await Bun.write(path, text);
  },
  log: (line) => console.log(line),
  warn: (line) => console.warn(line),
};

const { meta, telemetry, report, quali, sizes, outDir: OUT_DIR } = await runIngest(sessionKey, io, {
  rawDir: `data/raw/${sessionKey}`,
  sessionsDir: "data/sessions",
});
const { duration, lightsOut, chequered, totalLaps, trackStatus, pits, results, drivers, track } = meta;
const { outline, pitLane, corners, marshalSectors, pitLoss } = track;
const refLap = report.refLap!;

// ---------------------------------------------------------------- sanity summary

const fmt = (ms: Ms) => {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};
const mb = (b: number) => `${(b / 1e6).toFixed(2)} MB`;

console.log(`\n${meta.year} ${meta.meetingName} — ${meta.sessionName} (${meta.circuit})`);
console.log(`window ${fmt(duration)} from ${meta.t0} | lights out +${fmt(lightsOut)} | chequered ${chequered != null ? `+${fmt(chequered)}` : "none"} | ${totalLaps} laps`);

console.log(`\ntrack status:`);
for (const e of trackStatus) console.log(`  +${fmt(e.t)}  ${e.status}`);

const rep = report;
const repairs = [
  rep.lapRenumbered ? `split ${rep.splitCount} merged lap records (missed timing-line crossings) and renumbered laps/pits/stints for ${rep.lapRenumbered} drivers` : "",
  rep.undatedLap1 ? `dated ${rep.undatedLap1} undated lap 1 records at lights out` : "",
  rep.restarted ? `moved ${rep.restarted} late lap starts to the previous lap's end` : "",
  rep.droppedCoolDown ? `dropped ${rep.droppedCoolDown} post-finish lap records` : "",
  rep.finishFromLine ? `${rep.finishFromLine} final-lap ends taken from the timing line` : "",
  rep.staleLoc ? `dropped ${rep.staleLoc} stale location samples (position repeated while moving)` : "",
  rep.deadReckoned
    ? `dead-reckoned ${rep.deadReckoned} positions for ${rep.deadReckonedDrivers} drivers from speed along the outline (location feed gaps > 3s)`
    : "",
  rep.rawPits > rep.uniquePits
    ? `dropped ${rep.rawPits - rep.uniquePits} duplicate pit records (${rep.recoveredPits} re-dated from the pit-out lap)`
    : "",
  rep.timingLineFound ? "" : "timing line not found (no lap repair possible)",
].filter(Boolean);
if (repairs.length) console.log(`\nrepairs: ${repairs.join("; ")}`);

console.log(`\npits: ${pits.length}, date read as ${rep.pitDateIsExit ? "exit" : "entry"} (median lane speed ${rep.speedIfExit.toFixed(0)} km/h if exit, ${rep.speedIfEntry.toFixed(0)} km/h if entry)`);
console.log(`reference lap: #${refLap.driver} lap ${refLap.lap} (${refLap.duration}s), ${outline.x.length} outline points, pit lane ${pitLane?.x.length ?? 0} points`);
console.log(`circuit: rotation ${track.rotation}°, ${corners.length} corners, ${marshalSectors.length} marshal sectors, pit loss ${pitLoss ? `${pitLoss.normal}s` : "unknown"}`);

console.log(`\n pos  drv  laps  result  loc     car     loc Hz  status`);
for (const r of results) {
  const d = drivers.find((x) => x.number === r.driver)!;
  const t = telemetry.get(r.driver)!;
  const lapCount = meta.laps.filter((l) => l.driver === r.driver).length;
  const lt = report.locFixes.get(r.driver)!;
  const hz = lt.length > 1 ? (lt.length - 1) / ((lt.at(-1)! - lt[0]) / 1000) : 0;
  const status = r.dsq ? "DSQ" : r.dns ? "DNS" : r.dnf ? "DNF" : "finished";
  // A retiring (or non-starting) car starts one lap it never completes.
  const lapsOk = lapCount === r.laps || ((r.dnf || r.dns) && lapCount === r.laps + 1);
  const flag = lapsOk ? "" : "  <-- lap count mismatch";
  console.log(
    ` ${String(r.position ?? "-").padStart(3)}  ${d.acronym}  ${String(lapCount).padStart(4)}  ${String(r.laps).padStart(6)}  ${String(lt.length).padStart(6)}  ${String(t.car.t.length).padStart(6)}  ${hz.toFixed(2).padStart(6)}  ${status}${flag}`,
  );
}

if (quali) {
  console.log(`\nqualifying:`);
  for (const line of quali.report.lines) console.log(`  ${line}`);
  for (const p of quali.report.problems) console.log(`  <-- ${p}`);
}

const totalRaw = sizes.reduce((s, [, raw]) => s + raw, 0);
const totalGz = sizes.reduce((s, [, , gz]) => s + gz, 0);
console.log(`\nwrote ${sizes.length} files to ${OUT_DIR}: ${mb(totalRaw)} raw, ${mb(totalGz)} gzipped (meta.json ${mb(sizes[0][1])})`);
