// Spike S1 page: drives the ingest worker, shows progress and results, and exposes `window.__s1`
// for the Playwright bench (bench.ts).

import type { FromWorker, Mode, RunResult, ToWorker } from "./protocol";

const RAW_BASE = "/__s1/raw";
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// ---------------------------------------------------------------- main-thread responsiveness

// Long tasks (Chromium only), plus a timer-drift monitor that works everywhere: a 50 ms interval
// that fires late means the main thread was busy that long.
const longTaskSupported = typeof PerformanceObserver !== "undefined" && (PerformanceObserver.supportedEntryTypes ?? []).includes("longtask");
const longTasks: { start: number; duration: number }[] = [];
if (longTaskSupported) {
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) longTasks.push({ start: e.startTime, duration: e.duration });
  }).observe({ type: "longtask", buffered: true });
}
let maxStall = 0;
let lastTick = performance.now();
setInterval(() => {
  const now = performance.now();
  maxStall = Math.max(maxStall, now - lastTick - 50);
  lastTick = now;
}, 50);

// ---------------------------------------------------------------- worker calls

const newWorker = () => new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });

/** One request to a fresh worker, resolved with the first reply of type `until`. */
function call<K extends FromWorker["type"]>(msg: ToWorker, until: K, onMessage?: (m: FromWorker) => void): Promise<Extract<FromWorker, { type: K }>> {
  const w = newWorker();
  return new Promise<Extract<FromWorker, { type: K }>>((resolve, reject) => {
    w.onmessage = (e: MessageEvent<FromWorker>) => {
      onMessage?.(e.data);
      if (e.data.type === until) resolve(e.data as Extract<FromWorker, { type: K }>);
      else if (e.data.type === "error") reject(new Error(e.data.message));
    };
    w.onerror = (e) => reject(new Error(e.message || "worker crashed (out of memory?)"));
    w.postMessage(msg);
  }).finally(() => w.terminate());
}

const mb = (b: number) => (b / 1e6).toFixed(1);

async function storageInfo() {
  const est = await navigator.storage?.estimate?.();
  const persisted = await navigator.storage?.persisted?.();
  return { usage: est?.usage ?? null, quota: est?.quota ?? null, persisted: persisted ?? null };
}

// ---------------------------------------------------------------- runs

export interface RunRow extends RunResult {
  /** Wall time seen by the page (includes worker startup). */
  pageMs: number;
  longTaskSupported: boolean;
  longTasks: number;
  longTasksOver200: number;
  longestTask: number;
  maxStall: number;
  opfs: { raw: number; processed: number; rawFiles: number; processedFiles: number };
  storage: { usage: number | null; quota: number | null; persisted: boolean | null };
  persist: boolean | null;
}
const results: RunRow[] = [];
const uiResults: { key: number; source: string; ms: number; error?: string }[] = [];
let persistResult: boolean | null = null;
let busy = false;

function setBusy(b: boolean) {
  busy = b;
  for (const id of ["run", "ui", "clear"]) $<HTMLButtonElement>(id).disabled = b;
}

const logEl = () => $<HTMLPreElement>("log");
function log(line: string, cls = "") {
  const div = document.createElement("div");
  div.textContent = line;
  if (cls) div.className = cls;
  logEl().append(div);
  while (logEl().childElementCount > 200) logEl().firstElementChild!.remove();
  logEl().scrollTop = logEl().scrollHeight;
}

async function run(key: number, mode: Mode): Promise<RunRow> {
  if (busy) throw new Error("already running");
  setBusy(true);
  logEl().replaceChildren();
  try {
    // persist() needs a user gesture in some browsers; the result is recorded either way.
    persistResult = (await navigator.storage?.persist?.().catch(() => null)) ?? null;
    const lt0 = longTasks.length;
    maxStall = 0;
    const t0 = performance.now();
    let rawDone = 0;
    let expected = 58;
    let phase = mode === "compute" ? "seeding OPFS" : "downloading";
    let reqs = 0;
    let r429 = 0;
    const status = () => {
      const s = ((performance.now() - t0) / 1000).toFixed(1);
      $("status").textContent = `${phase} · ${rawDone}/${expected} raw files · ${reqs} requests · ${r429} × 429 · ${s} s`;
    };
    const timer = setInterval(status, 250);
    const bar = $("progress");
    const done = await call({ type: "run", key, mode, rawBase: RAW_BASE }, "done", (m) => {
      if (m.type === "log") log(m.line, m.warn ? "warn" : "");
      else if (m.type === "seed") {
        bar.style.width = `${(m.done / m.total) * 30}%`;
        expected = m.total;
      } else if (m.type === "request") {
        reqs = m.requests;
        r429 = m.status429;
        if (m.status === 429) log(`429 from OpenF1 (retrying with backoff)`, "warn");
      } else if (m.type === "event") {
        if (m.e.kind === "raw") {
          rawDone++;
          const base = mode === "compute" ? 30 : 0;
          bar.style.width = `${base + Math.min(1, rawDone / expected) * (mode === "compute" ? 30 : 85)}%`;
        } else {
          phase = m.e.phase === "download" ? (mode === "compute" ? "reading raw cache" : "downloading") : m.e.phase === "done" ? "finishing" : m.e.phase;
          if (m.e.phase === "normalize") bar.style.width = mode === "compute" ? "65%" : "88%";
          if (m.e.phase === "write") bar.style.width = mode === "compute" ? "85%" : "95%";
        }
      }
    });
    clearInterval(timer);
    const pageMs = performance.now() - t0;
    const lts = longTasks.slice(lt0);
    const usage = await call({ type: "usage", key }, "usage");
    const row: RunRow = {
      ...done.result,
      pageMs,
      longTaskSupported,
      longTasks: lts.length,
      longTasksOver200: lts.filter((t) => t.duration > 200).length,
      longestTask: Math.max(0, ...lts.map((t) => t.duration)),
      maxStall,
      opfs: { raw: usage.raw, processed: usage.processed, rawFiles: usage.rawFiles, processedFiles: usage.processedFiles },
      storage: await storageInfo(),
      persist: persistResult,
    };
    results.push(row);
    bar.style.width = "100%";
    $("status").innerHTML = "";
    $("status").append(
      row.ok ? `Done in ${(row.totalMs / 1000).toFixed(1)} s. ` : `Failed: ${row.error} `,
      ...(row.ok ? [Object.assign(document.createElement("a"), { href: `/?source=opfs&session=${key}`, textContent: "Open the replay from OPFS" })] : []),
    );
    $("status").className = row.ok ? "ok" : "bad";
    render();
    return row;
  } finally {
    setBusy(false);
  }
}

// ---------------------------------------------------------------- replay load: HTTP vs OPFS

/**
 * Load today's replay UI in an iframe and time its session load (`s1:fetchSession` measures, see
 * src/data/fetch.ts): from the first load's start to the end of the last one started. In dev, React
 * StrictMode runs the app's startup effect twice, so two loads overlap and the later one is kept.
 */
async function uiLoad(key: number, source: "http" | "opfs", timeoutMs = 90_000): Promise<number> {
  const frame = document.createElement("iframe");
  frame.style.cssText = "position:fixed;left:0;top:0;width:1280px;height:800px;opacity:0;pointer-events:none;border:0";
  frame.src = `/?source=${source}&session=${key}`;
  document.body.append(frame);
  try {
    const t0 = performance.now();
    let firstSeen = 0;
    for (;;) {
      const win = frame.contentWindow as (Window & typeof globalThis) | null;
      const ms = win?.performance.getEntriesByName("s1:fetchSession") ?? [];
      if (ms.length && !firstSeen) firstSeen = performance.now();
      if (ms.length >= 2 || (firstSeen && performance.now() - firstSeen > 1_000)) {
        const last = ms.reduce((a, b) => (b.startTime > a.startTime ? b : a));
        return last.startTime + last.duration - Math.min(...ms.map((m) => m.startTime));
      }
      const err = win?.document.body?.innerText.match(/Failed to load session[^\n]*/)?.[0];
      if (err) throw new Error(err);
      if (performance.now() - t0 > timeoutMs) throw new Error(`timed out loading the replay (${source})`);
      await new Promise((r) => setTimeout(r, 25));
    }
  } finally {
    frame.remove();
  }
}

async function compareUi(key: number, rounds = 3) {
  const out: { key: number; source: string; ms: number; error?: string }[] = [];
  for (let i = 0; i < rounds; i++) {
    for (const source of ["http", "opfs"] as const) {
      try {
        out.push({ key, source, ms: await uiLoad(key, source) });
      } catch (e) {
        out.push({ key, source, ms: NaN, error: String(e) });
      }
    }
  }
  uiResults.push(...out);
  render();
  return out;
}

// ---------------------------------------------------------------- rendering

function cells(tr: HTMLTableRowElement, values: (string | number)[], tag: "td" | "th" = "td") {
  for (const v of values) {
    const c = document.createElement(tag);
    c.textContent = typeof v === "number" ? (Number.isFinite(v) ? String(Math.round(v)) : "-") : v;
    tr.append(c);
  }
}

function render() {
  const t = $<HTMLTableElement>("results");
  t.replaceChildren();
  if (results.length) {
    cells(t.insertRow(), ["#", "session", "mode", "total", "fetch", "gunzip+parse", "normalize", "encode", "gzip+write", "req", "429", "OPFS MB raw+proc", "long tasks (>200)", "max stall", "status"], "th");
    results.forEach((r, i) => {
      const tr = t.insertRow();
      const fetchMs = r.mode === "compute" ? r.seedMs : r.timings.fetch + r.timings.rawWrite;
      cells(tr, [
        String(i + 1), String(r.key), r.mode, r.totalMs, fetchMs, r.timings.cacheRead, r.timings.normalize, r.timings.encode, r.timings.write,
        String(r.requests), String(r.status429), `${mb(r.opfs.raw)}+${mb(r.opfs.processed)}`,
        r.longTaskSupported ? `${r.longTasks} (${r.longTasksOver200})` : "n/a", r.maxStall, r.ok ? "ok" : (r.error ?? "failed"),
      ]);
      tr.lastElementChild!.className = r.ok ? "ok l" : "bad l";
    });
  }
  const u = $<HTMLTableElement>("uiResults");
  u.replaceChildren();
  if (uiResults.length) {
    cells(u.insertRow(), ["replay load", "source", "ms", "error"], "th");
    for (const r of uiResults) cells(u.insertRow(), [String(r.key), r.source, r.ms, r.error ?? ""]);
  }
}

async function renderEnv() {
  const s = await storageInfo();
  const has = (o: object | undefined, k: string) => (o && k in o ? "yes" : "no");
  const nav = navigator as Navigator & { deviceMemory?: number };
  const rows: [string, string][] = [
    ["User agent", navigator.userAgent],
    ["Cores / memory", `${navigator.hardwareConcurrency ?? "?"} cores${nav.deviceMemory ? `, ~${nav.deviceMemory} GB` : ""}`],
    ["Secure context", isSecureContext ? "yes" : "NO: OPFS needs https or localhost"],
    ["OPFS", has(navigator.storage, "getDirectory")],
    ["createWritable / move", `${has(globalThis.FileSystemFileHandle?.prototype, "createWritable")} / ${has(globalThis.FileSystemHandle?.prototype, "move")}`],
    ["CompressionStream", typeof CompressionStream === "function" ? "yes" : "no"],
    ["Long-task API", longTaskSupported ? "yes" : "no (timer-drift monitor only)"],
    ["Storage used / quota", s.usage != null ? `${mb(s.usage)} MB / ${s.quota != null ? `${(s.quota / 1e9).toFixed(1)} GB` : "?"}` : "unknown"],
    ["persisted() / persist()", `${s.persisted} / ${persistResult ?? "not asked yet"}`],
  ];
  const dl = $("env");
  dl.replaceChildren();
  for (const [k, v] of rows) dl.append(Object.assign(document.createElement("dt"), { textContent: k }), Object.assign(document.createElement("dd"), { textContent: v }));
}

async function clearOpfs() {
  await call({ type: "clear" }, "cleared");
  await renderEnv();
}

function exportJson() {
  return JSON.stringify({ userAgent: navigator.userAgent, hardwareConcurrency: navigator.hardwareConcurrency, results, uiResults }, null, 2);
}

// ---------------------------------------------------------------- wiring

const keyOf = () => Number($<HTMLInputElement>("key").value);
$("run").onclick = () => run(keyOf(), $<HTMLSelectElement>("mode").value as Mode).catch((e) => log(String(e), "bad")).finally(renderEnv);
$("ui").onclick = async () => {
  setBusy(true);
  $("status").textContent = "Loading the replay UI from HTTP and from OPFS, 3 times each…";
  try {
    const r = await compareUi(keyOf());
    const med = (src: string) => r.filter((x) => x.source === src).map((x) => x.ms).sort((a, b) => a - b)[1];
    $("status").textContent = `Replay load median: HTTP ${Math.round(med("http"))} ms, OPFS ${Math.round(med("opfs"))} ms.`;
  } finally {
    setBusy(false);
  }
};
$("clear").onclick = () => clearOpfs().then(() => log("OPFS cleared."));
$("copy").onclick = async () => {
  const text = exportJson();
  try {
    await navigator.clipboard.writeText(text);
    log("Results copied.");
  } catch {
    // Clipboard blocked (e.g. insecure context): show the JSON to copy by hand.
    logEl().textContent = text;
  }
};

renderEnv();
render();

declare global {
  interface Window {
    __s1: {
      ready: boolean;
      run: typeof run;
      clear: typeof clearOpfs;
      compareUi: typeof compareUi;
      usage: (key: number) => Promise<Extract<FromWorker, { type: "usage" }>>;
      hashes: (key: number) => Promise<Record<string, { sha256: string; bytes: number }>>;
      storage: typeof storageInfo;
      exportJson: typeof exportJson;
    };
  }
}
window.__s1 = {
  ready: true,
  run,
  clear: clearOpfs,
  compareUi,
  usage: (key) => call({ type: "usage", key }, "usage"),
  hashes: async (key) => (await call({ type: "hashes", key }, "hashes")).files,
  storage: storageInfo,
  exportJson,
};
