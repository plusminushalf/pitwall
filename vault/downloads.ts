// Step 6's browser check (`bun run vault:e2e`, or only this with `--downloads`; about 6 minutes): race 11377
// downloaded into the browser three ways, with the real OpenF1 login from .env where it's signed in:
//   1. direct: no login, the worker fetches from OpenF1 itself at the free tier's pace (as before);
//   2. through the vault: signed in, the worker's requests go to the vault over its own port and run in parallel
//      within the vault's budget (6/s, 60/min); mid-download, the worker's heap is searched for a token;
//   3. through the vault, which then goes away mid-download (its server is stopped and its frame's renderer
//      crashed): the worker notices (its pings go unanswered) and finishes directly.
// Checks: each run completes; the processed output (every file, decompressed) is identical in all three, and to
// the CLI's (bun scripts/ingest.ts on a copy of data/raw/11377) when OpenF1 returned the same raw data; the vault path is signed in, has no
// 429 and is faster than the direct one; the fallback happens and nothing fails; the worker never holds a
// token or the password; the app-origin leak check (heap + storage) is clean. It prints the timings.

import { execFileSync, execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

export type DownloadHelpers = {
  chromium: any;
  repo: string;
  APP: string;
  VAULT: string;
  launchArgs: string[];
  appHmr: RegExp;
  keepAppLoaded: (ws: any) => void;
  keepPopup: string;
  check: (name: string, ok: boolean, detail?: unknown) => void;
  up: (url: string) => Promise<boolean>;
  waitUp: (url: string, ms?: number) => Promise<void>;
  start: (cmd: string[], env?: Record<string, string>) => any;
  stop: (p: any) => void;
  findAppSecrets: (page: any, secrets: string[]) => Promise<{ findings: { what: string; where: string }[]; scanned: Record<string, number> }>;
  findInHeap: (target: any, secrets: string[]) => Promise<{ what: string; where: string }[]>;
  findInWorker: (page: any, urlPart: string, secrets: string[]) => Promise<{ findings: { what: string; where: string }[]; bytes: number } | null>;
  openPopup: (context: any, page: any, testId: "vault-connect") => Promise<any>;
  submitLogin: (popup: any, user: string, pass: string) => Promise<void>;
  waitState: (page: any, want: string, ms?: number) => Promise<void>;
  waitClosed: (popup: any, ms?: number) => Promise<void>;
  username: string;
  password: string;
  headed: boolean;
};

const KEY = 11377;
const REST_PREFIX = "https://api.openf1.org/v1/";
const DONE = new RegExp(`\\[ingest ${KEY}\\] .*: download done in ([\\d.]+)s \\((\\d+) requests, (\\d+) rate-limited\\)`);
const DOWNLOAD_MS = 8 * 60_000;

type Hashes = { processed: Record<string, string>; raw: Record<string, string> };
type Run = {
  label: string;
  totalS: number;
  downloadS: number;
  requests: number;
  workerRateLimited: number;
  vaultRest: number;
  directRest: number;
  rest429: { vault: number; direct: number };
  paths: string[];
  hashes: Hashes;
  budget: { inFlight: number; queued: number; used: number; rateLimited: number } | null;
  errors: string[];
};

const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

/**
 * The CLI (`bun scripts/ingest.ts`, as `bun run ingest` runs it) on a copy of data/raw/<key> in a scratch
 * directory, so data/ isn't touched and no request is made: its processed files' hashes, and the raw ones.
 */
function reference(repo: string): Hashes | null {
  const src = join(repo, "data", "raw", String(KEY));
  if (!existsSync(join(src, "sessions.json.gz"))) return null;
  const scratch = mkdtempSync(join(tmpdir(), "vault-e2e-cli-"));
  try {
    cpSync(src, join(scratch, "data", "raw", String(KEY)), { recursive: true });
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("OPENF1_")));
    execFileSync("bun", [join(repo, "scripts", "ingest.ts"), String(KEY)], { cwd: scratch, env, stdio: ["ignore", "ignore", "inherit"] });
    const hashTree = (dir: string, prefix = ""): Record<string, string> => {
      const out: Record<string, string> = {};
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) Object.assign(out, hashTree(join(dir, e.name), `${prefix}${e.name}/`));
        else if (e.name.endsWith(".json")) out[`${prefix}${e.name}`] = sha(readFileSync(join(dir, e.name)));
      }
      return out;
    };
    const raw: Record<string, string> = {};
    for (const f of readdirSync(src)) if (f.endsWith(".json.gz")) raw[f.slice(0, -3)] = sha(gunzipSync(readFileSync(join(src, f))));
    return { processed: hashTree(join(scratch, "data", "sessions", String(KEY))), raw };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** In the app page: every processed and raw file of the session in OPFS, decompressed, hashed. */
function opfsHashes(key: number): Promise<Hashes> {
  const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
  const walk = async (dir: FileSystemDirectoryHandle, path: string, out: [string, FileSystemFileHandle][]) => {
    for await (const [name, h] of (dir as any).entries() as AsyncIterable<[string, FileSystemHandle]>) {
      if (h.kind === "directory") await walk(h as FileSystemDirectoryHandle, `${path}${name}/`, out);
      else out.push([`${path}${name}`, h as FileSystemFileHandle]);
    }
  };
  const hashAll = async (dir: FileSystemDirectoryHandle) => {
    const files: [string, FileSystemFileHandle][] = [];
    await walk(dir, "", files);
    const out: Record<string, string> = {};
    for (const [p, h] of files) {
      if (!p.endsWith(".gz")) continue;
      const text = await new Response((await h.getFile()).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
      out[p.slice(0, -3)] = hex(await crypto.subtle.digest("SHA-256", text));
    }
    return out;
  };
  return (async () => {
    const root = await navigator.storage.getDirectory();
    const sub = async (name: string) => (await root.getDirectoryHandle(name)).getDirectoryHandle(String(key));
    return { processed: await hashAll(await sub("sessions")), raw: await hashAll(await sub("raw")) };
  })();
}

export async function runDownloads(h: DownloadHelpers): Promise<void> {
  const { check } = h;
  console.log(`downloads: race ${KEY} direct (no login), through the vault (the real login), and with the vault gone mid-download`);

  if (!(await h.up(h.APP))) {
    console.log(`starting the app dev server on ${h.APP}`);
    h.start(["bun", "run", "dev", "--", "--port", "5173", "--strictPort"], { VITE_VAULT_ORIGIN: h.VAULT });
    await h.waitUp(h.APP);
  }
  if (await h.up(`${h.VAULT}/frame.html`)) {
    check(`downloads need :5174 free (this run starts the production vault there and stops it mid-download)`, false, "something else is serving it");
    return;
  }
  execSync("bun run vault:build", { cwd: h.repo, stdio: ["ignore", "ignore", "inherit"] });
  let vault = h.start(["bun", "vault/serve.ts"]);
  await h.waitUp(`${h.VAULT}/frame.html`);

  console.log("downloads: the CLI (bun scripts/ingest.ts) on a copy of the raw cache, for reference");
  let ref: Hashes | null = null;
  try {
    ref = reference(h.repo);
  } catch (e) {
    check("the CLI processes the raw cache", false, e instanceof Error ? e.message : String(e));
  }

  const runs: Run[] = [];
  const dirs: string[] = [];
  const pageErrors: string[] = [];

  const launch = async () => {
    const dir = mkdtempSync(join(tmpdir(), "vault-e2e-dl-"));
    dirs.push(dir);
    const ctx = await h.chromium.launchPersistentContext(dir, { headless: !h.headed, viewport: { width: 1280, height: 800 }, args: h.launchArgs });
    await ctx.routeWebSocket(h.appHmr, h.keepAppLoaded);
    await ctx.addInitScript(h.keepPopup);
    return ctx;
  };

  /** Home with the vault's debug panel (it puts the vault client on window.__vault); signed in if asked. */
  const home = async (ctx: any, login: boolean) => {
    const page = await ctx.newPage();
    page.on("pageerror", (e: Error) => pageErrors.push(e.message));
    await page.goto(`${h.APP}/?vault=debug`);
    await h.waitState(page, "disconnected");
    if (login) {
      const popup = await h.openPopup(ctx, page, "vault-connect");
      await h.submitLogin(popup, h.username, h.password);
      await h.waitClosed(popup);
      await h.waitState(page, "connected");
      await popup.close();
    }
    await page.waitForFunction(() => !!(window as any).__vault, null, { timeout: 5000 });
    return page;
  };

  /** Start the download from the shared-link prompt and follow it to the end. `during`: called on every poll. */
  const download = async (ctx: any, page: any, label: string, during?: (n: { vault: number; direct: number }) => Promise<void>): Promise<Run> => {
    const counts = { vault: 0, direct: 0, v429: 0, d429: 0, on: false };
    const onResponse = (r: any) => {
      // The download's requests (the calendar's `year=` ones are the page's own, always direct).
      if (!counts.on || !r.url().startsWith(REST_PREFIX) || r.url().includes("year=")) return;
      let fromVault = false;
      try {
        fromVault = r.frame().url().startsWith(`${h.VAULT}/frame.html`);
      } catch {}
      if (fromVault) {
        counts.vault++;
        if (r.status() === 429) counts.v429++;
      } else {
        counts.direct++;
        if (r.status() === 429) counts.d429++;
      }
    };
    ctx.on("response", onResponse);
    let done: RegExpExecArray | null = null;
    const errors: string[] = [];
    page.on("console", (m: any) => {
      const text = m.text();
      const d = DONE.exec(text);
      if (d) done = d;
      if (m.type() === "error" && /ingest|download/i.test(text)) errors.push(text.slice(0, 200));
    });
    await page.evaluate((key: number) => {
      history.pushState({}, "", `/?session=${key}&vault=debug`);
      dispatchEvent(new PopStateEvent("popstate"));
    }, KEY);
    await page.getByRole("button", { name: "Download this race" }).click({ timeout: 30_000 });
    counts.on = true;
    const t0 = Date.now();
    let processingAt = 0;
    const paths: string[] = [];
    const peak = { inFlight: 0, queued: 0, used: 0, rateLimited: 0 };
    let sawBudget = false;
    while (!done && Date.now() - t0 < DOWNLOAD_MS) {
      const snap = await page
        .evaluate(() => ({ text: document.body.innerText, budget: (window as any).__vault?.getState().status?.budget ?? null }))
        .catch(() => ({ text: "", budget: null }));
      for (const p of ["fast (signed in)", "free tier"]) if (snap.text.includes(p) && paths.at(-1) !== p) paths.push(p);
      if (!processingAt && /Processing|Saving to this browser/.test(snap.text)) processingAt = Date.now();
      const b = snap.budget as { inFlight: number; queued: number; usedThisMinute: number; rateLimited: number } | null;
      if (b) {
        sawBudget = true;
        peak.inFlight = Math.max(peak.inFlight, b.inFlight);
        peak.queued = Math.max(peak.queued, b.queued);
        peak.used = Math.max(peak.used, b.usedThisMinute);
        peak.rateLimited = Math.max(peak.rateLimited, b.rateLimited);
      }
      // A failed attempt shows as "Interrupted (…); trying again" (the library retries it): a user-visible failure.
      const failed = /Interrupted \([^)]*\)/.exec(snap.text);
      if (failed && !errors.includes(failed[0])) errors.push(failed[0]);
      await during?.({ vault: counts.vault, direct: counts.direct });
      await Bun.sleep(250);
    }
    ctx.off("response", onResponse);
    const d = done as RegExpExecArray | null;
    const run: Run = {
      label,
      totalS: d ? Number(d[1]) : NaN,
      downloadS: processingAt ? (processingAt - t0) / 1000 : NaN,
      requests: d ? Number(d[2]) : 0,
      workerRateLimited: d ? Number(d[3]) : 0,
      vaultRest: counts.vault,
      directRest: counts.direct,
      rest429: { vault: counts.v429, direct: counts.d429 },
      paths,
      hashes: d ? await page.evaluate(opfsHashes, KEY) : { processed: {}, raw: {} },
      budget: sawBudget ? peak : null,
      errors,
    };
    runs.push(run);
    check(`${label}: the download completes`, !!d, d ? `${run.totalS.toFixed(1)} s` : `not done after ${DOWNLOAD_MS / 1000} s; ${errors.join(" | ")}`);
    return run;
  };

  try {
    // 1. Direct: no login.
    {
      const ctx = await launch();
      try {
        const page = await home(ctx, false);
        const r = await download(ctx, page, "direct (no login)");
        check("direct: the free tier, straight from the worker (no request through the vault)", r.paths.join(",") === "free tier" && r.vaultRest === 0 && r.directRest >= 57, `${r.paths.join(" -> ")}; ${r.directRest} direct, ${r.vaultRest} via the vault`);
        check("direct: no 429 (the free tier's pacing, with room for the page's own requests)", r.rest429.direct === 0, `${r.rest429.direct} 429s`);
      } finally {
        await ctx.close();
      }
    }

    // 2. Through the vault, signed in; the worker's heap is searched mid-download.
    let workerLeak: { findings: { what: string; where: string }[]; bytes: number } | null = null;
    let vaultControl: { what: string }[] = [];
    {
      const ctx = await launch();
      try {
        const page = await home(ctx, true);
        let searched = false;
        const r = await download(ctx, page, "through the vault (signed in)", async (n) => {
          if (searched || n.vault < 25) return;
          searched = true;
          workerLeak = await h.findInWorker(page, "ingest/worker", [h.password]);
          const frame = page.frames().find((f: any) => f.url().startsWith(`${h.VAULT}/frame.html`));
          vaultControl = frame ? await h.findInHeap(frame, [h.password]) : [];
        });
        check("vault: signed in, every OpenF1 request through the vault frame, in parallel", r.paths.join(",") === "fast (signed in)" && r.vaultRest >= 57 && r.directRest === 0 && (r.budget?.inFlight ?? 0) > 1, `${r.paths.join(" -> ")}; ${r.vaultRest} via the vault, ${r.directRest} direct; peak ${r.budget?.inFlight} in flight, ${r.budget?.queued} queued, ${r.budget?.used} used in a minute`);
        check("vault: no 429 from OpenF1 (the budget kept to the account's limits)", r.rest429.vault === 0 && (r.budget?.rateLimited ?? 0) === 0, `${r.rest429.vault} 429s seen, the budget counted ${r.budget?.rateLimited ?? "?"}`);
        const w = workerLeak as { findings: { what: string; where: string }[]; bytes: number } | null;
        check("the download worker never held a token or the password (its heap mid-download, searched for them and for eyJhbGciOi)", !!w && w.findings.length === 0 && w.bytes > 1e5, w ? `${(w.bytes / 1e6).toFixed(1)} MB heap; ${w.findings.map((f) => f.what).join(", ") || "nothing found"}` : "no worker target found");
        check("control: the same search finds a JWT in the vault frame's heap", vaultControl.some((f) => f.what === "jwt"), vaultControl.map((f) => f.what).join(", "));
        const report = await h.findAppSecrets(page, [h.password]);
        const heap = report.scanned["heap snapshot (app main frame)"] ?? 0;
        check(`after the vault download: no password or JWT readable from the app origin (heap ${(heap / 1e6).toFixed(1)} MB + ${Object.keys(report.scanned).length - 1} storage places, the race's OPFS files included)`, report.findings.length === 0 && heap > 1e6, report.findings.map((f) => `${f.what} in ${f.where}`).join("; "));
      } finally {
        await ctx.close();
      }
    }

    // 3. Through the vault, which goes away mid-download.
    {
      const ctx = await launch();
      try {
        const page = await home(ctx, true);
        let killedAt = -1;
        const r = await download(ctx, page, "vault gone mid-download", async (n) => {
          if (killedAt >= 0 || n.vault < 15) return;
          killedAt = n.vault;
          // The vault's server goes, and its frame with it (a loaded frame doesn't need its server: crash its renderer).
          h.stop(vault);
          const frame = page.frames().find((f: any) => f.url().startsWith(`${h.VAULT}/frame.html`));
          if (frame) {
            const cdp = await page.context().newCDPSession(frame);
            void cdp.send("Page.crash").catch(() => {});
          }
          console.log(`  (stopped the vault server and crashed its frame after ${n.vault} requests through it)`);
        });
        check("vault gone: the worker fell back to the direct path and finished (no failure, the rest direct, no 429)", killedAt > 0 && r.paths.join(",") === "fast (signed in),free tier" && r.directRest > 0 && r.errors.length === 0 && r.rest429.direct + r.rest429.vault === 0, `${r.paths.join(" -> ")}; ${r.vaultRest} via the vault, then ${r.directRest} direct, ${r.rest429.direct + r.rest429.vault} 429s${r.errors.length ? `; ${r.errors.join(" | ")}` : ""}`);
      } finally {
        await ctx.close();
      }
    }

    // ---------------------------------------------------------------- the comparison
    const [direct, viaVault, gone] = runs;
    const same = (a: Record<string, string>, b: Record<string, string>) => Object.keys(a).length > 0 && Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([k, v]) => b[k] === v);
    const files = Object.keys(direct?.hashes.processed ?? {}).length;
    check(`identical processed output: direct, through the vault, and with the fallback (${files} files, decompressed)`, !!direct && !!viaVault && !!gone && same(direct.hashes.processed, viaVault.hashes.processed) && same(direct.hashes.processed, gone.hashes.processed));
    if (ref && direct) {
      const rawSame = same(ref.raw, direct.hashes.raw);
      if (rawSame) check("identical to the CLI's processing of the raw cache (the same raw responses)", same(ref.processed, direct.hashes.processed));
      else console.log(`  (the raw cache in data/raw/${KEY} differs from what OpenF1 returned today, so the CLI's output isn't compared: ${Object.keys(ref.raw).filter((k) => ref.raw[k] !== direct.hashes.raw[k]).slice(0, 5).join(", ")})`);
    }
    if (direct && viaVault) check("through the vault is faster than direct", viaVault.totalS < direct.totalS, `${viaVault.totalS.toFixed(1)} s vs ${direct.totalS.toFixed(1)} s`);
    check("downloads: no page errors", pageErrors.length === 0, pageErrors.slice(0, 5).join(" | "));

    console.log("\n  downloads (race 11377; total = worker start to stored, processing included)");
    console.log(`  ${"run".padEnd(32)} ${"path".padEnd(28)} ${"total".padStart(8)} ${"to process".padStart(11)} ${"requests".padStart(9)} ${"via vault".padStart(10)} ${"direct".padStart(7)} ${"429".padStart(5)}`);
    for (const r of runs)
      console.log(
        `  ${r.label.padEnd(32)} ${r.paths.join(" -> ").padEnd(28)} ${`${r.totalS.toFixed(1)} s`.padStart(8)} ${`${r.downloadS.toFixed(1)} s`.padStart(11)} ${String(r.requests).padStart(9)} ${String(r.vaultRest).padStart(10)} ${String(r.directRest).padStart(7)} ${String(r.rest429.vault + r.rest429.direct).padStart(5)}`,
      );
    if (viaVault?.budget) console.log(`  vault budget during run 2: peak ${viaVault.budget.inFlight} in flight, ${viaVault.budget.queued} queued, ${viaVault.budget.used} started in a minute, ${viaVault.budget.rateLimited} rate-limited`);
  } catch (e) {
    check("downloads run", false, e instanceof Error ? (e.stack ?? e.message) : String(e));
  } finally {
    h.stop(vault);
    vault = null;
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    for (let i = 0; i < 50 && (await h.up(`${h.VAULT}/frame.html`)); i++) await Bun.sleep(100);
  }
}
