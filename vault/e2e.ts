// Browser check of the credential vault (spike S3), cross-SITE like production: the app on
// http://127.0.0.1:5173 and the vault on http://localhost:5174 (different sites: 127.0.0.1 vs localhost).
//
//   bun run vault:e2e            the built vault (vault:build, then serve.ts: the exact production headers)
//   bun run vault:e2e --dev      the vault dev server instead (bun run vault)
//   bun run vault:e2e --headed
//   bun run vault:e2e --quick    skip the step-3 refresh run (about 5 minutes of real token refreshes)
//   bun run vault:e2e --s3       ONLY spike S3's success check (s3.ts): a simulated 2.1 h session at 6x (about
//                                22 minutes) across two tabs, with drops, a refusal, a late pit stop in an outage,
//                                a leader close, a reload and a leader freeze; then the leak check. Needs
//                                data/raw/11291 (bun run ingest 11291).
//   bun run vault:e2e --downloads  ONLY step 6's download check (downloads.ts, about 6 minutes, the real login):
//                                race 11377 direct, through the vault, and with the vault gone mid-download.
//
// Starts whatever isn't already listening (the app dev server, the vault) and stops what it started.
// A port-5174 server that is already running is used as is. Playwright isn't a project dependency: it's
// found via $PLAYWRIGHT_DIR, a local install, or the global one (npm root -g, /usr/lib/node_modules).
//
// Checks: handshake + `status` round trip; zero CSP violations in the vault frame and popup; a
// non-allowed origin can't frame the vault (directly, or by framing the app); hello from a wrong origin or
// a wrong window is ignored; the app works with the vault server down.
// Step 2 (login): the popup login with a wrong password, a 429 and a network error (both faked with a
// route), then the real login from .env (OPENF1_USERNAME / OPENF1_PASSWORD; typed into the popup, never
// printed); storage partitioning; silent restore on reload and after a browser restart (persistent
// profile); disconnect wipes; passkey mode on a CDP virtual authenticator (PRF), locked -> unlock; an
// authenticator without PRF falls back to stay-connected; and the secret-leak check (leakcheck.ts) from
// the app's origin after every login.
// Step 3 (refresh): the production build has no dev knobs (debug methods are unknown types, none of
// debug.ts is in dist/); `get` works unauthenticated without a login and authenticated with one. Then,
// against the vault dev server with VAULT_FAKE_EXPIRES_IN=120 and the real API: spoilToken -> a real
// OpenF1 401 -> refresh -> the get still succeeds; two scheduled silent refreshes about 100 s apart while a
// get runs every 3 s and none fails; /token answering 503 twice (a route) -> backoff 5 s, 10 s -> recovery;
// /token answering 401 -> needsReauth, the banner shows, gets keep working, no more /token calls; and the
// leak check again.
// Step 4 (live stream): the production CSP and URLs are exactly OpenF1's (no fake broker in dist/). Then, against
// the vault dev server pointed at the local fake broker (fakebroker.ts, VAULT_FAKE_BROKER; its dev CSP adds only
// that origin) with /token faked by a route: two app tabs on one profile, one leader and one follower; a login
// in the follower's popup reaches both (one /token); both get the same message sequence; a handover (refresh)
// loses and duplicates nothing and never opens a third session; a forced broker drop reconnects and gap-fills
// with no loss; CONNACK 5 at the cap keeps the old session; closing the leader tab makes the follower the
// leader (no /token, no loss): every tab's received sequence is compared with what the broker published. The
// leak check with two tabs. And in the refresh run: the real broker with the real login (connects, subscribes,
// survives the handovers of the 120 s tokens, never more than 2 sessions) and a second (follower) tab.

import { execSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FakeBroker } from "./fakebroker";
import { runDownloads } from "./downloads";
import { findAppSecrets, findInHeap, findInWorker, vaultIsOutOfProcess } from "./leakcheck";
import { runS3 } from "./s3";

const repo = fileURLToPath(new URL("..", import.meta.url)); // vault/ -> the repo
const args = process.argv.slice(2);
const DEV = args.includes("--dev");
const HEADED = args.includes("--headed");
const QUICK = args.includes("--quick");
const S3 = args.includes("--s3");
const DOWNLOADS = args.includes("--downloads");

const APP = "http://127.0.0.1:5173";
const VAULT = "http://localhost:5174";
const EVIL_PORT = Number(process.env.VAULT_E2E_EVIL_PORT || 5188);
const EVIL = `http://127.0.0.1:${EVIL_PORT}`;
const TOKEN_URL = "https://api.openf1.org/token";
const REST_PREFIX = "https://api.openf1.org/v1/";
/** The dev vault's fake token lifetime for the refresh run (seconds): refreshes every 100 s. */
const FAKE_EXPIRES_IN = 120;
/** OpenF1's connect-src, exactly: the production CSP must have nothing else. */
const PROD_CONNECT = "https://api.openf1.org wss://mqtt.openf1.org:8084 'self'";
const FAKE_BROKER_PORT = Number(process.env.VAULT_E2E_BROKER_PORT || 5191);
const FAKE_BROKER = `http://127.0.0.1:${FAKE_BROKER_PORT}`;
const connectSrc = (csp: string | null) => /connect-src ([^;]*)/.exec(csp ?? "")?.[1] ?? "";

// The real login, from the repo's .env (Bun loads it). Only ever typed into the vault popup.
const USERNAME = process.env.OPENF1_USERNAME ?? "";
const PASSWORD = process.env.OPENF1_PASSWORD ?? "";
const HAVE_LOGIN = !!USERNAME && !!PASSWORD;
/** A made-up account for the wrong-password check (so the real one never collects failed attempts). */
const FAKE_USER = "vault-e2e-nobody@example.invalid";
const FAKE_PASS = `wrong-${Math.random().toString(36).slice(2)}`;

/** Nothing this script prints may contain the password or a whole token. */
function redact(text: string): string {
  let out = text;
  for (const s of [PASSWORD, encodeURIComponent(PASSWORD), JSON.stringify(PASSWORD).slice(1, -1)]) if (s.length >= 4) out = out.split(s).join("<password>");
  return out.replace(/eyJ[A-Za-z0-9_-]{3,}(?:\.[A-Za-z0-9_-]*)*/g, (m) => `${m.slice(0, 6)}…`);
}

// ---------------------------------------------------------------- playwright

function playwright(): any {
  const require = createRequire(import.meta.url);
  const dirs = [process.env.PLAYWRIGHT_DIR, "playwright"];
  try {
    dirs.push(join(execSync("npm root -g", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(), "playwright"));
  } catch {}
  dirs.push("/usr/lib/node_modules/playwright");
  for (const d of dirs) {
    if (!d) continue;
    try {
      return require(d);
    } catch {}
  }
  throw new Error("Playwright not found: set PLAYWRIGHT_DIR or `npm i -g playwright`");
}

// ---------------------------------------------------------------- servers

const started: ChildProcess[] = [];

async function up(url: string) {
  try {
    await fetch(url, { signal: AbortSignal.timeout(1000) });
    return true;
  } catch {
    return false;
  }
}

async function waitUp(url: string, ms = 30_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await up(url)) return;
    await Bun.sleep(200);
  }
  throw new Error(`${url} didn't come up`);
}

function start(cmd: string[], env: Record<string, string> = {}) {
  const p = spawn(cmd[0]!, cmd.slice(1), { cwd: repo, env: { ...process.env, ...env }, stdio: ["ignore", "ignore", "inherit"], detached: true });
  started.push(p);
  return p;
}

function stop(p: ChildProcess) {
  try {
    process.kill(-p.pid!, "SIGTERM");
  } catch {}
}

/** Pages on a non-allowed origin: one frames the vault, one frames the app, one posts to the app's frames. */
const evil = Bun.serve({
  port: EVIL_PORT,
  fetch(req) {
    const path = new URL(req.url).pathname;
    const html = (body: string) => new Response(`<!doctype html><body>${body}</body>`, { headers: { "Content-Type": "text/html" } });
    const record = `<script>window.__msgs = []; addEventListener("message", (e) => __msgs.push({ origin: e.origin, data: e.data }));</script>`;
    if (path === "/frame-vault") return html(`${record}<iframe src="${VAULT}/frame.html"></iframe>`);
    if (path === "/frame-app") return html(`<iframe src="${APP}/?vault=debug" width="1200" height="600"></iframe>`);
    if (path === "/poster")
      // Opened by the app page: send a hello with a port to the app's extra vault frame, then a status request.
      return html(`<script>
        window.__replies = [];
        const idx = Number(new URLSearchParams(location.search).get("idx"));
        const ch = new MessageChannel();
        ch.port1.onmessage = (e) => __replies.push(e.data);
        opener.frames[idx].postMessage({ v: 1, type: "hello" }, "*", [ch.port2]);
        ch.port1.postMessage({ v: 1, id: 1, type: "status" });
        window.__sent = true;
      </script>`);
    return new Response("not found", { status: 404 });
  },
});

// ---------------------------------------------------------------- checks

let failures = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
  const d = redact(String(detail ?? ""));
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${d ? `  (${d})` : ""}`);
  if (!ok) failures++;
}

/** In every frame, before any page script: record CSP violations. Init scripts bypass CSP. */
const RECORD_CSP = `(() => {
  window.__csp = [];
  addEventListener("securitypolicyviolation", (e) => window.__csp.push(e.violatedDirective + " " + e.blockedURI));
})();`;

const vaultFrame = (page: any) => page.frames().find((f: any) => f.url().startsWith(`${VAULT}/frame.html`));

/**
 * In the vault popup: window.close() only records that it was called. The popup still "closes itself"
 * (checked via __closeCalls); the test closes it when it wants. This keeps the popup's tab, and with it
 * the CDP virtual authenticator (one per tab, and PRF secrets don't survive exporting a credential), for
 * the passkey unlock: the app reopens the popup by name, which reuses the same tab.
 */
const KEEP_POPUP = `(() => {
  if (location.origin !== ${JSON.stringify(VAULT)} || !location.pathname.startsWith("/popup")) return;
  window.__closeCalls = 0;
  window.close = () => { window.__closeCalls++; };
})();`;

/**
 * Make Playwright's Chromium behave like the Chrome users run, for the two things the vault relies on:
 * - Playwright's default --disable-features list includes ThirdPartyStoragePartitioning (playwright#32230).
 *   Replacing the switch (the last one wins) turns partitioning back on, as in shipped Chrome.
 * - Headless Chromium here doesn't isolate every site by default, so the cross-site vault iframe shared
 *   the app's renderer (and its heap snapshot). --site-per-process is desktop Chrome's default.
 * Both are checked below ("out-of-process iframe", "storage is partitioned"), so a Playwright change can't
 * silently weaken the test.
 */
const CHROME_AS_SHIPPED = ["--disable-features=Translate,MediaRouter,OptimizationHints,HttpsUpgrades", "--site-per-process"];

/**
 * The app dev server is shared with whoever else is editing the app: its HMR would reload or hot-swap the
 * page mid-check (a reload restarts the vault frame, and the 5-minute refresh run with it). So the app's
 * Vite HMR socket connects, but updates, full reloads and server restarts never reach the page.
 */
const APP_HMR = new RegExp(`^${APP.replace("http", "ws").replaceAll(".", "\\.")}/`);
function keepAppLoaded(ws: any) {
  const server = ws.connectToServer();
  server.onMessage((m: string | Buffer) => {
    if (typeof m === "string" && /"type":\s*"(full-reload|update|prune|error)"/.test(m)) return;
    ws.send(m);
  });
  server.onClose(() => {});
}

/** The OpenF1 account controls are in Home's Settings panel: open it (unless it is) and return it. */
async function account(page: any) {
  const panel = page.getByTestId("settings-panel");
  if (!(await panel.isVisible())) await page.getByRole("button", { name: "Settings" }).click();
  return panel;
}
const state = async (page: any) => (await account(page)).getByTestId("vault-state").getAttribute("data-state");
async function waitState(page: any, want: string, ms = 20_000) {
  await (await account(page)).locator(`[data-testid=vault-state][data-state=${want}]`).waitFor({ timeout: ms });
}
const closeCalls = (popup: any) => popup.evaluate(() => (window as any).__closeCalls as number);
async function waitClosed(popup: any, ms = 20_000) {
  await popup.waitForFunction(() => (window as any).__closeCalls > 0, null, { timeout: ms });
}
/** Records in the vault frame's own IndexedDB (its partition under the app's site). */
const frameRecords = (frame: any) =>
  frame.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const r = indexedDB.open("f1-vault");
        r.onupgradeneeded = () => r.result.createObjectStore("login");
        r.onsuccess = () => {
          const tx = r.result.transaction("login", "readonly");
          const c = tx.objectStore("login").count();
          tx.oncomplete = () => (r.result.close(), resolve(c.result));
        };
        r.onerror = () => resolve(-1);
      }),
  );

async function addAuthenticator(context: any, popup: any, hasPrf: boolean) {
  const cdp = await context.newCDPSession(popup);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf, automaticPresenceSimulation: true },
  });
  return { cdp, authenticatorId };
}

/** Run the leak check on an app page and report it as checks. */
async function leakCheck(page: any, label: string) {
  const report = await findAppSecrets(page, [PASSWORD]);
  const heap = report.scanned["heap snapshot (app main frame)"] ?? 0;
  const places = Object.keys(report.scanned).length;
  check(
    `${label}: no password or JWT readable from the app origin (heap ${(heap / 1e6).toFixed(1)} MB + ${places - 1} storage places)`,
    report.findings.length === 0 && heap > 1e6,
    report.findings.map((f) => `${f.what} in ${f.where}${f.sample ? ` "${f.sample}"` : ""}`).join("; "),
  );
}

/** Click the app's Connect (or Unlock) and get the popup, whether a new tab or the reused named one. */
async function openPopup(_context: any, page: any, testId: "vault-connect" | "vault-unlock", reuse?: any) {
  if (reuse) {
    const nav = reuse.waitForEvent("load");
    await (await account(page)).getByTestId(testId).click();
    await nav;
    return reuse;
  }
  const popupP = page.waitForEvent("popup");
  await (await account(page)).getByTestId(testId).click();
  const popup = await popupP;
  await popup.waitForLoadState();
  return popup;
}

async function submitLogin(popup: any, user: string, pass: string, storage: "device" | "passkey" = "device") {
  await popup.locator("#login").waitFor({ timeout: 10_000 });
  await popup.getByLabel("OpenF1 email").fill(user);
  try {
    await popup.getByLabel("OpenF1 password").fill(pass);
  } catch (e) {
    throw new Error(redact(String(e)));
  }
  await popup.getByLabel(storage === "device" ? "Stay connected on this device" : "Unlock with passkey").check();
  await popup.getByRole("button", { name: "Connect" }).click();
}

/** One `get /v1/sessions?session_key=latest` through the app's vault client (dev app: window.__vault). */
async function vaultGet(page: any): Promise<{ status?: number; auth?: boolean; bytes?: number; error?: string }> {
  await page.waitForFunction(() => !!(window as any).__vault, null, { timeout: 5000 });
  return page.evaluate(() =>
    (window as any).__vault.get("sessions", { session_key: "latest" }).then(
      (r: any) => ({ status: r.status, auth: r.auth, bytes: r.body.byteLength }),
      (e: any) => ({ error: `${e.code}: ${e.message}` }),
    ),
  );
}

async function popupError(popup: any, ms = 20_000): Promise<string> {
  await popup.locator("#error:not([hidden])").waitFor({ timeout: ms });
  return (await popup.locator("#error").textContent()) ?? "";
}

async function main() {
  const { chromium } = playwright();
  if (S3) {
    return runS3({ chromium, repo, APP, VAULT, launchArgs: CHROME_AS_SHIPPED, appHmr: APP_HMR, keepAppLoaded, account, check, up, waitUp, start, stop, findAppSecrets, headed: HEADED });
  }
  const downloads = () =>
    HAVE_LOGIN
      ? runDownloads({ chromium, repo, APP, VAULT, launchArgs: CHROME_AS_SHIPPED, appHmr: APP_HMR, keepAppLoaded, keepPopup: KEEP_POPUP, check, up, waitUp, start, stop, findAppSecrets, findInHeap, findInWorker, openPopup, submitLogin, waitState, waitClosed, username: USERNAME, password: PASSWORD, headed: HEADED })
      : Promise.resolve(console.log("(skipping the downloads: no login in .env)"));
  if (DOWNLOADS) return downloads();

  if (!(await up(APP))) {
    console.log(`starting the app dev server on ${APP}`);
    start(["bun", "run", "dev", "--", "--port", "5173", "--strictPort"], { VITE_VAULT_ORIGIN: VAULT });
    await waitUp(APP);
  }
  let vault: ChildProcess | null = null;
  if (await up(`${VAULT}/frame.html`)) {
    console.log(`using the vault already on ${VAULT}`);
  } else if (DEV) {
    vault = start(["bun", "run", "vault"]);
  } else {
    execSync("bun run vault:build", { cwd: repo, stdio: ["ignore", "ignore", "inherit"] });
    vault = start(["bun", "vault/serve.ts"]);
  }
  await waitUp(`${VAULT}/frame.html`);
  const served = await fetch(`${VAULT}/frame.html`);
  console.log(`vault: ${served.headers.get("content-security-policy")}`);
  if (vault && !DEV) check("production CSP: connect-src is exactly OpenF1's REST and broker, and the vault's own pass-through", connectSrc(served.headers.get("content-security-policy")) === PROD_CONNECT, connectSrc(served.headers.get("content-security-policy")));

  // A persistent profile, so "after a browser restart" is a real restart of the same profile.
  const profile = mkdtempSync(join(tmpdir(), "vault-e2e-"));
  const consoleCsp: string[] = [];
  const tokenRequests: string[] = [];
  const tokenTimes: number[] = [];
  const restResponses: { status: number; frame: string }[] = [];
  const launch = async (dir = profile) => {
    const ctx = await chromium.launchPersistentContext(dir, { headless: !HEADED, viewport: { width: 1280, height: 800 }, args: CHROME_AS_SHIPPED });
    await ctx.addInitScript(RECORD_CSP);
    await ctx.routeWebSocket(APP_HMR, keepAppLoaded);
    await ctx.addInitScript(KEEP_POPUP);
    ctx.on("page", (p: any) =>
      p.on("console", (m: any) => {
        if (/Content Security Policy|Refused to/i.test(m.text())) consoleCsp.push(m.text());
      }),
    );
    ctx.on("request", (r: any) => {
      if (r.url() === TOKEN_URL) {
        tokenRequests.push(r.frame()?.url?.() ?? "?");
        tokenTimes.push(Date.now());
      }
    });
    ctx.on("response", (r: any) => {
      if (r.url().startsWith(REST_PREFIX)) restResponses.push({ status: r.status(), frame: r.frame()?.url?.() ?? "?" });
    });
    return ctx;
  };
  let context = await launch();
  let page: any;
  const errors: string[] = [];

  try {
    // 1. Handshake and status round trip.
    console.log("handshake");
    page = await context.newPage();
    page.on("pageerror", (e: Error) => errors.push(e.message));
    await page.goto(`${APP}/?vault=debug`);
    await page.getByTestId("vault-phase").filter({ hasText: /ready|unavailable/ }).waitFor({ timeout: 15_000 });
    const phase = await page.getByTestId("vault-phase").textContent();
    check("handshake completes", phase === "ready", `phase ${phase}`);
    await waitState(page, "disconnected", 5000);
    check("chip shows not connected", (await (await account(page)).getByTestId("vault-state").textContent()) === "not connected");
    await page.keyboard.press("Escape"); // Settings, closed again: it would cover the debug panel's buttons
    await page.getByRole("button", { name: "Measure status round trip" }).click();
    const ping = await page.getByTestId("vault-ping").textContent({ timeout: 10_000 });
    check("status round trips", /ms median of 20/.test(ping ?? ""), ping ?? "");

    // Step 3: get without a login (unauthenticated), and the dev knobs only on a dev vault.
    const anon = await vaultGet(page);
    check("get without a login: 200 from OpenF1, unauthenticated", anon.status === 200 && anon.auth === false && (anon.bytes ?? 0) > 10, JSON.stringify(anon));
    const vaultVersion: string = await page.evaluate(() => (window as any).__vault.getState().status.version);
    const spoil = await page.evaluate(() => (window as any).__vault.debug.spoilToken().then(() => "ok", (e: any) => `${e.code}: ${e.message}`));
    if (vaultVersion.endsWith("-dev")) check("dev vault: debug methods answer", spoil === "ok", spoil);
    else check("production vault: debug methods are unknown types", spoil === "bad_request: unknown type", spoil);
    if (vault && !DEV) {
      const { readdirSync, readFileSync } = await import("node:fs");
      const dir = join(repo, "vault/dist/assets");
      const js = readdirSync(dir).filter((f) => f.endsWith(".js")).map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
      const leftovers = ["DevKnobs", "spoiled", "fakeSeconds", "tokenFilter:", "corrupt("].filter((w) => js.includes(w));
      check("production build: none of the dev knobs (debug.ts) is in dist/", leftovers.length === 0, leftovers.join(", "));
      const simLeft = ["__VAULT_SIMULATE__", "SimBroker", "/__sim", "loadSimConfig", "FreezeGate", "f1-vault-sim", "sendBeacon", "encodeConnack", "anchorWall", "popup-sim", "SIMULATED"].filter((w) => js.includes(w));
      check("production build: no simulate mode or freeze gate (sim.ts, freeze.ts, brokercodec.ts, the popup's notice) in dist/", simLeft.length === 0, simLeft.join(", "));
      const freeze = await page.evaluate(() => (window as any).__vault.debug.freeze(2000).then(() => "ok", (e: any) => `${e.code}: ${e.message}`));
      check("production vault: debug:freeze and debug:sim are unknown types", freeze === "bad_request: unknown type" && (await page.evaluate(() => (window as any).__vault.getState().status.sim)) === undefined, freeze);
      const fakeLeft = ["__VAULT_FAKE_BROKER__", "fakebroker", "FakeBroker", `:${FAKE_BROKER_PORT}`, "ws://"].filter((w) => js.includes(w));
      check("production build: no fake-broker URL or knob in dist/; the MQTT URL is OpenF1's", fakeLeft.length === 0 && js.includes('"wss://mqtt.openf1.org:8084/mqtt"') && js.includes('"https://api.openf1.org/v1/"'), fakeLeft.join(", "));
    }

    // 2. CSP violations in the vault frame.
    const frame = vaultFrame(page);
    check("vault frame present", !!frame);
    const inFrame: string[] = frame ? await frame.evaluate(() => (window as any).__csp) : ["no frame"];
    check("zero CSP violations in the vault frame", inFrame.length === 0, inFrame.join("; "));

    // 3. Hello from the wrong origin, and from the right origin but the wrong window: ignored.
    console.log("wrong senders");
    const idx = await page.evaluate(async (vaultUrl: string) => {
      const f = document.createElement("iframe");
      f.src = `${vaultUrl}/frame.html`;
      f.hidden = true;
      const loaded = new Promise((r) => f.addEventListener("load", r));
      document.body.append(f);
      await loaded;
      return [...document.querySelectorAll("iframe")].indexOf(f);
    }, VAULT);
    const popupP = page.waitForEvent("popup");
    await page.evaluate(([evil, i]: [string, number]) => void window.open(`${evil}/poster?idx=${i}`), [EVIL, idx] as [string, number]);
    const poster = await popupP;
    await poster.waitForFunction(() => (window as any).__sent === true);
    // Same origin as the app, but not the frame's parent: an about:blank popup of the app page.
    await page.evaluate((i: number) => {
      const w = window.open("")!;
      (w as any).__replies = [];
      const s = w.document.createElement("script");
      s.textContent = `const ch = new MessageChannel(); ch.port1.onmessage = (e) => __replies.push(e.data);
        opener.frames[${i}].postMessage({ v: 1, type: "hello" }, "*", [ch.port2]);
        ch.port1.postMessage({ v: 1, id: 1, type: "status" });`;
      w.document.body.append(s);
      (window as any).__sibling = w;
    }, idx);
    await Bun.sleep(1500);
    const evilReplies = await poster.evaluate(() => (window as any).__replies);
    check("hello from a non-allowed origin is ignored", evilReplies.length === 0, JSON.stringify(evilReplies));
    const siblingReplies = await page.evaluate(() => (window as any).__sibling.__replies);
    check("hello from a same-origin window that isn't the parent is ignored", siblingReplies.length === 0, JSON.stringify(siblingReplies));
    // The real parent still can: the frame was waiting, not broken. Then malformed requests over the port.
    const replies = await page.evaluate(
      ([i, vaultUrl]: [number, string]) =>
        new Promise<unknown[]>((resolve) => {
          const ch = new MessageChannel();
          const got: unknown[] = [];
          ch.port1.onmessage = (e) => got.push(e.data);
          window.frames[i]!.postMessage({ v: 1, type: "hello" }, vaultUrl, [ch.port2]);
          ch.port1.postMessage({ v: 1, id: 1, type: "token" });
          ch.port1.postMessage({ v: 1, id: 2, type: "status", extra: 1 });
          ch.port1.postMessage({ v: 1, type: "status" });
          ch.port1.postMessage({ v: 1, id: 3, type: "get", endpoint: "../token", params: {} });
          ch.port1.postMessage({ v: 1, id: 4, type: "status" });
          setTimeout(() => resolve(got), 1500);
        }),
      [idx, VAULT] as [number, string],
    );
    const codes = replies.map((r: any) => `${r.id}:${r.ok ? "ok" : r.error.code}`).join(" ");
    check("the parent's own hello still works on that frame; bad requests get errors, id-less ones are dropped", codes === "1:bad_request 2:bad_request 3:bad_request 4:ok", codes);
    const second = await page.evaluate(
      ([i, vaultUrl]: [number, string]) =>
        new Promise<unknown[]>((resolve) => {
          const ch = new MessageChannel();
          const got: unknown[] = [];
          ch.port1.onmessage = (e) => got.push(e.data);
          window.frames[i]!.postMessage({ v: 1, type: "hello" }, vaultUrl, [ch.port2]);
          ch.port1.postMessage({ v: 1, id: 1, type: "status" });
          setTimeout(() => resolve(got), 1000);
        }),
      [idx, VAULT] as [number, string],
    );
    check("a second hello to a frame is ignored", second.length === 0, JSON.stringify(second));

    // 4. A non-allowed origin can't frame the vault, directly or by framing the app.
    console.log("framing");
    const evilPage = await context.newPage();
    await evilPage.goto(`${EVIL}/frame-vault`);
    await Bun.sleep(1500);
    const evilFrame = evilPage.frames().find((f: any) => f !== evilPage.mainFrame());
    const msgs = await evilPage.evaluate(() => (window as any).__msgs);
    check("vault frame blocked on a non-allowed origin", !!evilFrame && !evilFrame.url().startsWith(VAULT), evilFrame?.url());
    check("no ready sent to a non-allowed origin", msgs.length === 0, JSON.stringify(msgs));
    const nested = await context.newPage();
    await nested.goto(`${EVIL}/frame-app`);
    const appFrame = nested.frames().find((f: any) => f.url().startsWith(APP));
    await appFrame.getByTestId("vault-phase").filter({ hasText: /ready|unavailable/ }).waitFor({ timeout: 15_000 });
    const nestedPhase = await appFrame.getByTestId("vault-phase").textContent();
    check("vault unavailable when the app itself is framed by another site", nestedPhase === "unavailable", nestedPhase);
    await evilPage.close();
    await nested.close();

    // 5. The popup page: zero violations, styled from its own stylesheet, not frameable.
    const popup = await context.newPage();
    await popup.goto(`${VAULT}/popup.html`);
    const popupCsp: string[] = await popup.evaluate(() => (window as any).__csp);
    const bg = await popup.evaluate(() => getComputedStyle(document.body).backgroundColor);
    check("zero CSP violations in the popup", popupCsp.length === 0, popupCsp.join("; "));
    check("popup stylesheet applies", bg === "rgb(9, 9, 11)", bg);
    const orphan = await popupError(popup, 5000);
    check("popup opened without the app says to use the Connect button", /Connect button/.test(orphan), orphan);
    await popup.close();

    // 6. A popup whose ticket no frame is expecting: no frame answers, it says it can't reach the app.
    const staleP = page.waitForEvent("popup");
    await page.evaluate((v: string) => void window.open(`${v}/popup.html#mode=connect&ticket=${"s".repeat(22)}`, "stale"), VAULT);
    const stale = await staleP;
    const staleText = await popupError(stale, 10_000);
    check("a popup with a stale ticket is ignored by every frame and says it can't reach Pitwall", /couldn't reach Pitwall/.test(staleText), staleText);
    check("its form never appears", !(await stale.locator("#login").isVisible()));
    await stale.close();

    // 7. An extension that wraps window.open and calls it from a frame of its own inside the app: the popup's
    // opener is that frame, with no frames under it. The popup still finds the vault frame, from the app's top.
    await page.evaluate(() => {
      const f = document.createElement("iframe");
      f.hidden = true;
      document.body.append(f);
      const open = f.contentWindow!.open.bind(f.contentWindow);
      (window as any).__open = window.open;
      window.open = (...args: Parameters<typeof window.open>) => open(...args);
    });
    const wrapped = await openPopup(context, page, "vault-connect");
    const wrappedFrames = await wrapped.evaluate(() => `opener ${window.opener?.frames.length}, top ${window.opener?.top?.frames.length}`);
    await wrapped.locator("#login").waitFor({ timeout: 10_000 }).catch(() => {});
    check("a popup opened from an extension's frame in the app still finds the vault frame", await wrapped.locator("#login").isVisible(), wrappedFrames);
    await wrapped.close();
    await page.evaluate(() => void (window.open = (window as any).__open));

    if (HAVE_LOGIN) await loginChecks();
    else console.log("(skipping the login checks: OPENF1_USERNAME / OPENF1_PASSWORD not set)");

    const vaultConsoleCsp = consoleCsp.filter((t) => !/frame-ancestors/.test(t));
    check("no CSP console errors (apart from the expected frame-ancestors blocks)", vaultConsoleCsp.length === 0, vaultConsoleCsp.join(" | "));
    check("no page errors on the app", errors.length === 0, errors.join(" | "));
    await page.close().catch(() => {});

    // 6. With the vault down, the app still works.
    if (vault) {
      console.log("vault down");
      stop(vault);
      for (let i = 0; i < 50 && (await up(`${VAULT}/frame.html`)); i++) await Bun.sleep(100);
      const down = await context.newPage();
      const downErrors: string[] = [];
      down.on("pageerror", (e: Error) => downErrors.push(e.message));
      const t0 = Date.now();
      await down.goto(`${APP}/?vault=debug`);
      await down.getByTestId("vault-phase").filter({ hasText: "unavailable" }).waitFor({ timeout: 15_000 });
      check("vault down: unavailable", true, `${Date.now() - t0} ms`);
      check("vault down: home still renders", await down.getByRole("heading", { name: "Pitwall" }).isVisible());
      check("vault down: no page errors", downErrors.length === 0, downErrors.join(" | "));
    } else {
      console.log("(skipping the vault-down check: the vault server wasn't started by this script)");
    }
  } finally {
    await context.close();
    rmSync(profile, { recursive: true, force: true });
  }

  if (vault) await streamChecks();
  else console.log("(skipping the stream run: the vault server wasn't started by this script)");

  if (!HAVE_LOGIN) console.log("(skipping the refresh run: no login in .env)");
  else if (QUICK) console.log("(skipping the refresh run: --quick)");
  else await refreshChecks();

  // Step 6: downloads through the vault (they need :5174 for the production vault they stop mid-download).
  if (QUICK) console.log("(skipping the downloads: --quick)");
  else if (vault) await downloads();
  else console.log("(skipping the downloads: the vault server wasn't started by this script)");

  // ------------------------------------------------------------ step 3: silent refresh on the real API
  async function refreshChecks() {
    console.log(`refresh: the vault dev server with VAULT_FAKE_EXPIRES_IN=${FAKE_EXPIRES_IN}`);
    let useKnob = false;
    let refreshVault: ChildProcess | null = null;
    if (vault) {
      // The vault-down check stopped ours: bring up the dev server (dev knobs on) in its place.
      for (let i = 0; i < 50 && (await up(`${VAULT}/frame.html`)); i++) await Bun.sleep(100);
      refreshVault = start(["bun", "run", "vault"], { VAULT_FAKE_EXPIRES_IN: String(FAKE_EXPIRES_IN) });
      await waitUp(`${VAULT}/frame.html`);
    } else {
      useKnob = true; // someone else's vault server: set the fake expiry through the dev knob instead
    }
    const dir = mkdtempSync(join(tmpdir(), "vault-e2e-refresh-"));
    const ctx = await launch(dir);
    try {
      const p = await ctx.newPage();
      const pageErrors: string[] = [];
      p.on("pageerror", (e: Error) => pageErrors.push(e.message));
      await p.goto(`${APP}/?vault=debug`);
      await waitState(p, "disconnected");
      const version: string = await p.evaluate(() => (window as any).__vault.getState().status.version);
      if (!version.endsWith("-dev")) {
        check("refresh run needs a dev vault on :5174", false, version);
        return;
      }
      if (useKnob) await p.evaluate((s: number) => (window as any).__vault.debug.fakeExpiry(s), FAKE_EXPIRES_IN);
      const tok0 = tokenTimes.length;
      const popup = await openPopup(ctx, p, "vault-connect");
      await submitLogin(popup, USERNAME, PASSWORD, "device");
      await waitClosed(popup);
      await waitState(p, "connected");
      await popup.close();
      const t0 = Date.now();
      const st = () => p.evaluate(() => (window as any).__vault.getState().status);

      // Step 4 on the real broker: a second tab (a follower: the login is shared, no /token) subscribes; the
      // leader streams from wss://mqtt.openf1.org with the real token through every handover of this run.
      const ws = { open: 0, opened: 0, max: 0, urls: new Set<string>() };
      const track = (page: any) =>
        page.on("websocket", (w: any) => {
          if (!w.url().startsWith("wss://mqtt.openf1.org")) return;
          ws.urls.add(w.url());
          ws.opened++;
          ws.max = Math.max(ws.max, ++ws.open);
          w.on("close", () => ws.open--);
        });
      track(p);
      const tokBefore2 = tokenRequests.length;
      const p2 = await ctx.newPage();
      p2.on("pageerror", (e: Error) => pageErrors.push(e.message));
      track(p2);
      await p2.goto(`${APP}/?vault=debug`);
      await waitState(p2, "connected");
      const s2tab = await p2.evaluate(() => (window as any).__vault.getState().status.tab);
      check("real login, second tab: a follower, connected without its own /token", s2tab?.role === "follower" && tokenRequests.length === tokBefore2, `${s2tab?.role}, ${tokenRequests.length - tokBefore2} /token`);
      await p2.evaluate(() => (window as any).__vault.subscribe(["car_data", "position", "race_control", "sessions"]));
      const realEnd = Date.now() + 20_000;
      let real: any = null;
      while (Date.now() < realEnd) {
        real = (await st()).stream;
        if (real?.phase === "connected") break;
        await Bun.sleep(200);
      }
      check("real broker: CONNACK 0 and SUBACK with the real token (the follower's topics, streamed by the leader)", real?.phase === "connected" && real.sessions === 1 && real.topics.length === 4, JSON.stringify({ phase: real?.phase, sessions: real?.sessions, error: real?.lastError }));
      const s0 = await st();
      const lifetime = (s0.tokenExpiresAt - s0.nextRefreshAt) * 6; // 1/6 of the lifetime is left at the refresh point
      check(`fake expiry: the token counts as ${FAKE_EXPIRES_IN} s, refresh at 5/6 (100 s)`, Math.abs(lifetime - FAKE_EXPIRES_IN * 1000) < 50 && s0.refresh === "scheduled", `${Math.round(lifetime / 1000)} s, ${s0.refresh}`);

      // A get every 3 s for the whole run, recorded in the page.
      await p.evaluate(() => {
        const w = window as any;
        w.__gets = [];
        w.__stream = setInterval(() => {
          const t = Date.now();
          w.__vault.get("sessions", { session_key: "latest" }).then(
            (r: any) => w.__gets.push({ t, status: r.status, auth: r.auth, bytes: r.body.byteLength }),
            (e: any) => w.__gets.push({ t, error: String(e?.code ?? e) }),
          );
        }, 3000);
      });
      type Got = { t: number; status?: number; auth?: boolean; error?: string };
      const gets = (): Promise<Got[]> => p.evaluate(() => (window as any).__gets);
      const bad = (g: Got[]) => g.filter((x) => x.status !== 200 || x.auth !== true);

      // 1. spoilToken (after the fresh-token guard, 10 s): the next get hits a real 401, refreshes, retries.
      await Bun.sleep(Math.max(0, t0 + 15_000 - Date.now()));
      const nTok = tokenRequests.length;
      const n401 = restResponses.filter((r) => r.status === 401).length;
      await p.evaluate(() => (window as any).__vault.debug.spoilToken());
      await p.waitForFunction(() => (window as any).__vault.getState().status.refreshCount >= 1, null, { timeout: 15_000 }).catch(() => {});
      await Bun.sleep(4000);
      const real401 = restResponses.slice().filter((r) => r.status === 401).length - n401;
      check("spoilToken: OpenF1 really answered 401 (to the vault frame)", real401 === 1 && restResponses.filter((r) => r.status === 401).every((r) => r.frame.startsWith(`${VAULT}/frame.html`)), `${real401} 401s`);
      check("spoilToken: one refresh (/token from the vault frame), and the gets still succeed", tokenRequests.length - nTok === 1 && bad(await gets()).length === 0, `${tokenRequests.length - nTok} /token, ${JSON.stringify(bad(await gets()))}`);

      // 2. Two scheduled silent refreshes, 100 s apart, while the gets go on.
      const s1 = await st();
      console.log("refresh: waiting for two scheduled refreshes (about 200 s)");
      const spoilAt = tokenTimes.at(-1)!;
      await p.waitForFunction(() => (window as any).__vault.getState().status.refreshCount >= 3, null, { timeout: 250_000 });
      await Bun.sleep(3500);
      const sched = tokenTimes.slice(-3);
      const gapsS = sched.slice(1).map((t, i) => (t - sched[i]!) / 1000);
      check("two silent refreshes, about 100 s apart", sched[0] === spoilAt && gapsS.every((g) => g > 97 && g < 104), gapsS.map((g) => `${g.toFixed(1)} s`).join(", "));
      const g2 = await gets();
      check(`the gets never failed (${g2.length} so far, all 200 and authenticated)`, g2.length >= 60 && bad(g2).length === 0, JSON.stringify(bad(g2).slice(0, 3)));
      const s2 = await st();
      check("status: refreshCount, lastRefresh ok, next refresh scheduled", s2.refreshCount === s1.refreshCount + 2 && s2.lastRefresh?.ok === true && s2.refresh === "scheduled" && s2.nextRefreshAt > Date.now(), JSON.stringify({ n: s2.refreshCount, last: s2.lastRefresh?.ok, phase: s2.refresh }));
      check("the panel shows it", (await p.getByTestId("vault-refresh-count").getAttribute("data-count")) === String(s2.refreshCount));

      // 3. /token answers 503 twice, then passes: backoff 5 s, 10 s (±20%), then recovery.
      const failAt: number[] = [];
      let passedAt = 0;
      await ctx.route(TOKEN_URL, (route: any) => {
        if (failAt.length < 2) {
          failAt.push(Date.now());
          return route.fulfill({ status: 503, contentType: "text/html", headers: { "Access-Control-Allow-Origin": "*" }, body: "<html>503 Service Temporarily Unavailable</html>" });
        }
        passedAt = Date.now();
        return route.continue();
      });
      const before503 = (await st()).refreshCount;
      const afterFirst = await p.evaluate(() => (window as any).__vault.debug.refreshNow());
      check("503: the refresh fails and backs off (retrying, server error)", afterFirst.refresh === "retrying" && afterFirst.lastRefresh?.error === "server", `${afterFirst.refresh} ${afterFirst.lastRefresh?.error}`);
      await p.waitForFunction((n: number) => (window as any).__vault.getState().status.refreshCount > n, before503, { timeout: 40_000 }).catch(() => {});
      await ctx.unroute(TOKEN_URL);
      const b1 = (failAt[1]! - failAt[0]!) / 1000;
      const b2 = (passedAt - failAt[1]!) / 1000;
      check("503 twice: retried after about 5 s, then 10 s, then recovered", failAt.length === 2 && passedAt > 0 && b1 >= 3.8 && b1 <= 6.5 && b2 >= 7.8 && b2 <= 12.5 && (await st()).lastRefresh?.ok === true, `${b1.toFixed(1)} s, ${b2.toFixed(1)} s`);

      // 4. /token answers 401 (password changed): needsReauth, banner, gets keep working, no more /token.
      await ctx.route(TOKEN_URL, (route: any) => route.fulfill({ status: 401, contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" }, body: '{"detail":"Incorrect username or password"}' }));
      const n401tok = tokenRequests.length;
      const g3 = (await gets()).length;
      const afterReauth = await p.evaluate(() => (window as any).__vault.debug.refreshNow());
      check("401 from /token: needsReauth, refresh stopped", afterReauth.needsReauth === true && afterReauth.refresh === "stopped", `${afterReauth.needsReauth} ${afterReauth.refresh}`);
      await p.getByTestId("vault-reauth-banner").waitFor({ timeout: 5000 }).catch(() => {});
      check("the reconnect banner shows", await p.getByTestId("vault-reauth-banner").isVisible(), (await p.getByTestId("vault-reauth-banner").textContent().catch(() => "")) ?? "");
      check("the chip says reconnect needed and offers Reconnect", (await (await account(p)).getByTestId("vault-state").textContent()) === "reconnect needed" && (await (await account(p)).getByTestId("vault-connect").isVisible()));
      await Bun.sleep(12_000);
      const g4 = (await gets()).slice(g3);
      check(`gets keep working on the current token (${g4.length} after the 401, all authenticated)`, g4.length >= 3 && bad(g4).length === 0, JSON.stringify(bad(g4).slice(0, 3)));
      check("no more /token calls after the 401", tokenRequests.length - n401tok === 1, tokenRequests.length - n401tok);
      await ctx.unroute(TOKEN_URL);

      await p.evaluate(() => clearInterval((window as any).__stream));
      await Bun.sleep(3000);
      const sEnd = (await st()).stream;
      check(
        "real broker: the stream survived every handover of the run (spoil, 2 scheduled, the 503 recovery), no reconnects, never more than 2 sessions",
        sEnd.phase === "connected" && sEnd.handovers >= 3 && sEnd.reconnects === 0 && sEnd.maxSessions <= 2 && (ws.opened === 0 || ws.max <= 2),
        JSON.stringify({ phase: sEnd.phase, handovers: sEnd.handovers, reconnects: sEnd.reconnects, maxSessions: sEnd.maxSessions, wsSeen: ws.opened, wsMax: ws.max, error: sEnd.lastError }),
      );
      if (ws.opened) check("real broker: the browser saw one WebSocket per session, to OpenF1's broker only", ws.opened === sEnd.handovers + 1 && [...ws.urls].every((u) => u === "wss://mqtt.openf1.org:8084/mqtt"), `${ws.opened} opened, ${[...ws.urls].join(" ")}`);
      else console.log("  (Playwright reported no WebSocket from the cross-site vault frame; relying on the vault's own session count)");
      // login, spoil, 2 scheduled, 503 + 503 + pass, 401
      const runCalls = tokenTimes.length - tok0;
      check("refresh run: exactly the expected /token calls, no storms (login, spoil, 2 scheduled, 503, 503, ok, 401)", runCalls === 8, `${runCalls} over ${Math.round((Date.now() - t0) / 1000)} s`);
      await leakCheck(p, "after the refresh run (leader tab)");
      await leakCheck(p2, "after the refresh run (follower tab)");
      check("refresh run: no page errors", pageErrors.length === 0, pageErrors.join(" | "));
      await (await account(p)).getByTestId("vault-disconnect").click();
      await waitState(p, "disconnected");
      check("disconnect clears the banner", (await p.getByTestId("vault-reauth-banner").count()) === 0);
    } finally {
      await ctx.close();
      rmSync(dir, { recursive: true, force: true });
      if (refreshVault) {
        stop(refreshVault);
        for (let i = 0; i < 50 && (await up(`${VAULT}/frame.html`)); i++) await Bun.sleep(100);
      }
    }
  }

  // ------------------------------------------------------------ step 4: the live stream, against the fake broker
  async function streamChecks() {
    console.log(`stream: the vault dev server with VAULT_FAKE_BROKER=${FAKE_BROKER}`);
    for (let i = 0; i < 50 && (await up(`${VAULT}/frame.html`)); i++) await Bun.sleep(100);
    const broker = new FakeBroker({ port: FAKE_BROKER_PORT });
    const devVault = start(["bun", "run", "vault"], { VAULT_FAKE_BROKER: FAKE_BROKER });
    const dir = mkdtempSync(join(tmpdir(), "vault-e2e-stream-"));
    let ctx: any = null;
    try {
      await waitUp(`${VAULT}/frame.html`);
      const devCsp = (await fetch(`${VAULT}/frame.html`)).headers.get("content-security-policy");
      const popupCsp = (await fetch(`${VAULT}/popup.html`)).headers.get("content-security-policy");
      check("dev CSP with the fake broker: connect-src adds exactly its origin (http + ws); the popup's is unchanged", connectSrc(devCsp) === `${PROD_CONNECT} ${FAKE_BROKER} ${FAKE_BROKER.replace("http", "ws")}` && connectSrc(popupCsp) === PROD_CONNECT, connectSrc(devCsp));

      ctx = await launch(dir);
      // /token answered here (fake JWTs, `eyJhbGciOi…` like OpenF1's), so this run needs no real login.
      const fakeUser = "vault-e2e-stream@example.invalid";
      const fakePass = `stream-${Math.random().toString(36).slice(2)}-${Date.now()}`;
      let minted = 0;
      const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
      await ctx.route(TOKEN_URL, (route: any) => {
        const iat = Math.floor(Date.now() / 1000);
        const jwt = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ iat, exp: iat + 3600, n: ++minted })}.${"s".repeat(43)}`;
        return route.fulfill({ status: 200, contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" }, body: JSON.stringify({ access_token: jwt, token_type: "bearer", expires_in: "3600" }) });
      });
      const pageErrors: string[] = [];
      const open = async () => {
        const p = await ctx.newPage();
        p.on("pageerror", (e: Error) => pageErrors.push(e.message));
        await p.goto(`${APP}/?vault=debug`);
        await waitState(p, "disconnected");
        await p.waitForFunction(() => !!(window as any).__vault?.getState().status?.tab, null, { timeout: 5000 });
        return p;
      };
      const st = (p: any) => p.evaluate(() => (window as any).__vault.getState().status);
      const waitFor = async (what: string, p: any, pred: (s: any) => boolean, ms = 15_000) => {
        const end = Date.now() + ms;
        let s: any;
        while (Date.now() < end) {
          s = await st(p);
          if (s && pred(s)) return s;
          await Bun.sleep(100);
        }
        throw new Error(`timed out waiting for ${what}: ${JSON.stringify(s?.stream ?? s?.state)}`);
      };
      const a = await open();
      const b = await open();
      const [sa, sb] = [await st(a), await st(b)];
      check("two tabs: the first frame leads, the second follows it", sa.tab.role === "leader" && sb.tab.role === "follower" && sb.tab.leader === sa.tab.id, `${sa.tab.role} / ${sb.tab.role}`);

      // A login in the follower's popup reaches both frames; the leader does the refreshing.
      const tok0 = tokenRequests.length;
      const popup = await openPopup(ctx, b, "vault-connect");
      await submitLogin(popup, fakeUser, fakePass, "device");
      await waitClosed(popup);
      await popup.close();
      await waitState(a, "connected");
      await waitState(b, "connected");
      check("login in the follower's tab: both tabs connected, one /token call", tokenRequests.length - tok0 === 1, `${tokenRequests.length - tok0} /token`);
      check("the leader runs the refresh schedule", (await st(a)).refresh === "scheduled" && (await st(b)).refresh === "scheduled");

      // Collect what each app receives, and subscribe (the union is streamed once).
      const collect = (p: any, topics: string[]) =>
        p.evaluate(async (topics: string[]) => {
          const w = window as any;
          w.__got = [];
          w.__vault.onData((topic: string, ms: any[]) => {
            for (const m of ms) w.__got.push([topic, m.n]);
          });
          return (await w.__vault.subscribe(topics)).topics;
        }, topics);
      const TA = ["car_data", "position"];
      const TB = ["car_data", "position", "race_control"];
      await collect(a, TA);
      await collect(b, TB);
      await waitFor("the union subscribed", a, (s) => s.stream?.phase === "connected" && s.stream.topics.join() === "car_data,position,race_control");
      const subs = broker.sessions();
      check("one MQTT session for both tabs, subscribed to the union", subs.length === 1 && subs[0]!.subs.sort().join() === "v1/car_data,v1/position,v1/race_control", JSON.stringify(subs.map((x) => x.subs)));
      check("a fresh clientId", /^f1-vault-[a-z0-9]{16}$/.test(subs[0]?.clientId ?? ""), subs[0]?.clientId);

      const from = broker.log.length;
      broker.resetStats();
      const RATE = 40;
      broker.startStream(RATE, TB);
      await Bun.sleep(2000);

      // Handover (a refresh, asked for from the follower: forwarded to the leader).
      const h0 = (await st(a)).stream.handovers;
      await b.evaluate(() => (window as any).__vault.debug.refreshNow());
      await waitFor("the handover", a, (s) => s.stream.handovers === h0 + 1 && s.stream.phase === "connected");
      check("handover on refresh: a new session with a new clientId, then back to one", broker.sessions().length === 1 && broker.sessions()[0]!.clientId !== subs[0]!.clientId && broker.stats.max === 2, `max ${broker.stats.max}`);
      await Bun.sleep(1500);

      // A forced drop: reconnect, gap-fill over REST.
      const r0 = (await st(a)).stream;
      broker.drop("all");
      await waitFor("the reconnect", a, (s) => s.stream.reconnects === r0.reconnects + 1 && s.stream.phase === "connected");
      const r1 = (await st(a)).stream;
      check("broker drop: reconnected and gap-filled over REST", r1.gapFilled > r0.gapFilled && broker.stats.restRequests >= 3 && broker.stats.restAuthorized === broker.stats.restRequests, `${r1.gapFilled - r0.gapFilled} gap-filled, ${broker.stats.restRequests} REST requests`);
      await Bun.sleep(1500);

      // CONNACK 5 while the token is valid: the connection cap. The old session stays and streams.
      broker.refuse(1);
      const c0 = (await st(a)).stream;
      const got0 = await b.evaluate(() => (window as any).__got.length);
      await a.evaluate(() => (window as any).__vault.debug.refreshNow());
      const limited = await waitFor("connection-limit", a, (s) => s.stream.phase === "connection-limit", 5000).catch((e) => e);
      check("CONNACK 5 with a valid token: status 'connection limit reached', the old session kept", !(limited instanceof Error) && limited.stream.sessions === 1 && broker.sessions().length === 1, limited instanceof Error ? limited.message : `${limited.stream.sessions} session(s)`);
      await Bun.sleep(1500);
      const got1 = await b.evaluate(() => (window as any).__got.length);
      check("at the cap, data keeps flowing on the old session", got1 - got0 >= RATE / 2, `${got1 - got0} messages in 1.5 s`);
      check("at the cap, the token isn't thrown away (no extra /token, gets still authenticated)", (await st(a)).state === "connected" && (await vaultGet(a)).auth === true);
      await waitFor("the retried handover", a, (s) => s.stream.handovers === c0.handovers + 1 && s.stream.phase === "connected", 20_000);
      check("after the backoff the handover completes", true);
      await Bun.sleep(1000);
      broker.stopStream();
      await Bun.sleep(1500);

      const expected = (topics: string[], fromIdx = from) => broker.log.slice(fromIdx).filter((x) => topics.includes(x.topic)).map((x) => x.msg.n as number);
      const compare = async (label: string, p: any, topics: string[], fromIdx = from) => {
        const got: [string, number][] = await p.evaluate(() => (window as any).__got);
        const want = expected(topics, fromIdx);
        const mine = got.filter(([, n]) => n > (broker.log[fromIdx - 1]?.msg.n as number ?? 0)).map(([, n]) => n);
        const dups = mine.length - new Set(mine).size;
        const lost = want.filter((n) => !mine.includes(n));
        const extra = mine.filter((n) => !want.includes(n));
        check(`${label}: every published message exactly once (${want.length})`, dups === 0 && lost.length === 0 && extra.length === 0, `lost ${lost.length} [${lost.slice(0, 5)}], duplicated ${dups}, unexpected ${extra.length}`);
        let inversions = 0;
        for (const t of topics) {
          const seq = got.filter(([tt]) => tt === t).map(([, n]) => n);
          for (let i = 1; i < seq.length; i++) if (seq[i]! < seq[i - 1]!) inversions++;
        }
        check(`${label}: each topic arrives in order`, inversions === 0, `${inversions} out of order`);
        return got;
      };
      const gotA = await compare("leader tab", a, TA);
      const gotB = await compare("follower tab", b, TB);
      const common = (g: [string, number][]) => g.filter(([t]) => TA.includes(t)).map(([t, n]) => `${t}:${n}`).join();
      check("both tabs received the same sequence (their common topics)", common(gotA) === common(gotB));
      const sAfter = (await st(a)).stream;
      check("never more than 2 MQTT sessions (broker's count and the vault's)", broker.stats.max <= 2 && sAfter.maxSessions <= 2, `broker max ${broker.stats.max}, vault max ${sAfter.maxSessions}`);
      check("status: duplicates dropped, gap-filled, lastSeen per topic", sAfter.duplicates > 0 && sAfter.gapFilled > 0 && TB.every((t) => typeof sAfter.lastSeen[t] === "string"), JSON.stringify({ dup: sAfter.duplicates, gap: sAfter.gapFilled, seen: Object.keys(sAfter.lastSeen) }));
      check("the panel shows the stream and counts", (await a.getByTestId("vault-stream-phase").getAttribute("data-phase")) === "connected" && Number(await a.getByTestId("vault-stream-counts").getAttribute("data-delivered")) > 0);

      // The secret-leak check with two tabs (the fake password and the fake JWTs).
      for (const [p, label] of [[a, "leader tab"], [b, "follower tab"]] as const) {
        const report = await findAppSecrets(p, [fakePass]);
        check(`two tabs, ${label}: no password or JWT readable from the app origin`, report.findings.length === 0 && (report.scanned["heap snapshot (app main frame)"] ?? 0) > 1e6, report.findings.map((f) => `${f.what} in ${f.where}`).join("; "));
      }
      const inFrames = await findInHeap(vaultFrame(b), [fakePass]);
      check("control: the follower's vault frame holds the shared login (password and token)", inFrames.some((f) => f.what === "secret") && inFrames.some((f) => f.what === "jwt"));

      // The leader's tab closes mid-stream: the follower takes over (no /token), and nothing is lost.
      const from2 = broker.log.length;
      broker.resetStats();
      const tok1 = tokenRequests.length;
      broker.startStream(RATE, TB);
      await Bun.sleep(1500);
      await a.close();
      const took = await waitFor("the takeover", b, (s) => s.tab.role === "leader" && s.stream?.phase === "connected", 15_000).catch((e) => e);
      check("leader tab closed: the follower becomes the leader and streams", !(took instanceof Error), took instanceof Error ? took.message : `${took.tab.id.slice(0, 6)} leads`);
      await Bun.sleep(2000);
      broker.stopStream();
      await Bun.sleep(1500);
      check("takeover without a passkey tap or /token (the login was shared in memory)", tokenRequests.length === tok1 && (await st(b)).state === "connected", `${tokenRequests.length - tok1} /token`);
      await compare("after the takeover, the new leader's tab", b, TB, from2);
      const sTake = (await st(b)).stream;
      check("takeover: gap-filled from the lastSeen the follower tracked; never more than 2 sessions", sTake.gapFilled > 0 && broker.stats.max <= 2, `${sTake.gapFilled} gap-filled, broker max ${broker.stats.max}`);

      await (await account(b)).getByTestId("vault-disconnect").click();
      await waitState(b, "disconnected");
      await waitFor("the stream to stop", b, (s) => s.stream?.sessions === 0, 5000).catch(() => {});
      check("disconnect: the stream closes", broker.sessions().length === 0, `${broker.sessions().length} open`);
      check("stream run: no page errors", pageErrors.length === 0, pageErrors.join(" | "));
    } catch (e) {
      check("stream run", false, e instanceof Error ? e.message : String(e));
    } finally {
      await ctx?.close().catch(() => {});
      rmSync(dir, { recursive: true, force: true });
      broker.stop();
      stop(devVault);
      for (let i = 0; i < 50 && (await up(`${VAULT}/frame.html`)); i++) await Bun.sleep(100);
    }
  }

  // ------------------------------------------------------------ step 2: login, storage, passkeys, leaks
  async function loginChecks() {
    // `page` still has the extra vault frame from the wrong-senders checks: two vault frames in one app
    // window, so the popup must reach the right one (the one expecting its ticket).
    console.log("login: errors");
    const popup = await openPopup(context, page, "vault-connect");
    check("Connect opens the vault popup on the vault origin", popup.url().startsWith(`${VAULT}/popup.html#mode=connect&ticket=`));
    check("popup inputs have password-manager autocomplete", (await popup.getByLabel("OpenF1 email").getAttribute("autocomplete")) === "username" && (await popup.getByLabel("OpenF1 password").getAttribute("autocomplete")) === "current-password");
    check("stay connected is the default", await popup.getByLabel("Stay connected on this device").isChecked());
    await submitLogin(popup, FAKE_USER, FAKE_PASS);
    let text = await popupError(popup);
    check("wrong password: the popup says so (real OpenF1 401)", /didn't accept/.test(text), text);
    check("wrong password: app still not connected", (await state(page)) === "disconnected");

    const nginx429 = "<html>\r\n<head><title>429 Too Many Requests</title></head>\r\n<body>\r\n<center><h1>429 Too Many Requests</h1></center>\r\n<hr><center>nginx</center>\r\n</body>\r\n</html>\r\n";
    await context.route(TOKEN_URL, (r: any) => r.fulfill({ status: 429, contentType: "text/html", headers: { "Access-Control-Allow-Origin": "*" }, body: nginx429 }));
    await popup.getByRole("button", { name: "Connect" }).click();
    await popup.waitForFunction(() => /limiting/.test(document.getElementById("error")!.textContent ?? ""), null, { timeout: 10_000 }).catch(() => {});
    text = (await popup.locator("#error").textContent()) ?? "";
    check("rate limited (429, nginx HTML): the popup says so", /limiting/.test(text), text);
    await context.unroute(TOKEN_URL);
    await context.route(TOKEN_URL, (r: any) => r.abort("internetdisconnected"));
    await popup.getByRole("button", { name: "Connect" }).click();
    await popup.waitForFunction(() => /reach OpenF1/.test(document.getElementById("error")!.textContent ?? ""), null, { timeout: 10_000 }).catch(() => {});
    text = (await popup.locator("#error").textContent()) ?? "";
    check("network error: the popup says so", /reach OpenF1/.test(text), text);
    await context.unroute(TOKEN_URL);

    console.log("login: stay connected");
    const before = tokenRequests.length;
    await submitLogin(popup, USERNAME, PASSWORD, "device");
    await waitClosed(popup);
    check("real login: the popup closes itself", (await closeCalls(popup)) > 0);
    await waitState(page, "connected");
    check("real login: app shows connected", true);
    check("exactly one /token request, from the vault frame", tokenRequests.length - before === 1 && tokenRequests.at(-1)!.startsWith(`${VAULT}/frame.html`), tokenRequests.slice(before).map((u) => u.split("#")[0]).join(", "));
    check("panel: stored on this device", (await page.getByTestId("vault-panel-mode").textContent()) === "on this device");
    check("panel: account masked", /^.\*\*\*@[^@]+$/.test((await page.getByTestId("vault-panel-account").textContent()) ?? ""));
    const expiry = (await page.getByTestId("vault-token-expiry").textContent()) ?? "";
    const expiryMin = Number(expiry.split(":")[0]);
    check("panel: token expiry countdown about an hour (expires_in parsed from a string)", expiryMin >= 55 && expiryMin <= 60, expiry);
    await popup.close();
    await Bun.sleep(700); // the app notices the closed popup and cancels (a no-op after success)
    check("closing the popup after success changes nothing", (await state(page)) === "connected");

    // Partitioning: the frame's IndexedDB (under the app's site) is not the vault's top-level one.
    const frame = vaultFrame(page);
    check("the vault frame is an out-of-process iframe (cross-site)", await vaultIsOutOfProcess(page, VAULT));
    check("the frame's IndexedDB has the login", (await frameRecords(frame)) === 1);
    const top = await context.newPage();
    await top.goto(`${VAULT}/popup.html`);
    const topDbs: string[] = await top.evaluate(async () => (await indexedDB.databases()).map((d) => d.name ?? ""));
    check("storage is partitioned: the vault's top-level IndexedDB doesn't have it", !topDbs.includes("f1-vault"), topDbs.join(","));
    await top.close();

    const authed = await vaultGet(page);
    check("get with a login: 200, authenticated", authed.status === 200 && authed.auth === true, JSON.stringify(authed));
    await leakCheck(page, "stay connected");
    // Positive control: the same search on the vault frame's own renderer finds both (the frame holds them).
    const inVault = await findInHeap(frame, [PASSWORD]);
    check("control: the same heap search finds the password and a JWT in the vault frame's process", inVault.some((f) => f.what === "secret") && inVault.some((f) => f.what === "jwt"));

    console.log("login: restore");
    let n = tokenRequests.length;
    let popups = 0;
    const countPopups = () => popups++;
    context.on("page", countPopups);
    await page.reload();
    await waitState(page, "connected");
    check("reload: connected again, silently (no popup)", popups === 0);
    check("reload: one /token request", tokenRequests.length - n === 1, tokenRequests.length - n);
    context.off("page", countPopups);

    await context.close();
    context = await launch();
    page = await context.newPage();
    page.on("pageerror", (e: Error) => errors.push(e.message));
    n = tokenRequests.length;
    await page.goto(`${APP}/?vault=debug`);
    await waitState(page, "connected");
    check("browser restart (same profile): connected silently", context.pages().length <= 2, context.pages().map((p: any) => p.url()).join(", "));
    check("browser restart: one /token request", tokenRequests.length - n === 1, tokenRequests.length - n);

    console.log("disconnect");
    await (await account(page)).getByTestId("vault-disconnect").click();
    await waitState(page, "disconnected");
    check("disconnect: not connected", true);
    check("disconnect: panel has no account or expiry", (await page.getByTestId("vault-panel-account").count()) === 0 && (await page.getByTestId("vault-token-expiry").count()) === 0);
    check("disconnect: the frame's IndexedDB is empty", (await frameRecords(vaultFrame(page))) === 0);
    await page.reload();
    await waitState(page, "disconnected");
    check("disconnect: still not connected after a reload", true);

    console.log("passkey without PRF");
    const noPrf = await openPopup(context, page, "vault-connect");
    await addAuthenticator(context, noPrf, false);
    await submitLogin(noPrf, USERNAME, PASSWORD, "passkey");
    await noPrf.locator("#use-device:not([hidden])").waitFor({ timeout: 20_000 });
    await noPrf.waitForFunction(() => /PRF/.test(document.getElementById("passkey-text")!.textContent ?? ""), null, { timeout: 20_000 });
    check("authenticator without PRF: the popup says so and offers stay-connected", true);
    check("while the popup waits, nothing is stored", (await frameRecords(vaultFrame(page))) === 0);
    await noPrf.getByRole("button", { name: "Stay connected on this device instead" }).click();
    await waitClosed(noPrf);
    await waitState(page, "connected");
    check("no PRF -> stay connected: connected, stored on this device", (await page.getByTestId("vault-panel-mode").textContent()) === "on this device");
    await noPrf.close();
    await (await account(page)).getByTestId("vault-disconnect").click();
    await waitState(page, "disconnected");

    console.log("passkey");
    const pk = await openPopup(context, page, "vault-connect");
    const auth = await addAuthenticator(context, pk, true);
    await submitLogin(pk, USERNAME, PASSWORD, "passkey");
    await waitClosed(pk, 30_000);
    await waitState(page, "connected");
    check("passkey: connected, behind a passkey", (await page.getByTestId("vault-panel-mode").textContent()) === "behind a passkey");
    const creds = (await auth.cdp.send("WebAuthn.getCredentials", { authenticatorId: auth.authenticatorId })).credentials;
    check("passkey: one discoverable credential for the vault's hostname", creds.length === 1 && creds[0].isResidentCredential && creds[0].rpId === new URL(VAULT).hostname, creds.map((c: any) => c.rpId).join(","));
    await leakCheck(page, "passkey setup");

    n = tokenRequests.length;
    await page.reload();
    await waitState(page, "locked");
    check("passkey: reload shows locked", true);
    check("locked: no /token request (nothing to decrypt with)", tokenRequests.length - n === 0, tokenRequests.length - n);
    check("locked: the chip offers Unlock", await (await account(page)).getByTestId("vault-unlock").isVisible());
    await openPopup(context, page, "vault-unlock", pk);
    check("Unlock reopens the vault popup in unlock mode", pk.url().includes("#mode=unlock&ticket="));
    const closedBefore = await closeCalls(pk);
    await pk.waitForFunction((b: number) => (window as any).__closeCalls > b, closedBefore, { timeout: 30_000 }).catch(() => {});
    await waitState(page, "connected", 10_000).catch(() => {});
    check("unlock: one passkey tap -> connected", (await state(page)) === "connected", await pk.locator("#error").textContent());
    check("unlock: one /token request", tokenRequests.length - n === 1, tokenRequests.length - n);
    await leakCheck(page, "passkey unlock");
    await pk.close();

    await (await account(page)).getByTestId("vault-disconnect").click();
    await waitState(page, "disconnected");
    await page.reload();
    await waitState(page, "disconnected");
    check("passkey disconnect: wiped (not connected after reload, IndexedDB empty)", (await frameRecords(vaultFrame(page))) === 0);
  }
}

try {
  await main();
} catch (e) {
  console.error(redact(e instanceof Error ? (e.stack ?? e.message) : String(e)));
  failures++;
} finally {
  evil.stop(true);
  for (const p of started) stop(p);
}
console.log(failures ? `\n${failures} check(s) failed` : "\nall vault checks passed");
process.exit(failures ? 1 : 0);
