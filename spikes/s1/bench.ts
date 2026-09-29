// Spike S1 benchmark: drives spike-s1.html in headless Playwright browsers and samples the memory of the
// browser's content process from /proc (Linux only). Runs under node (type stripping, node >= 22.18):
//
//   node spikes/s1/bench.ts [--browsers chromium,firefox,webkit] [--sessions 11377,11234,11373] [--runs 3]
//                           [--network 11234] [--ui 11377,11234|none] [--base http://localhost:5199] [--out file.json]
//
// Starts the spike dev server (spikes/s1/vite.config.ts) if --base isn't answering, and stops it at the end.
// --network is off by default: it downloads a race from OpenF1's free tier (~2.5 min per browser, sequential).
// Each run gets a fresh browser profile (so a fresh OPFS and a fresh content process).

import { execSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { cpus, loadavg, tmpdir, totalmem } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../..", import.meta.url));
const require = createRequire(import.meta.url);

/** Playwright isn't a project dependency: $PLAYWRIGHT_DIR, a local install, or a global one. */
function playwrightDir() {
  try {
    return join(require.resolve("playwright/package.json"), "..");
  } catch {}
  const globalRoot = (() => {
    try {
      return execSync("npm root -g", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    } catch {
      return "";
    }
  })();
  const candidates = [process.env.PLAYWRIGHT_DIR, join(globalRoot, "playwright"), "/usr/lib/node_modules/playwright", "/usr/local/lib/node_modules/playwright"];
  const dir = candidates.find((d) => d && existsSync(join(d, "package.json")));
  if (!dir) throw new Error("Playwright not found: npm i -g playwright, or set PLAYWRIGHT_DIR");
  return dir;
}
const pwDir = playwrightDir();
const pw = require(pwDir);
const pwVersion: string = require(join(pwDir, "package.json")).version;

// ---------------------------------------------------------------- args

const argv = process.argv.slice(2);
const arg = (name: string, def: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const browsers = arg("browsers", "chromium,firefox,webkit").split(",");
const sessions = arg("sessions", "11377,11234,11373").split(",").filter(Boolean).map(Number);
const runs = Number(arg("runs", "3"));
const networkKey = arg("network", "") ? Number(arg("network", "")) : null;
const uiKeys = arg("ui", "11377") === "none" ? [] : arg("ui", "11377").split(",").map(Number);
const base = arg("base", "http://localhost:5199");
const out = arg("out", join(tmpdir(), `s1-bench-${Date.now()}.json`));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const median = (xs: number[]) => {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return NaN;
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

// ---------------------------------------------------------------- dev server

let server: ChildProcess | null = null;
async function up() {
  try {
    return (await fetch(`${base}/spike-s1.html`)).ok;
  } catch {
    return false;
  }
}
async function ensureServer() {
  if (await up()) return;
  const port = new URL(base).port || "5199";
  console.log(`starting the spike dev server on :${port}`);
  server = spawn("bunx", ["vite", "--config", "spikes/s1/vite.config.ts", "--port", port], { cwd: repo, detached: true, stdio: "ignore" });
  for (let i = 0; i < 60 && !(await up()); i++) await sleep(500);
  if (!(await up())) throw new Error("spike dev server didn't start");
}
function stopServer() {
  if (server?.pid) {
    try {
      process.kill(-server.pid, "SIGTERM");
    } catch {}
  }
}
process.on("exit", stopServer);
process.on("SIGINT", () => process.exit(130));

// ---------------------------------------------------------------- /proc sampling

interface Proc {
  pid: number;
  ppid: number;
  cmd: string;
}
function procs(): Proc[] {
  const list: Proc[] = [];
  for (const d of readdirSync("/proc")) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const stat = readFileSync(`/proc/${d}/stat`, "utf8");
      const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      const cmd = readFileSync(`/proc/${d}/cmdline`, "utf8").replace(/\0/g, " ");
      list.push({ pid: Number(d), ppid, cmd });
    } catch {}
  }
  return list;
}
function descendants(root: number): Proc[] {
  const all = procs();
  const kids = new Map<number, Proc[]>();
  for (const p of all) kids.set(p.ppid, [...(kids.get(p.ppid) ?? []), p]);
  const outList: Proc[] = [];
  const stack = [root];
  while (stack.length) {
    for (const k of kids.get(stack.pop()!) ?? []) {
      outList.push(k);
      stack.push(k.pid);
    }
  }
  return outList;
}
/** The process that hosts a page and its dedicated workers, per engine. */
function kind(cmd: string): "content" | "other" {
  if (/--type=renderer/.test(cmd) && !/--extension-process/.test(cmd)) return "content"; // Chromium
  if (/-contentproc/.test(cmd) && /\btab\b/.test(cmd)) return "content"; // Firefox
  if (/WebKitWebProcess/.test(cmd)) return "content"; // WebKit
  return "other";
}
function mem(pid: number): { rss: number; hwm: number } | null {
  try {
    const s = readFileSync(`/proc/${pid}/status`, "utf8");
    const kb = (k: string) => Number(new RegExp(`${k}:\\s+(\\d+)`).exec(s)?.[1] ?? 0);
    return { rss: kb("VmRSS"), hwm: kb("VmHWM") };
  } catch {
    return null;
  }
}

/** CPU seconds (user + system, all threads) a process has used so far. */
function cpuSeconds(pid: number): number {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const f = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return (Number(f[11]) + Number(f[12])) / 100; // utime + stime, in USER_HZ (100 on Linux)
  } catch {
    return NaN;
  }
}

class Sampler {
  peak = new Map<number, number>();
  hwm = new Map<number, number>();
  cmd = new Map<number, string>();
  sumPeak = 0;
  private timer: NodeJS.Timeout | null = null;
  private tick = 0;
  private pids: Proc[] = [];
  start() {
    this.pids = descendants(process.pid);
    this.timer = setInterval(() => this.sample(), 100);
    this.sample();
  }
  sample() {
    if (this.tick++ % 10 === 0) this.pids = descendants(process.pid);
    let sum = 0;
    for (const p of this.pids) {
      const m = mem(p.pid);
      if (!m) continue;
      this.cmd.set(p.pid, p.cmd);
      sum += m.rss;
      this.peak.set(p.pid, Math.max(this.peak.get(p.pid) ?? 0, m.rss));
      this.hwm.set(p.pid, Math.max(this.hwm.get(p.pid) ?? 0, m.hwm));
    }
    this.sumPeak = Math.max(this.sumPeak, sum);
  }
  cpu = new Map<number, number>();
  stop() {
    this.sample();
    if (this.timer) clearInterval(this.timer);
    for (const pid of this.cmd.keys()) this.cpu.set(pid, cpuSeconds(pid));
  }
}

function snapshot() {
  const per = new Map<number, number>();
  const cpu = new Map<number, number>();
  let sum = 0;
  for (const p of descendants(process.pid)) {
    const m = mem(p.pid);
    if (!m) continue;
    per.set(p.pid, m.rss);
    cpu.set(p.pid, cpuSeconds(p.pid));
    sum += m.rss;
  }
  return { per, cpu, sum };
}

// ---------------------------------------------------------------- parity

function cliHashes(key: number): Record<string, { sha256: string; bytes: number }> {
  const dir = join(repo, "public/sessions", String(key));
  const files: Record<string, { sha256: string; bytes: number }> = {};
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else {
        const b = readFileSync(p);
        files[relative(dir, p)] = { sha256: createHash("sha256").update(b).digest("hex"), bytes: b.length };
      }
    }
  };
  if (existsSync(dir)) walk(dir);
  return files;
}
function parity(key: number, browserFiles: Record<string, { sha256: string }>) {
  const cli = cliHashes(key);
  const names = new Set([...Object.keys(cli), ...Object.keys(browserFiles)]);
  const differ = [...names].filter((n) => cli[n]?.sha256 !== browserFiles[n]?.sha256).sort();
  return { files: names.size, identical: names.size - differ.length, differ };
}

// ---------------------------------------------------------------- one run

type Engine = "chromium" | "firefox" | "webkit";
const launchOpts = (b: Engine) => ({ headless: true, ...(b === "chromium" ? { channel: "chromium" } : {}) });

async function withBrowser<T>(b: Engine, fn: (page: any) => Promise<T>): Promise<T> {
  const profile = mkdtempSync(join(tmpdir(), `s1-${b}-`));
  const ctx = await pw[b].launchPersistentContext(profile, launchOpts(b));
  try {
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    page.on("console", (m: any) => {
      if (m.type() === "error" && !/Failed to load resource/.test(m.text())) console.log(`    [${b} console] ${m.text().slice(0, 300)}`);
    });
    page.on("response", (r: any) => {
      if (r.status() >= 400 && !/favicon|\/api\/ingest\//.test(r.url())) console.log(`    [${b}] HTTP ${r.status()} ${r.url()}`);
    });
    return await fn(page);
  } finally {
    await ctx.close().catch(() => {});
    rmSync(profile, { recursive: true, force: true });
  }
}

async function openSpike(page: any) {
  await page.goto(`${base}/spike-s1.html`);
  await page.waitForFunction(() => (window as any).__s1?.ready === true);
  await page.evaluate(() => (window as any).__s1.clear());
}

async function runOnce(b: Engine, key: number, mode: "compute" | "network") {
  return withBrowser(b, async (page) => {
    let crashed = false;
    page.on("crash", () => (crashed = true));
    await openSpike(page);
    await sleep(2_000); // settle after page load
    const idle = snapshot();
    const sampler = new Sampler();
    sampler.start();
    const load0 = loadavg()[0];
    let row: any;
    let error: string | undefined;
    try {
      row = await page.evaluate(({ key, mode }: { key: number; mode: string }) => (window as any).__s1.run(key, mode), { key, mode });
    } catch (e) {
      error = String(e).slice(0, 500);
    }
    sampler.stop();
    // Content process = the one whose memory grew most (hosts the page and its worker).
    let content: { pid: number; baseline: number; peak: number; hwm: number; delta: number } | null = null;
    for (const [pid, peak] of sampler.peak) {
      if (kind(sampler.cmd.get(pid) ?? "") !== "content") continue;
      const baseline = idle.per.get(pid) ?? 0;
      const top = Math.max(peak, sampler.hwm.get(pid) ?? 0);
      const delta = top - baseline;
      if (!content || delta > content.delta) content = { pid, baseline, peak, hwm: sampler.hwm.get(pid) ?? 0, delta };
    }
    const par = row?.ok ? parity(key, await page.evaluate((k: number) => (window as any).__s1.hashes(k), key)) : null;
    return {
      browser: b,
      key,
      mode,
      row,
      error: error ?? (row && !row.ok ? row.error : undefined),
      crashed,
      loadavgStart: load0,
      loadavgEnd: loadavg()[0],
      mem: {
        contentPid: content?.pid ?? null,
        contentBaselineMB: (content?.baseline ?? 0) / 1024,
        contentPeakMB: Math.max(content?.peak ?? 0, content?.hwm ?? 0) / 1024,
        contentDeltaMB: (content?.delta ?? NaN) / 1024,
        contentProcesses: [...sampler.cmd.values()].filter((c) => kind(c) === "content").length,
        contentCpuS: content ? (sampler.cpu.get(content.pid) ?? NaN) - (idle.cpu.get(content.pid) ?? 0) : NaN,
        allBaselineMB: idle.sum / 1024,
        allPeakMB: sampler.sumPeak / 1024,
        allDeltaMB: (sampler.sumPeak - idle.sum) / 1024,
      },
      parity: par,
    };
  });
}

/**
 * Today's replay UI, loaded by top-level navigation from HTTP and from OPFS in turn (after an ingest into OPFS).
 * `ms`: the `s1:fetchSession` measures (src/data/fetch.ts) from the first load's start to the end of the last
 * one started (React StrictMode runs the startup effect twice in dev). `sinceNavMs`: from navigation start.
 */
async function uiCompare(b: Engine, key: number, rounds = 5) {
  return withBrowser(b, async (page) => {
    await openSpike(page);
    const row = await page.evaluate((k: number) => (window as any).__s1.run(k, "compute"), key);
    if (!row.ok) throw new Error(`ingest failed: ${row.error}`);
    const loads: { source: string; ms: number; sinceNavMs: number }[] = [];
    for (let i = 0; i < rounds; i++) {
      for (const source of ["http", "opfs"]) {
        await page.goto(`${base}/?source=${source}&session=${key}`);
        const handle = await page.waitForFunction(
          () => {
            const w = window as any;
            const ms = performance.getEntriesByName("s1:fetchSession");
            if (!ms.length) return false;
            w.__s1first ??= performance.now();
            if (ms.length < 2 && performance.now() - w.__s1first < 1_000) return false;
            const last = ms.reduce((a, m) => (m.startTime > a.startTime ? m : a));
            return { ms: last.startTime + last.duration - Math.min(...ms.map((m) => m.startTime)), sinceNavMs: last.startTime + last.duration };
          },
          null,
          { timeout: 90_000, polling: 25 },
        );
        loads.push({ source, ...(await handle.jsonValue()) });
      }
    }
    return loads;
  });
}

// ---------------------------------------------------------------- main

async function liveWindowCheck() {
  const res = await fetch("https://api.openf1.org/v1/sessions?session_key=latest");
  const [s] = (await res.json()) as { session_key: number; session_name: string; date_start: string; date_end: string }[];
  const now = Date.now();
  const live = s && now >= Date.parse(s.date_start) - 30 * 60_000 && now <= Date.parse(s.date_end) + 30 * 60_000;
  return { latest: s ? `${s.session_key} ${s.session_name} ${s.date_start} to ${s.date_end}` : "none", live: !!live };
}

function machine() {
  const sh = (c: string) => {
    try {
      return execSync(c, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    } catch {
      return "?";
    }
  };
  return {
    nproc: sh("nproc"),
    cpu: cpus()[0]?.model,
    ramGB: +(totalmem() / 1e9).toFixed(1),
    memAvailableMB: Math.round(Number(/MemAvailable:\s+(\d+)/.exec(readFileSync("/proc/meminfo", "utf8"))?.[1] ?? 0) / 1024),
    kernel: sh("uname -r"),
    os: sh("lsb_release -ds"),
    loadavg: loadavg(),
    playwright: pwVersion,
  };
}

function available(b: Engine) {
  try {
    // chromium runs with channel "chromium": the full build in new headless mode, not the headless shell.
    return existsSync(pw[b].executablePath());
  } catch {
    return false;
  }
}

async function main() {
  await ensureServer();
  const report: any = { startedAt: new Date().toISOString(), machine: machine(), args: { browsers, sessions, runs, networkKey, uiKeys, base }, compute: [], network: [], ui: [], skipped: {} };
  const save = () => writeFileSync(out, JSON.stringify(report, null, 2));

  for (const b of browsers as Engine[]) {
    if (!available(b)) {
      report.skipped[b] = `not installed (${pw[b].executablePath()})`;
      console.log(`${b}: skipped, ${report.skipped[b]}`);
      continue;
    }
    for (const key of sessions) {
      for (let i = 1; i <= runs; i++) {
        const r = await runOnce(b, key, "compute");
        report.compute.push({ ...r, run: i });
        save();
        const t = r.row?.timings;
        console.log(
          `${b} ${key} compute #${i}: ${r.row?.ok ? "ok" : `FAIL ${r.error}`} total ${Math.round(r.row?.totalMs ?? NaN)} ms` +
            (t ? ` (seed ${Math.round(r.row.seedMs)}, read ${Math.round(t.cacheRead)}, normalize ${Math.round(t.normalize)}, encode ${Math.round(t.encode)}, write ${Math.round(t.write)})` : "") +
            ` | content +${Math.round(r.mem.contentDeltaMB)} MB (peak ${Math.round(r.mem.contentPeakMB)}), all +${Math.round(r.mem.allDeltaMB)} MB, CPU ${r.mem.contentCpuS.toFixed(1)} s, load ${r.loadavgStart.toFixed(1)}` +
            ` | long tasks ${r.row?.longTaskSupported ? `${r.row.longTasks}, max ${Math.round(r.row.longestTask)} ms` : "n/a"}, stall ${Math.round(r.row?.maxStall ?? NaN)} ms` +
            ` | parity ${r.parity ? `${r.parity.identical}/${r.parity.files}` : "-"}`,
        );
      }
    }
    for (const uiKey of uiKeys) {
      try {
        const u = await uiCompare(b, uiKey);
        report.ui.push({ browser: b, key: uiKey, loads: u });
        const med = (s: string, f: "ms" | "sinceNavMs") => Math.round(median(u.filter((x) => x.source === s).map((x) => x[f])));
        console.log(
          `${b} replay load ${uiKey} (medians of ${u.length / 2}): HTTP ${med("http", "ms")} ms, OPFS ${med("opfs", "ms")} ms; ` +
            `from navigation start HTTP ${med("http", "sinceNavMs")} ms, OPFS ${med("opfs", "sinceNavMs")} ms`,
        );
      } catch (e) {
        report.ui.push({ browser: b, key: uiKey, error: String(e) });
        console.log(`${b} replay load: FAIL ${e}`);
      }
      save();
    }
  }

  if (networkKey != null) {
    const engines = (browsers as Engine[]).filter(available);
    for (const [i, b] of engines.entries()) {
      const lw = await liveWindowCheck();
      console.log(`live-window check: latest ${lw.latest} -> ${lw.live ? "LIVE, skipping network runs" : "not live"}`);
      if (lw.live) {
        report.network.push({ browser: b, skipped: `live window (${lw.latest})` });
        break;
      }
      if (i > 0) await sleep(65_000); // let the per-minute quota refill between browsers
      else await sleep(3_000);
      const r = await runOnce(b, networkKey, "network");
      report.network.push({ ...r, liveCheck: lw });
      save();
      console.log(
        `${b} ${networkKey} network: ${r.row?.ok ? "ok" : `FAIL ${r.error}`} total ${Math.round((r.row?.totalMs ?? NaN) / 1000)} s, ` +
          `${r.row?.requests} requests, ${r.row?.status429} x 429 | content +${Math.round(r.mem.contentDeltaMB)} MB | parity ${r.parity ? `${r.parity.identical}/${r.parity.files}` : "-"}`,
      );
    }
  }

  report.finishedAt = new Date().toISOString();
  report.machine.loadavgEnd = loadavg();
  save();

  // Medians per browser x session.
  console.log(`\n| browser | session | total | fetch/seed | gunzip+parse | normalize | encode | gzip+write | content peak-idle MB | all procs peak-idle MB | OPFS MB raw+proc | parity |`);
  console.log(`|---|---|---|---|---|---|---|---|---|---|---|---|`);
  for (const b of browsers) {
    for (const key of sessions) {
      const rs = report.compute.filter((r: any) => r.browser === b && r.key === key && r.row?.ok);
      if (!rs.length) continue;
      const m = (f: (r: any) => number) => Math.round(median(rs.map(f)));
      const last = rs.at(-1);
      console.log(
        `| ${b} | ${key} | ${m((r) => r.row.totalMs)} | ${m((r) => r.row.seedMs)} | ${m((r) => r.row.timings.cacheRead)} | ${m((r) => r.row.timings.normalize)} | ` +
          `${m((r) => r.row.timings.encode)} | ${m((r) => r.row.timings.write)} | ${m((r) => r.mem.contentDeltaMB)} | ${m((r) => r.mem.allDeltaMB)} | ` +
          `${(last.row.opfs.raw / 1e6).toFixed(1)}+${(last.row.opfs.processed / 1e6).toFixed(1)} | ${last.parity ? `${last.parity.identical}/${last.parity.files}` : "-"} |`,
      );
    }
  }
  console.log(`\nresults: ${out}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(stopServer);
