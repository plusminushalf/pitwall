// Sanity-check ingested qualifying sessions (meta.json quali data + laps/<n>.json traces).
//
//   bun run check:quali [session_key ...]      (default: every qualifying session in index.json)
//
// Exits non-zero if any check fails.

import { decodeLapTrace, deltaAt, type DecodedLap } from "../src/engine/compare";
import type { DriverLapTraces, SessionIndexEntry, SessionMeta } from "../src/types";

const DIR = "data/sessions";
const TOLERANCE_S = 0.05;

const args = process.argv.slice(2).map(Number).filter(Number.isInteger);
const index: SessionIndexEntry[] = await Bun.file(`${DIR}/index.json`).json();
const keys = args.length ? args : index.filter((e) => e.sessionType === "Qualifying").map((e) => e.sessionKey);
if (!keys.length) {
  console.error("no qualifying sessions ingested (bun run ingest <key>)");
  process.exit(1);
}

let failures = 0;
const lapTime = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(3).padStart(6, "0")}`;

for (const key of keys) {
  const meta: SessionMeta = await Bun.file(`${DIR}/${key}/meta.json`).json();
  const q = meta.quali;
  const fails: string[] = [];
  const notes: string[] = [];
  const check = (ok: boolean, msg: string) => {
    if (!ok) fails.push(msg);
  };
  console.log(`\n${key} ${meta.year} ${meta.meetingName} · ${meta.sessionName}`);
  if (!q) {
    console.log("  FAIL no quali data in meta.json");
    failures++;
    continue;
  }
  const entry = index.find((e) => e.sessionKey === key);
  check(entry?.sessionType === "Qualifying", `index.json entry has sessionType ${entry?.sessionType}`);

  // Segments.
  check(q.segments.length === 3, `${q.segments.length} segments`);
  q.segments.forEach((s, i) => {
    check(s.end > s.start, `${s.name} ends before it starts`);
    if (i > 0) check(s.start >= q.segments[i - 1].end, `${s.name} starts before ${q.segments[i - 1].name} ends`);
  });
  notes.push(`segments ${q.segments.map((s) => `${s.name} ${Math.round((s.end - s.start) / 60_000)} min`).join(", ")}`);

  // Eliminations.
  const n = q.results.length;
  const out = q.segments.map((s) => q.results.filter((r) => r.eliminated === s.number).length);
  check(out[0] >= 4 && out[0] <= 6 && out[1] >= 4 && out[1] <= 6, `implausible eliminations ${out.join("/")}`);
  check(q.results.filter((r) => r.eliminated == null).length === 10, `${q.results.filter((r) => r.eliminated == null).length} drivers in the final segment`);
  notes.push(`${n} drivers, knocked out ${out[0]} / ${out[1]}, ${n - out[0] - out[1]} in ${q.segments[2]?.name}`);

  // Traces.
  const traces = new Map<number, Map<number, DecodedLap>>();
  let traceCount = 0;
  let monotonic = true;
  const endErrors: number[] = [];
  for (const d of meta.drivers) {
    const file = Bun.file(`${DIR}/${key}/laps/${d.number}.json`);
    if (!(await file.exists())) continue;
    const tr: DriverLapTraces = await file.json();
    const byLap = new Map<number, DecodedLap>();
    for (const lt of tr.laps) {
      const lap = decodeLapTrace(d.number, lt);
      byLap.set(lap.lap, lap);
      traceCount++;
      for (let i = 1; i < lap.t.length; i++) if (lap.t[i] <= lap.t[i - 1] || lap.d[i] < lap.d[i - 1]) monotonic = false;
      const official = meta.laps.find((l) => l.driver === d.number && l.lap === lap.lap)?.duration;
      if (official != null) endErrors.push(Math.abs(lap.duration - official * 1000));
      check(Math.abs(lap.length - q.lapLength) < 0.11, `#${d.number} lap ${lap.lap} ends at ${lap.length.toFixed(1)} m, not ${q.lapLength} m`);
    }
    traces.set(d.number, byLap);
  }
  check(monotonic, "a trace's time or distance goes backwards");
  check(Math.max(...endErrors) <= 1, `a trace's last sample is ${Math.max(...endErrors)} ms off its lap time`);
  check(q.laps.filter((l) => l.trace).length === traceCount, "trace flags don't match the trace files");
  const outline = meta.track.outline;
  let outlineM = 0;
  for (let i = 1; i <= outline.x.length; i++) {
    const j = i % outline.x.length;
    outlineM += Math.hypot(outline.x[j] - outline.x[i - 1], outline.y[j] - outline.y[i - 1]) / 10;
  }
  check(Math.abs(q.lapLength / outlineM - 1) < 0.01, `lap length ${q.lapLength} m vs GPS outline ${outlineM.toFixed(0)} m`);
  notes.push(`${traceCount} traced laps, lap length ${q.lapLength} m (GPS outline ${outlineM.toFixed(0)} m), sector lines at ${q.sectorDistances.join(" / ")} m`);

  // Classification: every official time is a traced, non-deleted lap of that segment.
  for (const r of q.results) {
    r.times.forEach((time, k) => {
      if (time == null) return;
      const lapNo = r.laps[k];
      const seg = q.segments[k].name;
      if (lapNo == null) return fails.push(`#${r.driver} ${seg} ${lapTime(time)}: no lap found`);
      const lap = meta.laps.find((l) => l.driver === r.driver && l.lap === lapNo);
      const ql = q.laps.find((l) => l.driver === r.driver && l.lap === lapNo);
      check(lap?.duration != null && Math.abs(lap.duration - time) < 0.0015, `#${r.driver} ${seg}: lap ${lapNo} is ${lap?.duration}, official ${time}`);
      check(ql?.segment === k + 1 && !ql.afterFlag && !ql.deleted && ql.best, `#${r.driver} ${seg}: lap ${lapNo} flags ${JSON.stringify(ql)}`);
      check(traces.get(r.driver)?.has(lapNo) === true, `#${r.driver} ${seg}: lap ${lapNo} has no trace`);
    });
    check(r.times.some((t) => t != null) || r.position == null || r.position > n - 3, `#${r.driver} P${r.position} has no time`);
  }

  // Deltas between best laps: at the line and at the sector boundaries they must match the
  // official lap / sector time differences.
  let pairs = 0;
  let worstLine = 0;
  let worstSector = 0;
  let worstPair = "";
  q.segments.forEach((seg, k) => {
    const best = q.results.flatMap((r) => {
      const lapNo = r.laps[k];
      const lap = lapNo != null ? traces.get(r.driver)?.get(lapNo) : undefined;
      const meta_ = meta.laps.find((l) => l.driver === r.driver && l.lap === lapNo);
      return lap && meta_ ? [{ lap, meta: meta_ }] : [];
    });
    for (let i = 0; i < best.length; i++) {
      for (let j = i + 1; j < best.length; j++) {
        const a = best[i];
        const b = best[j];
        pairs++;
        const line = Math.abs(deltaAt(a.lap, b.lap, q.lapLength) - (b.meta.duration! - a.meta.duration!));
        if (line > worstLine) {
          worstLine = line;
          worstPair = `${seg.name} #${a.lap.driver} L${a.lap.lap} vs #${b.lap.driver} L${b.lap.lap}`;
        }
        let sa = 0;
        let sb = 0;
        for (let s = 0; s < 2; s++) {
          if (a.meta.sectors[s] == null || b.meta.sectors[s] == null) break;
          sa += a.meta.sectors[s]!;
          sb += b.meta.sectors[s]!;
          worstSector = Math.max(worstSector, Math.abs(deltaAt(a.lap, b.lap, q.sectorDistances[s]) - (sb - sa)));
        }
      }
    }
  });
  check(pairs > 0, "no best-lap pairs to compare");
  check(worstLine <= TOLERANCE_S, `delta at the line is off by ${worstLine.toFixed(3)} s (${worstPair})`);
  check(worstSector <= TOLERANCE_S, `delta at a sector boundary is off by ${worstSector.toFixed(3)} s`);
  notes.push(`${pairs} best-lap pairs: delta vs official lap-time difference max error ${(worstLine * 1000).toFixed(1)} ms at the line, ${(worstSector * 1000).toFixed(1)} ms at sector boundaries`);

  // Independent of the timing: the aligned distance of every official best lap against its GPS
  // position projected onto the track outline (after removing a constant offset per lap).
  const ox = [...outline.x, outline.x[0]];
  const oy = [...outline.y, outline.y[0]];
  const os = [0];
  for (let i = 1; i < ox.length; i++) os.push(os[i - 1] + Math.hypot(ox[i] - ox[i - 1], oy[i] - oy[i - 1]) / 10);
  const scale = q.lapLength / os.at(-1)!;
  const project = (x: number, y: number, near: number) => {
    let best = NaN;
    let bestD = Infinity;
    for (let i = 1; i < ox.length; i++) {
      const ds = Math.abs(os[i - 1] * scale - near);
      if (Math.min(ds, q.lapLength - ds) > 400) continue;
      const dx = ox[i] - ox[i - 1];
      const dy = oy[i] - oy[i - 1];
      const f = Math.min(1, Math.max(0, ((x - ox[i - 1]) * dx + (y - oy[i - 1]) * dy) / (dx * dx + dy * dy || 1)));
      const dd = (ox[i - 1] + f * dx - x) ** 2 + (oy[i - 1] + f * dy - y) ** 2;
      if (dd < bestD) {
        bestD = dd;
        best = (os[i - 1] + f * (os[i] - os[i - 1])) * scale;
      }
    }
    return best;
  };
  const rms: { v: number; what: string }[] = [];
  for (const r of q.results) {
    r.laps.forEach((lapNo) => {
      const lap = lapNo != null ? traces.get(r.driver)?.get(lapNo) : undefined;
      if (!lap) return;
      const diffs: number[] = [];
      for (let k = 0; k < lap.d.length; k++) {
        let e = project(lap.x[k], lap.y[k], lap.d[k]) - lap.d[k];
        if (Number.isNaN(e)) continue;
        if (e > q.lapLength / 2) e -= q.lapLength;
        if (e < -q.lapLength / 2) e += q.lapLength;
        diffs.push(e);
      }
      const off = [...diffs].sort((a, b) => a - b)[diffs.length >> 1] ?? 0;
      rms.push({ v: Math.sqrt(diffs.reduce((s, e) => s + (e - off) ** 2, 0) / Math.max(1, diffs.length)), what: `#${r.driver} L${lapNo}` });
    });
  }
  rms.sort((a, b) => a.v - b.v);
  const worst = rms.at(-1);
  check(worst != null && worst.v < 30, `best lap ${worst?.what} strays ${worst?.v.toFixed(1)} m (RMS) from its GPS position`);
  notes.push(`aligned distance vs GPS on ${rms.length} best laps: RMS median ${rms[rms.length >> 1]?.v.toFixed(1)} m, worst ${worst?.v.toFixed(1)} m (${worst?.what})`);

  const deleted = q.laps.filter((l) => l.deleted).length;
  notes.push(`${deleted} deleted laps, ${q.laps.filter((l) => l.kind === "push").length} push laps`);

  for (const note of notes) console.log(`  ${note}`);
  for (const f of fails) console.log(`  FAIL ${f}`);
  console.log(`  ${fails.length ? `${fails.length} FAILED` : "ok"}`);
  failures += fails.length;
}

process.exit(failures ? 1 : 0);
