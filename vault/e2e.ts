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

import { execSync, spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("..", import.meta.url)); // vault/ -> the repo
const args = process.argv.slice(2);
const DEV = args.includes("--dev");
const HEADED = args.includes("--headed");

const APP = "http://127.0.0.1:5173";
const VAULT = "http://localhost:5174";
const EVIL_PORT = Number(process.env.VAULT_E2E_EVIL_PORT || 5188);
const EVIL = `http://127.0.0.1:${EVIL_PORT}`;

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
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
}

/** In every frame, before any page script: record CSP violations. Init scripts bypass CSP. */
const RECORD_CSP = `(() => {
  window.__csp = [];
  addEventListener("securitypolicyviolation", (e) => window.__csp.push(e.violatedDirective + " " + e.blockedURI));
})();`;

const vaultFrame = (page: any) => page.frames().find((f: any) => f.url().startsWith(`${VAULT}/frame.html`));

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

  const browser = await chromium.launch({ headless: !HEADED });
  const context = await browser.newContext();
  await context.addInitScript(RECORD_CSP);
  const consoleCsp: string[] = [];
  context.on("page", (p: any) =>
    p.on("console", (m: any) => {
      if (/Content Security Policy|Refused to/i.test(m.text())) consoleCsp.push(m.text());
    }),
  );

  try {
    // 1. Handshake and status round trip.
    console.log("handshake");
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e: Error) => errors.push(e.message));
    await page.goto(`${APP}/?vault=debug`);
    await page.getByTestId("vault-phase").filter({ hasText: /ready|unavailable/ }).waitFor({ timeout: 15_000 });
    const phase = await page.getByTestId("vault-phase").textContent();
    check("handshake completes", phase === "ready", `phase ${phase}`);
    await page.locator("[data-vault-phase=ready]").getByText("not connected").waitFor({ timeout: 5000 });
    check("chip shows not connected", true);
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
    await popup.close();

    const vaultConsoleCsp = consoleCsp.filter((t) => !/frame-ancestors/.test(t));
    check("no CSP console errors (apart from the expected frame-ancestors blocks)", vaultConsoleCsp.length === 0, vaultConsoleCsp.join(" | "));
    check("no page errors on the app", errors.length === 0, errors.join(" | "));
    await page.close();

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
    await browser.close();
  }
}

try {
  await main();
} catch (e) {
  console.error(e);
  failures++;
} finally {
  evil.stop(true);
  for (const p of started) stop(p);
}
console.log(failures ? `\n${failures} check(s) failed` : "\nall vault checks passed");
process.exit(failures ? 1 : 0);
