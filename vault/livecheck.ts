// The app's live mode through the credential vault, end to end in a browser (`bun run live:check`, about 6 minutes):
// the app with no relay (VITE_LIVE_RELAY=0, as the hosted site) and the vault dev server in simulate mode (a cached
// race replayed as live through the vault's real stream code: vault/src/sim.ts), cross-site as in production.
//
//   bun run live:check              race 11377 (data/raw/11377), from 60 s before lights out
//   LIVE_CHECK_SESSION=11228 ...    another cached session (a free practice, say); LIVE_CHECK_START (s), _HEADED=1
//
// Its own ports (app 5183, vault 5184; LIVE_CHECK_APP_PORT / _VAULT_PORT), so it never picks up another app dev
// server with the relay on. Starts what isn't listening and stops what it started. Screenshots go to
// LIVE_CHECK_SHOTS (default /tmp/pitwall-live-check/<session>).
//
// Checks, in one browser profile (one vault storage, two tabs):
// - /live with no account: the live screen says live needs an OpenF1 account, with a Connect button;
// - Connect there (the vault popup; the simulation takes any email and password): the session fills in through the
//   vault path (no relay): drivers, every car on the map, the live edge moving, then after lights out laps, gaps
//   and race control;
// - a second tab follows too, without logging in again (the vault's one stream for both tabs);
// - the first tab leaves live: its worker is gone, the second keeps streaming; the second leaves: the vault's
//   stream has no topics left (nobody subscribed);
// - mid-session the account disconnects: the session stays on screen and the header asks to connect; connecting
//   again carries on with the same session;
// - OpenF1 refusing the login on a refresh (a dev knob): the reconnect banner shows over the live screen, and live
//   keeps going.
// Then OpenF1's lock (the simulation's VAULT_SIMULATE_LOCK: from 30 min before the session until 30 min after, REST
// from a browser fails as a network error, as OpenF1's refused CORS preflight does; the stream and server-side REST
// go on), in a new browser profile, 15 min into the race (LIVE_CHECK_LOCK_START):
// - joining: a full catch-up (every lap REST has, telemetry back to lights out), through the vault's pass-through
//   (the simulation counts browser requests it refused and pass-through requests it answered);
// - a reload: the same again;
// - a signed-in REST read (what the download worker sends through the vault) answers during the lock.
// LIVE_CHECK_ONLY=lock runs only that part.

import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("..", import.meta.url));
const APP_PORT = Number(process.env.LIVE_CHECK_APP_PORT || 5183);
const VAULT_PORT = Number(process.env.LIVE_CHECK_VAULT_PORT || 5184);
const APP = `http://127.0.0.1:${APP_PORT}`;
const VAULT = `http://localhost:${VAULT_PORT}`;
const SIM = `${VAULT}/__sim`;
const SESSION = Number(process.env.LIVE_CHECK_SESSION || 11377);
const START_S = Number(process.env.LIVE_CHECK_START || -60);
const SHOTS = process.env.LIVE_CHECK_SHOTS || `/tmp/pitwall-live-check/${SESSION}`;
const HEADED = !!process.env.LIVE_CHECK_HEADED;
const ONLY = process.env.LIVE_CHECK_ONLY ?? "";
/** The lock part: from this many seconds after lights out. */
const LOCK_START_S = Number(process.env.LIVE_CHECK_LOCK_START || 900);
/** As vault/e2e.ts: storage partitioning on and every site in its own process, like the Chrome users run. */
const CHROME_AS_SHIPPED = ["--disable-features=Translate,MediaRouter,OptimizationHints,HttpsUpgrades", "--site-per-process"];

function playwright(): any {
  const require = createRequire(import.meta.url);
  for (const d of [process.env.PLAYWRIGHT_DIR, "playwright", "/usr/lib/node_modules/playwright"]) {
    if (!d) continue;
    try {
      return require(d);
    } catch {}
  }
  throw new Error("Playwright not found: set PLAYWRIGHT_DIR or `npm i -g playwright`");
}

const started: ChildProcess[] = [];
const up = async (url: string) => {
  try {
    await fetch(url, { signal: AbortSignal.timeout(1000) });
    return true;
  } catch {
    return false;
  }
};
async function waitUp(url: string, ms = 60_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await up(url)) return;
    await Bun.sleep(250);
  }
  throw new Error(`${url} didn't come up`);
}
function start(cmd: string[], env: Record<string, string>) {
  const p = spawn(cmd[0]!, cmd.slice(1), { cwd: repo, env: { ...process.env, ...env }, stdio: ["ignore", "ignore", "inherit"], detached: true });
  started.push(p);
}

let failures = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${detail !== "" ? `  (${typeof detail === "string" ? detail : JSON.stringify(detail)})` : ""}`);
  if (!ok) failures++;
}

/** Live mode as the app's store has it (window.__replay, dev builds only). */
type Live = {
  mode: string;
  via: string | null;
  account: string | null;
  state: string | null;
  connected: boolean;
  sessionKey: number | null;
  drivers: number;
  onMap: number;
  laps: number;
  intervals: number;
  raceControl: number;
  edge: number;
  lightsOut: number | null;
  practice: boolean;
  /** The earliest location sample of any car (ms since t0), null without any. */
  firstLoc: number | null;
};
const live = (page: any): Promise<Live> =>
  page.evaluate(() => {
    const s = (window as any).__replay.getState();
    const meta = s.session?.meta;
    return {
      mode: s.mode,
      via: s.live.via,
      account: s.live.account,
      state: s.live.state,
      connected: s.live.connected,
      sessionKey: meta?.sessionKey ?? null,
      drivers: meta?.drivers.length ?? 0,
      onMap: s.session ? [...s.session.drivers.values()].filter((d: any) => d.loc.t.length > 0).length : 0,
      laps: meta?.laps.length ?? 0,
      intervals: meta?.intervals.length ?? 0,
      raceControl: meta?.raceControl.length ?? 0,
      edge: s.liveEdge,
      lightsOut: meta && !meta.lightsOutEstimated ? meta.lightsOut : null,
      practice: meta?.practice != null,
      firstLoc: s.session ? Math.min(...[...s.session.drivers.values()].map((d: any) => (d.loc.t.length ? d.loc.t[0] : Infinity))) : null,
    };
  });
const vaultStatus = (page: any) => page.evaluate(() => (window as any).__vault.getState().status);
async function until(what: string, page: any, pred: (l: Live) => boolean, ms: number): Promise<Live> {
  const end = Date.now() + ms;
  let l = await live(page);
  while (!pred(l) && Date.now() < end) {
    await Bun.sleep(500);
    l = await live(page);
  }
  if (!pred(l)) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(l)}`);
  return l;
}
/** Live workers of a page (the app's other workers, downloads, aren't named "live"). */
const liveWorkers = (page: any) => page.workers().filter((w: any) => /\/src\/live\/worker\.ts/.test(w.url())).length;

async function main() {
  // ---------------------------------------------------------------- servers
  if (await up(`${VAULT}/frame.html`)) {
    if (!(await up(`${SIM}/config`))) throw new Error(`a vault server without simulate mode is on ${VAULT}`);
    console.log(`using the simulating vault dev server on ${VAULT}`);
  } else {
    // (Before the app's: both dev servers share node_modules/.vite, and the vault's start invalidates the app's deps.)
    start(["bun", "run", "vault", "--", "--port", String(VAULT_PORT), "--host", "localhost"], {
      VAULT_SIMULATE: String(SESSION),
      VAULT_SIMULATE_START: String(START_S),
      VAULT_APP_ORIGINS: APP,
    });
    await waitUp(`${SIM}/config`, 90_000);
  }
  const reset = await fetch(`${SIM}/control/reset?session=${SESSION}&speed=1&start=${START_S}&token=3600&jitter=0&dropEvery=0&refuseAt=`, { method: "POST" });
  const sim = (await reset.json()) as { label: string; lightsOut: number; end: number };
  console.log(`simulating #${SESSION} ${sim.label} from ${START_S} s, lights out in ${((sim.lightsOut - Date.now()) / 1000).toFixed(0)} s`);
  if (!(await up(APP))) {
    start(["bun", "run", "dev", "--", "--port", String(APP_PORT), "--strictPort", "--host", "127.0.0.1"], { VITE_LIVE_RELAY: "0", VITE_VAULT_ORIGIN: VAULT });
    await waitUp(APP);
  } else console.log(`using the app dev server on ${APP} (it must run with VITE_LIVE_RELAY=0 VITE_VAULT_ORIGIN=${VAULT})`);
  mkdirSync(SHOTS, { recursive: true });

  // ---------------------------------------------------------------- browser
  const { chromium } = playwright();
  if (ONLY && ONLY !== "lock") throw new Error(`LIVE_CHECK_ONLY: "lock" or nothing (got ${ONLY})`);
  const dir = mkdtempSync(join(tmpdir(), "live-check-"));
  const ctx = await chromium.launchPersistentContext(dir, { headless: !HEADED, viewport: { width: 1600, height: 1000 }, args: CHROME_AS_SHIPPED });
  // The vault popup closes itself with window.close(): keep it for the check to close.
  await ctx.addInitScript(`(() => { if (location.origin !== ${JSON.stringify(VAULT)} || !location.pathname.startsWith("/popup")) return; window.close = () => { window.__closed = true; }; })();`);
  const errors: string[] = [];
  const open = async (name: string) => {
    const p = await ctx.newPage();
    p.on("pageerror", (e: Error) => errors.push(`${name}: ${e.message}`));
    p.on("console", (m: any) => {
      if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(`${name}: ${m.text()}`);
    });
    await p.goto(`${APP}/live`);
    await p.waitForFunction(() => !!(window as any).__replay, null, { timeout: 60_000 });
    return p;
  };
  const shot = async (page: any, name: string) => {
    const path = join(SHOTS, `${name}.png`);
    await page.screenshot({ path });
    console.log(`        screenshot: ${path}`);
  };
  const login = async (page: any, click: () => Promise<void>) => {
    const popupP = page.waitForEvent("popup");
    await click();
    const popup = await popupP;
    await popup.locator("#login").waitFor({ timeout: 15_000 });
    await popup.getByLabel("OpenF1 email").fill("live-check@example.invalid");
    await popup.getByLabel("OpenF1 password").fill(`live-check-${Date.now()}`);
    await popup.getByRole("button", { name: "Connect" }).click();
    await popup.waitForFunction(() => (window as any).__closed === true, null, { timeout: 30_000 });
    await popup.close();
  };

  try {
    if (ONLY !== "lock") await basics();
    if (!ONLY || ONLY === "lock") await lock();
  } finally {
    await ctx.close();
    rmSync(dir, { recursive: true, force: true });
  }

  async function basics() {
    // No account: say so, with the way to connect.
    const A = await open("A");
    let l = await until("the account check", A, (x) => x.account === "connect", 30_000);
    check("live goes through the vault (no relay)", l.via === "vault", l.via);
    const says = (await A.getByTestId("live-status").first().textContent()) ?? "";
    check("no account: the live screen says live needs an OpenF1 account", /needs an OpenF1 account/.test(says), says);
    check("...with a Connect button", (await A.getByTestId("live-account-action").count()) === 1);
    await shot(A, "1-no-account");

    // Connect from the live screen: the session fills in.
    await login(A, () => A.getByTestId("live-account-action").click());
    const t0 = Date.now();
    l = await until("the live session", A, (x) => x.state === "live" && x.drivers > 0, 120_000);
    console.log(`        live after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    check("connected: the session streams through the vault", l.connected && l.sessionKey === SESSION, l);
    check("every driver", l.drivers >= 20, l.drivers);
    l = await until("cars on the map", A, (x) => x.onMap >= x.drivers - 2, 30_000);
    check("cars on the track map (telemetry)", l.onMap >= l.drivers - 2, `${l.onMap}/${l.drivers}`);
    const e0 = l.edge;
    await Bun.sleep(6_000);
    l = await live(A);
    check("the live edge moves (about 1 s a second)", l.edge - e0 > 3_000 && l.edge - e0 < 12_000, `${((l.edge - e0) / 1000).toFixed(1)} s in 6 s`);
    check("the LIVE badge", (await A.getByTestId("live-badge").count()) > 0);
    await shot(A, "2-live-pre-race");

    // A second tab: no login, the same stream.
    const B = await open("B");
    l = await until("tab B live", B, (x) => x.state === "live" && x.sessionKey === SESSION && x.onMap > 0, 120_000);
    check("a second tab follows too, without logging in again", l.connected, l);
    const sa = await vaultStatus(A);
    const sb = await vaultStatus(B);
    check("one leader and one follower", new Set([sa.tab?.role, sb.tab?.role]).size === 2, `${sa.tab?.role} / ${sb.tab?.role}`);
    const stats = (await (await fetch(`${SIM}/stats`)).json()) as { current: number; max: number };
    check("at most 2 broker sessions (one stream for both tabs)", stats.max <= 2, stats);

    // A race after lights out and a lap: laps, gaps, race control. Practice (no gaps): laps and race control.
    const lapWait = Math.max(0, sim.lightsOut - Date.now()) + 200_000;
    console.log(`        waiting up to ${(lapWait / 1000).toFixed(0)} s for ${l.practice ? "laps" : "lap 2"}`);
    l = await until("laps", A, (x) => (x.practice ? x.laps > 0 : x.laps >= 2 * x.drivers && x.intervals > 0), lapWait);
    check("laps", l.laps > 0, l.laps);
    if (!l.practice) check("gaps (intervals)", l.intervals > 0, l.intervals);
    check("race control", l.raceControl > 0, l.raceControl);
    check(l.practice ? "practice: the green light known" : "lights out known", l.lightsOut != null, l.lightsOut);
    await Bun.sleep(3_000);
    await shot(A, "3-live-racing");

    // The account goes mid-session: the session stays, the header asks; connecting again carries on.
    await A.evaluate(() => (window as any).__vault.disconnect());
    l = await until("the account gone", A, (x) => x.account === "connect", 15_000);
    check("disconnected mid-session: the session stays on screen", l.sessionKey === SESSION && l.drivers > 0, l);
    check("...the live worker stops", liveWorkers(A) === 0, liveWorkers(A));
    const header = (await A.getByTestId("live-status").first().textContent()) ?? "";
    check("...and the header asks to connect", /needs an OpenF1 account/.test(header), header);
    await shot(A, "4-account-gone");
    await login(A, () => A.getByTestId("live-account-action").first().click());
    const before = (await live(A)).edge;
    l = await until("live again", A, (x) => x.account === null && x.state === "live" && x.connected && x.edge > before, 120_000);
    check("connected again: the same session carries on", l.sessionKey === SESSION, l);
    l = await until("tab B live again", B, (x) => x.state === "live" && x.connected, 120_000);
    check("...in the other tab too", l.sessionKey === SESSION, l);

    // OpenF1 refuses the login on a refresh: the reconnect banner, live goes on.
    await A.evaluate(async () => {
      const v = (window as any).__vault;
      await v.debug.failToken(401, 1);
      await v.debug.refreshNow();
    });
    await A.getByTestId("vault-reauth-banner").waitFor({ timeout: 15_000 }).catch(() => {});
    check("needs reauth: the reconnect banner shows in live mode", await A.getByTestId("vault-reauth-banner").isVisible());
    const e1 = (await live(A)).edge;
    await Bun.sleep(4_000);
    l = await live(A);
    check("...and live keeps going", l.state === "live" && l.edge > e1, l);
    await shot(A, "5-reauth-banner");

    // Leaving live: A's worker goes, B carries on; B leaves: nobody subscribes.
    await A.getByRole("button", { name: "Replays" }).click();
    await A.waitForFunction(() => (window as any).__replay.getState().mode === "replay", null, { timeout: 5_000 });
    await Bun.sleep(1_000);
    check("A left live: its live worker is gone", liveWorkers(A) === 0, liveWorkers(A));
    const eb = (await live(B)).edge;
    await Bun.sleep(4_000);
    check("...B keeps streaming", (await live(B)).edge > eb);
    await B.getByRole("button", { name: "Replays" }).click();
    let topics: string[] = ["?"];
    for (let i = 0; i < 20 && topics.length; i++) {
      await Bun.sleep(500);
      topics = ((await vaultStatus(B))?.stream?.topics as string[]) ?? [];
    }
    check("both left: the vault streams nothing (unsubscribed)", topics.length === 0, topics);
    check("no page errors", errors.length === 0, errors.slice(0, 5));
    await A.close();
    await B.close();
  }

  /** OpenF1's lock: join mid-race and reload inside it, in a browser profile of its own. */
  async function lock() {
    console.log(`OpenF1's lock: ${LOCK_START_S} s after lights out, browsers' REST refused`);
    const cfg = (await (
      await fetch(`${SIM}/control/reset?session=${SESSION}&speed=1&start=${LOCK_START_S}&token=3600&jitter=0&dropEvery=0&refuseAt=&lock=1`, { method: "POST" })
    ).json()) as { start: number; lightsOut: number; lock: { from: number; to: number } | null };
    check("the simulation is inside OpenF1's lock", cfg.lock != null && cfg.start >= cfg.lock.from && cfg.start <= cfg.lock.to, cfg.lock);
    const dir2 = mkdtempSync(join(tmpdir(), "live-check-lock-"));
    const ctx2 = await chromium.launchPersistentContext(dir2, { headless: !HEADED, viewport: { width: 1600, height: 1000 }, args: CHROME_AS_SHIPPED });
    await ctx2.addInitScript(`(() => { if (location.origin !== ${JSON.stringify(VAULT)} || !location.pathname.startsWith("/popup")) return; window.close = () => { window.__closed = true; }; })();`);
    const stats = async () => (await (await fetch(`${SIM}/stats`)).json()) as { restLocked: number; restProxied: number };
    try {
      const C = await ctx2.newPage();
      C.on("pageerror", (e: Error) => errors.push(`C: ${e.message}`));
      await C.goto(`${APP}/live`);
      await C.waitForFunction(() => !!(window as any).__replay, null, { timeout: 60_000 });
      await until("the account check", C, (x) => x.account === "connect", 30_000);
      await login(C, () => C.getByTestId("live-account-action").click());
      const t0 = Date.now();
      let l = await until("the live session", C, (x) => x.state === "live" && x.drivers > 0 && x.laps > 0, 180_000);
      console.log(`        live after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
      // What REST has now (asked the way the download worker asks: the vault's get, here from the page).
      const restLaps = await C.evaluate(async (key: number) => {
        const r = await (window as any).__vault.get("laps", { session_key: key });
        return { status: r.status, auth: r.auth, n: JSON.parse(new TextDecoder().decode(r.body)).length };
      }, SESSION);
      const st = await stats();
      check("joined mid-race inside the lock: the direct REST was refused...", st.restLocked > 0, st);
      check("...and the pass-through answered", st.restProxied > 0, st);
      check("a signed-in REST read (as a download's) answers during the lock", restLaps.status === 200 && restLaps.auth === true, restLaps);
      l = await until("every lap", C, (x) => x.laps >= restLaps.n * 0.9, 60_000).catch(() => live(C));
      check("full catch-up: the laps REST has", l.laps >= restLaps.n * 0.9, `${l.laps} of ${restLaps.n}`);
      check("...and telemetry from lights out", l.firstLoc != null && l.lightsOut != null && l.firstLoc <= l.lightsOut, { firstLoc: l.firstLoc, lightsOut: l.lightsOut });
      check("...and the stream on top (the edge moves)", await moving(C), "");
      await Bun.sleep(3_000);
      await shot(C, "6-lock-joined");

      // A reload mid-race, still inside the lock: the same full catch-up.
      const before = l.laps;
      await C.reload();
      await C.waitForFunction(() => !!(window as any).__replay, null, { timeout: 60_000 });
      l = await until("live after the reload", C, (x) => x.state === "live" && x.laps >= before, 180_000);
      check("reloaded inside the lock: live again, every lap", l.laps >= before, `${l.laps} (before: ${before})`);
      check("...telemetry from lights out", l.firstLoc != null && l.lightsOut != null && l.firstLoc <= l.lightsOut, { firstLoc: l.firstLoc, lightsOut: l.lightsOut });
      check("...and the stream on top", await moving(C), "");
      const header = (await C.getByTestId("live-status").count()) ? await C.getByTestId("live-status").first().textContent() : "";
      check("no retrying or error in the header", !/retrying|error|couldn't/i.test(header ?? ""), header);
      await Bun.sleep(3_000);
      await shot(C, "7-lock-reloaded");
      check("no page errors", errors.length === 0, errors.slice(0, 5));
    } finally {
      await ctx2.close();
      rmSync(dir2, { recursive: true, force: true });
    }
  }
}

/** Whether the live edge moves (about 1 s a second) over 5 s. */
async function moving(page: any): Promise<boolean> {
  const e0 = (await live(page)).edge;
  await Bun.sleep(5_000);
  const e1 = (await live(page)).edge;
  return e1 - e0 > 2_500 && e1 - e0 < 10_000;
}

try {
  await main();
} catch (e) {
  check("finished", false, e instanceof Error ? e.message : String(e));
} finally {
  for (const p of started) {
    try {
      process.kill(-p.pid!, "SIGTERM");
    } catch {}
  }
}
console.log(failures ? `\n${failures} check(s) failed` : "\nall live checks passed");
process.exit(failures ? 1 : 0);
