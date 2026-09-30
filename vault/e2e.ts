// Browser check of the credential vault (spike S3), cross-SITE like production: the app on
// http://127.0.0.1:5173 and the vault on http://localhost:5174 (different sites: 127.0.0.1 vs localhost).
//
//   bun run vault:e2e            the built vault (vault:build, then serve.ts: the exact production headers)
//   bun run vault:e2e --dev      the vault dev server instead (bun run vault)
//   bun run vault:e2e --headed
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

import { execSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { findAppSecrets, findInHeap, vaultIsOutOfProcess } from "./leakcheck";

const repo = fileURLToPath(new URL("..", import.meta.url)); // vault/ -> the repo
const args = process.argv.slice(2);
const DEV = args.includes("--dev");
const HEADED = args.includes("--headed");

const APP = "http://127.0.0.1:5173";
const VAULT = "http://localhost:5174";
const EVIL_PORT = Number(process.env.VAULT_E2E_EVIL_PORT || 5188);
const EVIL = `http://127.0.0.1:${EVIL_PORT}`;
const TOKEN_URL = "https://api.openf1.org/token";

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

const state = (page: any) => page.getByTestId("vault-state").getAttribute("data-state");
async function waitState(page: any, want: string, ms = 20_000) {
  await page.locator(`[data-testid=vault-state][data-state=${want}]`).waitFor({ timeout: ms });
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
async function openPopup(context: any, page: any, testId: "vault-connect" | "vault-unlock", reuse?: any) {
  if (reuse) {
    const nav = reuse.waitForEvent("load");
    await page.getByTestId(testId).click();
    await nav;
    return reuse;
  }
  const popupP = page.waitForEvent("popup");
  await page.getByTestId(testId).click();
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

async function popupError(popup: any, ms = 20_000): Promise<string> {
  await popup.locator("#error:not([hidden])").waitFor({ timeout: ms });
  return (await popup.locator("#error").textContent()) ?? "";
}

async function main() {
  const { chromium } = playwright();

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

  // A persistent profile, so "after a browser restart" is a real restart of the same profile.
  const profile = mkdtempSync(join(tmpdir(), "vault-e2e-"));
  const consoleCsp: string[] = [];
  const tokenRequests: string[] = [];
  const launch = async () => {
    const ctx = await chromium.launchPersistentContext(profile, { headless: !HEADED, viewport: { width: 1280, height: 800 }, args: CHROME_AS_SHIPPED });
    await ctx.addInitScript(RECORD_CSP);
    await ctx.addInitScript(KEEP_POPUP);
    ctx.on("page", (p: any) =>
      p.on("console", (m: any) => {
        if (/Content Security Policy|Refused to/i.test(m.text())) consoleCsp.push(m.text());
      }),
    );
    ctx.on("request", (r: any) => {
      if (r.url() === TOKEN_URL) tokenRequests.push(r.frame()?.url?.() ?? "?");
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
    check("chip shows not connected", (await page.getByTestId("vault-state").textContent()) === "not connected");
    await page.getByRole("button", { name: "Measure status round trip" }).click();
    const ping = await page.getByTestId("vault-ping").textContent({ timeout: 10_000 });
    check("status round trips", /ms median of 20/.test(ping ?? ""), ping ?? "");

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

    // 6. A popup whose ticket no frame is expecting: no frame answers, it says it expired.
    const staleP = page.waitForEvent("popup");
    await page.evaluate((v: string) => void window.open(`${v}/popup.html#mode=connect&ticket=${"s".repeat(22)}`, "stale"), VAULT);
    const stale = await staleP;
    const staleText = await popupError(stale, 10_000);
    check("a popup with a stale ticket is ignored by every frame and says it expired", /expired/.test(staleText), staleText);
    check("its form never appears", !(await stale.locator("#login").isVisible()));
    await stale.close();

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
      check("vault down: home still renders", await down.getByRole("heading", { name: "F1 Race Replay" }).isVisible());
      check("vault down: no page errors", downErrors.length === 0, downErrors.join(" | "));
    } else {
      console.log("(skipping the vault-down check: the vault server wasn't started by this script)");
    }
  } finally {
    await context.close();
    rmSync(profile, { recursive: true, force: true });
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
    await page.getByTestId("vault-disconnect").click();
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
    await page.getByTestId("vault-disconnect").click();
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
    check("locked: the chip offers Unlock", await page.getByTestId("vault-unlock").isVisible());
    await openPopup(context, page, "vault-unlock", pk);
    check("Unlock reopens the vault popup in unlock mode", pk.url().includes("#mode=unlock&ticket="));
    const closedBefore = await closeCalls(pk);
    await pk.waitForFunction((b: number) => (window as any).__closeCalls > b, closedBefore, { timeout: 30_000 }).catch(() => {});
    await waitState(page, "connected", 10_000).catch(() => {});
    check("unlock: one passkey tap -> connected", (await state(page)) === "connected", await pk.locator("#error").textContent());
    check("unlock: one /token request", tokenRequests.length - n === 1, tokenRequests.length - n);
    await leakCheck(page, "passkey unlock");
    await pk.close();

    await page.getByTestId("vault-disconnect").click();
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
