// The setup popup (popup.html), top level on the vault's own origin. The app opens it from a click
// (`popup.html#mode=connect|unlock&ticket=…`) and tells its vault frame to expect that ticket.
//
// Chrome partitions the frame's storage by the app's site, so this page can't store anything the frame
// could read. It stores nothing: it finds the vault frame in the app window (`opener.frames`), sends it the
// login (targetOrigin = this origin, so only a vault frame can receive it), and the frame checks it with
// OpenF1 and keeps it. The passkey prompts run here because the hidden frame never gets a click.

import { LOGIN_MESSAGES } from "./openf1";
import {
  isTicket,
  parseFrameMessage,
  PASSWORD_MAX,
  type FrameToPopup,
  type LoginError,
  type PopupMessage,
  type PopupResult,
  type PopupWelcome,
  type StorageMode,
} from "./protocol";

const ORIGIN = location.origin;
const HELLO_EVERY_MS = 250;
const HELLO_FOR_MS = 4_000;
/** A login check includes a round trip to OpenF1. */
const ANSWER_MS = 45_000;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const ui = {
  title: $("title"),
  progress: $("progress"),
  error: $("error"),
  form: $<HTMLFormElement>("login"),
  username: $<HTMLInputElement>("username"),
  password: $<HTMLInputElement>("password"),
  submit: $<HTMLButtonElement>("submit"),
  passkeyStep: $("passkey-step"),
  passkeyText: $("passkey-text"),
  passkeyRetry: $<HTMLButtonElement>("passkey-retry"),
  useDevice: $<HTMLButtonElement>("use-device"),
  unlock: $("unlock"),
  account: $("account"),
  unlockButton: $<HTMLButtonElement>("unlock-button"),
  done: $("done"),
};
ui.password.maxLength = PASSWORD_MAX;

function show(section: "form" | "passkeyStep" | "unlock" | "done" | null) {
  for (const s of ["form", "passkeyStep", "unlock", "done"] as const) ui[s].hidden = s !== section;
}
function progress(text: string) {
  ui.progress.textContent = text;
  ui.progress.hidden = !text;
}
function error(e: LoginError | string | null) {
  ui.error.textContent = e === null ? "" : typeof e === "string" ? e : e.message;
  ui.error.hidden = e === null;
}

// The app reopens this window by name for a second Connect / Unlock click. Only the #fragment (the new
// ticket) changes then, which doesn't reload the page: start over with the new ticket.
window.addEventListener("hashchange", () => location.reload());

// Dev vault in simulate mode only (a build has false here and drops it): the login is fake, so say so, and
// keep real passwords out of it.
if (__VAULT_DEV__ && __VAULT_SIMULATE__) {
  const sim = document.createElement("p");
  sim.dataset.testid = "popup-sim";
  // (CSSOM, not a style attribute: the CSP has no 'unsafe-inline'; and nothing of it in the build's popup.css.)
  Object.assign(sim.style, { border: "1px solid #b45309", background: "#451a03", color: "#fcd34d", borderRadius: "6px", padding: "0.5rem 0.75rem", fontSize: "12px", fontWeight: "600" });
  sim.textContent = "SIMULATED: this dev vault replays a recorded session. Any email and password work; don't use your real OpenF1 password.";
  ui.title.after(sim);
}

const hash = new URLSearchParams(location.hash.slice(1));
const ticket = hash.get("ticket");
const mode = hash.get("mode") === "unlock" ? "unlock" : "connect";
if (mode === "unlock") {
  ui.title.textContent = "Unlock your OpenF1 login";
  document.title = "Unlock your OpenF1 login · Pitwall vault";
}

// ---------------------------------------------------------------- talking to the frame

/** The vault frame that answered our hello: the only window we talk to from then on. */
let frame: MessageEventSource | null = null;
let onAnswer: ((m: FrameToPopup) => void) | null = null;

window.addEventListener("message", (e: MessageEvent) => {
  if (e.origin !== ORIGIN || !e.source || (frame && e.source !== frame)) return;
  const msg = parseFrameMessage(e.data);
  if (!msg || msg.ticket !== ticket) return;
  if (!frame && msg.type === "popup:welcome") frame = e.source;
  onAnswer?.(msg);
});

function send(msg: PopupMessage) {
  frame!.postMessage(msg, { targetOrigin: ORIGIN });
}

/** Post a hello to every frame of the app window; the one expecting our ticket answers. */
function findFrame(): Promise<PopupWelcome | PopupResult | null> {
  return new Promise((resolve) => {
    const hello: PopupMessage = { v: 1, type: "popup:hello", ticket: ticket! };
    const ping = () => {
      const w = window.opener as Window | null;
      if (!w) return;
      for (let i = 0; i < w.frames.length; i++) {
        try {
          // targetOrigin: our own origin, so only a vault frame can receive it.
          w.frames[i]!.postMessage(hello, ORIGIN);
        } catch {}
      }
    };
    const timer = setInterval(ping, HELLO_EVERY_MS);
    const giveUp = setTimeout(() => finish(null), HELLO_FOR_MS);
    const finish = (m: PopupWelcome | PopupResult | null) => {
      clearInterval(timer);
      clearTimeout(giveUp);
      onAnswer = null;
      resolve(m);
    };
    onAnswer = (m) => finish(m);
    ping();
  });
}

function ask(msg: PopupMessage): Promise<PopupResult> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      onAnswer = null;
      resolve({ v: 1, type: "popup:result", ticket: ticket!, ok: false, error: { code: "network", message: "The vault didn't answer. Close this window and try again." } });
    }, ANSWER_MS);
    onAnswer = (m) => {
      if (m.type !== "popup:result") return;
      clearTimeout(timer);
      onAnswer = null;
      resolve(m);
    };
    send(msg);
  });
}

// ---------------------------------------------------------------- passkeys (WebAuthn PRF)

const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));
const prfInput = (salt: ArrayBuffer) => ({ prf: { eval: { first: salt } } }) as AuthenticationExtensionsClientInputs;

type PrfOutcome = { prf: ArrayBuffer; credentialId: ArrayBuffer } | { unsupported: true; credentialId?: ArrayBuffer } | { failed: string };

function prfFirst(cred: PublicKeyCredential): ArrayBuffer | null {
  const out = (cred.getClientExtensionResults() as { prf?: { enabled?: boolean; results?: { first?: BufferSource } } }).prf;
  const first = out?.results?.first;
  if (!first) return null;
  const bytes = first instanceof ArrayBuffer ? new Uint8Array(first) : new Uint8Array(first.buffer, first.byteOffset, first.byteLength);
  return bytes.byteLength === 32 ? bytes.slice().buffer : null;
}

async function getPrf(credentialId: ArrayBuffer, salt: ArrayBuffer): Promise<ArrayBuffer | null> {
  const cred = (await navigator.credentials.get({
    publicKey: {
      challenge: random(32),
      rpId: location.hostname,
      allowCredentials: [{ type: "public-key", id: credentialId }],
      userVerification: "required",
      timeout: 120_000,
      extensions: prfInput(salt),
    },
  })) as PublicKeyCredential | null;
  return cred ? prfFirst(cred) : null;
}

/** A new discoverable passkey for this vault, and its PRF output for `salt`. */
async function createPasskey(username: string, salt: ArrayBuffer): Promise<PrfOutcome> {
  let cred: PublicKeyCredential | null;
  try {
    cred = (await navigator.credentials.create({
      publicKey: {
        rp: { id: location.hostname, name: "Pitwall vault" },
        user: { id: random(16), name: username, displayName: `OpenF1: ${username}` },
        challenge: random(32),
        pubKeyCredParams: [
          { type: "public-key", alg: -7 },
          { type: "public-key", alg: -257 },
        ],
        authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "required" },
        attestation: "none",
        timeout: 120_000,
        extensions: prfInput(salt),
      },
    })) as PublicKeyCredential | null;
  } catch (e) {
    return { failed: e instanceof DOMException && e.name === "NotAllowedError" ? "The passkey wasn't created (cancelled or timed out)." : "This browser couldn't create a passkey." };
  }
  if (!cred) return { failed: "The passkey wasn't created." };
  const credentialId = cred.rawId;
  const now = prfFirst(cred);
  if (now) return { prf: now, credentialId };
  // Some authenticators only evaluate PRF on get(): ask once more, straight away.
  const enabled = (cred.getClientExtensionResults() as { prf?: { enabled?: boolean } }).prf?.enabled;
  if (enabled === false) return { unsupported: true, credentialId };
  try {
    const later = await getPrf(credentialId, salt);
    return later ? { prf: later, credentialId } : { unsupported: true, credentialId };
  } catch {
    return { failed: "The passkey was created but didn't answer. Try again, or stay connected on this device instead." };
  }
}

/** A passkey we made but can't use: ask the passkey manager to drop it (Chrome's WebAuthn Signal API). */
function forgetPasskey(credentialId: ArrayBuffer) {
  const signal = (PublicKeyCredential as unknown as { signalUnknownCredential?: (o: { rpId: string; credentialId: string }) => Promise<void> }).signalUnknownCredential;
  if (!signal) return;
  const b64 = btoa(String.fromCharCode(...new Uint8Array(credentialId)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
  void signal({ rpId: location.hostname, credentialId: b64 }).catch(() => {});
}

// ---------------------------------------------------------------- flows

async function finished(saveUsername?: string, savePassword?: string) {
  show("done");
  progress("");
  error(null);
  // Offer the browser's password manager the login (the form has no action to submit, so help it).
  const PC = (window as unknown as { PasswordCredential?: new (d: { id: string; password: string }) => Credential }).PasswordCredential;
  if (PC && saveUsername && savePassword) {
    try {
      await Promise.race([navigator.credentials.store(new PC({ id: saveUsername, password: savePassword })), new Promise((r) => setTimeout(r, 1500))]);
    } catch {}
  }
  window.close();
}

async function connectFlow(welcome: Extract<PopupWelcome, { kind: "connect" }>) {
  show("form");
  progress("");
  ui.username.focus();
  let busy = false;
  ui.form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    if (busy) return;
    const username = ui.username.value.trim();
    const password = ui.password.value;
    const storage = (new FormData(ui.form).get("storage") === "passkey" ? "passkey" : "device") as StorageMode;
    busy = true;
    ui.submit.disabled = true;
    error(null);
    progress("Checking your login with OpenF1…");
    const r = await ask({ v: 1, type: "popup:login", ticket: ticket!, username, password, mode: storage });
    busy = false;
    ui.submit.disabled = false;
    progress("");
    if (!r.ok) {
      error(r.error);
      if (r.error.code === "wrong_credentials") ui.password.select();
      if (r.error.code === "expired") show(null);
      return;
    }
    if (r.next === "done") return void finished(username, password);
    // Passkey: the frame has checked the login and waits for the PRF output.
    show("passkeyStep");
    await passkeySetup(username, password, welcome.prfSalt);
  });
}

async function passkeySetup(username: string, password: string, salt: ArrayBuffer) {
  const buttons = (on: boolean) => ((ui.passkeyRetry.disabled = !on), (ui.useDevice.disabled = !on));
  const attempt = async () => {
    buttons(false);
    error(null);
    ui.passkeyRetry.hidden = false;
    progress("Follow your browser's passkey prompt…");
    const out = await createPasskey(username, salt);
    progress("");
    buttons(true);
    if ("failed" in out) return error(out.failed);
    if ("unsupported" in out) {
      if (out.credentialId) forgetPasskey(out.credentialId);
      ui.passkeyText.textContent =
        "Your passkey or browser can't unlock a login: it doesn't support the passkey PRF extension. You can stay connected on this device instead.";
      ui.passkeyRetry.hidden = true;
      return;
    }
    buttons(false);
    progress("Saving your login…");
    const r = await ask({ v: 1, type: "popup:passkey", ticket: ticket!, credentialId: out.credentialId, prf: out.prf });
    new Uint8Array(out.prf).fill(0);
    progress("");
    buttons(true);
    if (!r.ok) return error(r.error);
    void finished(username, password);
  };
  ui.passkeyRetry.addEventListener("click", () => void attempt());
  ui.useDevice.addEventListener("click", async () => {
    buttons(false);
    error(null);
    progress("Saving your login…");
    const r = await ask({ v: 1, type: "popup:device", ticket: ticket! });
    progress("");
    buttons(true);
    if (!r.ok) return error(r.error);
    void finished(username, password);
  });
  await attempt();
}

function unlockFlow(welcome: Extract<PopupWelcome, { kind: "unlock" }>) {
  show("unlock");
  progress("");
  ui.account.textContent = welcome.account;
  const attempt = async () => {
    ui.unlockButton.disabled = true;
    error(null);
    progress("Follow your browser's passkey prompt…");
    let prf: ArrayBuffer | null = null;
    try {
      prf = await getPrf(welcome.credentialId, welcome.prfSalt);
      if (!prf) error("This passkey can't unlock the login (no PRF output). Disconnect in the app and connect again.");
    } catch (e) {
      error(e instanceof DOMException && e.name === "NotAllowedError" ? "The passkey prompt was cancelled or timed out." : "The passkey prompt failed.");
    }
    if (!prf) {
      progress("");
      ui.unlockButton.disabled = false;
      return;
    }
    progress("Unlocking…");
    const r = await ask({ v: 1, type: "popup:unlock", ticket: ticket!, prf });
    new Uint8Array(prf).fill(0);
    progress("");
    ui.unlockButton.disabled = false;
    if (!r.ok) return error(r.error);
    void finished();
  };
  ui.unlockButton.addEventListener("click", () => void attempt());
  void attempt();
}

async function main() {
  if (!isTicket(ticket) || !window.opener) {
    progress("");
    return error("Open this window with the Connect button in Pitwall.");
  }
  const welcome = await findFrame();
  if (!welcome) {
    progress("");
    return error(LOGIN_MESSAGES.expired);
  }
  if (welcome.type === "popup:result") {
    progress("");
    return error(welcome.ok ? LOGIN_MESSAGES.expired : welcome.error);
  }
  if (welcome.kind === "connect") await connectFlow(welcome);
  else unlockFlow(welcome);
}

void main();
