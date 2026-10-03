// The vault's message protocol: the single source of truth for both sides.
//
// The app imports TYPES only from this file (`import type`); the validators below run inside the vault.
// Nothing here can carry a password or a token: there is no message that returns one.
//
// 1. Handshake, over window.postMessage (see frame.ts):
//      vault -> app   {v:1, type:"ready"}             targetOrigin = the app's exact origin
//      app -> vault   {v:1, type:"hello"} + 1 port    (a MessagePort from a MessageChannel)
// 2. Everything after that goes over the port:
//      app -> vault   {v:1, id, type, ...args}         a request (Request below)
//      vault -> app   {v:1, id, ok:true, result}       its response
//                     {v:1, id, ok:false, error}
//      vault -> app   {v:1, type:"event", ...}         unsolicited (VaultEvent below)

export const PROTOCOL_VERSION = 1;

/** Hard caps on anything inbound. Bigger or longer means invalid, not truncated. */
export const LIMITS = {
  /** Topics per subscribe / unsubscribe. */
  topics: 32,
  /** Query parameters per get. */
  params: 8,
  /** Length of a query parameter value. */
  paramValue: 64,
  /** Largest request id (ids are non-negative safe integers below this). */
  id: 2 ** 31,
} as const;

/** OpenF1 v1 REST endpoints `get` may read: what src/ingest, scripts/openf1.ts and the live relay use. */
export const REST_ENDPOINTS = [
  "car_data",
  "drivers",
  "intervals",
  "laps",
  "location",
  "meetings",
  "overtakes",
  "pit",
  "position",
  "race_control",
  "session_result",
  "sessions",
  "stints",
  "team_radio",
  "weather",
] as const;
export type RestEndpoint = (typeof REST_ENDPOINTS)[number];

/** OpenF1 MQTT topics (`v1/<topic>`) `subscribe` accepts: live mode's set (src/live/topics.ts). */
export const LIVE_TOPICS = [
  "car_data",
  "drivers",
  "intervals",
  "laps",
  "location",
  "overtakes",
  "pit",
  "position",
  "race_control",
  "session_result",
  "sessions",
  "stints",
  "team_radio",
  "weather",
] as const;
export type LiveTopic = (typeof LIVE_TOPICS)[number];

/** Query parameter names `get` accepts, each optionally with a comparison suffix (`date>`, `lap_number<=`). */
export const PARAM_KEYS = [
  "session_key",
  "meeting_key",
  "driver_number",
  "year",
  "session_type",
  "session_name",
  "date",
  "date_start",
  "lap_number",
] as const;
export const PARAM_OPS = ["", ">", "<", ">=", "<="] as const;
/** Values: numbers, or short strings of the characters dates and names need (`2024-03-02T15:00:00+00:00`, `Race`). */
const PARAM_VALUE = /^[A-Za-z0-9 :.+_-]*$/;

export type Params = Record<string, string | number>;

// ---------------------------------------------------------------- messages

export type Ready = { v: 1; type: "ready" };
export type Hello = { v: 1; type: "hello" };

/**
 * A popup ticket: random, made by the app when it opens the setup popup (in the popup's URL hash) and sent
 * to its own frame with `connect` / `unlock`. It pairs the popup with the one frame that is waiting for it
 * (other vault frames in the same app window ignore it) and lets the frame reject stale popups.
 */
export type Ticket = string;
const TICKET = /^[A-Za-z0-9_-]{22,64}$/;
export const isTicket = (x: unknown): x is Ticket => typeof x === "string" && TICKET.test(x);

/** Each method: its arguments (besides v, id, type), its result, and how many ports come with the request. */
export type Methods = {
  status: { args: {}; result: VaultStatus };
  /**
   * The app has just opened the setup popup (`popup.html#mode=connect&ticket=…`) from a click: expect it.
   * The login itself goes popup -> frame directly (PopupMessage), never through the app.
   */
  connect: { args: { ticket: Ticket }; result: VaultStatus };
  /** Same, for a passkey-locked login: the popup runs the passkey prompt and hands the frame its PRF output. */
  unlock: { args: { ticket: Ticket }; result: VaultStatus };
  /** The popup was closed: stop expecting it (and drop a half-finished setup). Ignored for a stale ticket. */
  cancel: { args: { ticket: Ticket }; result: VaultStatus };
  /** Forget the stored login (storage and memory) and close the live connection. */
  disconnect: { args: {}; result: VaultStatus };
  /**
   * Live topics for this port. The leader frame streams the union across every tab (one MQTT connection per
   * browser) and pushes `data` events for these topics. Result: this port's topics after the change.
   */
  subscribe: { args: { topics: LiveTopic[] }; result: { topics: LiveTopic[] } };
  unsubscribe: { args: { topics: LiveTopic[] }; result: { topics: LiveTopic[] } };
  /**
   * An OpenF1 read. The body is the raw response, transferred. With a valid token it's authenticated
   * (`auth: true`; a 401 refreshes the token and retries once). Without one (no login, locked, the token
   * expired while refreshes fail) it goes out unauthenticated, which is enough for historical data.
   * Requests run in parallel within one budget per browser (budget.ts: OpenF1's rate limits, live gap-fills
   * first, the ports taking turns); a 429 is retried after a pause. `rate_limited`: this port has too many
   * queued already.
   */
  get: { args: { endpoint: RestEndpoint; params: Params }; result: GetResult };
  /**
   * A second port (transferred with the request) that speaks this same protocol, e.g. for the download worker.
   * At most MAX_PORTS (rpc.ts) are open; at the cap, the one idle longest is dropped for the new one.
   */
  openPort: { args: {}; result: {} };
  /**
   * Done with this port (MessagePorts have no close event): its queued gets are dropped, its subscriptions
   * removed, and nothing more is answered on it.
   */
  close: { args: {}; result: {} };
  // Dev-only testing knobs (DEBUG_METHODS). A production vault is built without them and rejects these as
  // unknown types, so no app code can make it misuse the token or hammer /token.
  /** Corrupt the in-memory token: the next authenticated get gets a real 401 from OpenF1. */
  "debug:spoilToken": { args: {}; result: VaultStatus };
  /** Treat every new token as lasting `seconds` (0: the real lifetime). Applies from the next token. */
  "debug:fakeExpiry": { args: { seconds: number }; result: VaultStatus };
  /** Refresh the token now (the same path a scheduled refresh takes). */
  "debug:refreshNow": { args: {}; result: VaultStatus };
  /** The next `times` /token calls answer `status` without reaching OpenF1 (0 times: clear). */
  "debug:failToken": { args: { status: 401 | 429 | 503; times: number }; result: VaultStatus };
  /**
   * Freeze THIS frame (not forwarded to the leader) for `ms`, like Chrome freezing a background tab: its
   * timers, sockets, channel and port messages, lock callbacks and fetch answers wait, then run in order.
   */
  "debug:freeze": { args: { ms: number }; result: VaultStatus };
  /** Simulate mode: a fault at the simulated broker ("drop" every session now, "refuse" the next CONNECT with CONNACK 5). */
  "debug:sim": { args: { action: SimAction }; result: VaultStatus };
};
export type Method = keyof Methods;
export const METHODS = ["status", "connect", "unlock", "cancel", "disconnect", "subscribe", "unsubscribe", "get", "openPort", "close"] as const satisfies readonly Method[];
export const DEBUG_METHODS = ["debug:spoilToken", "debug:fakeExpiry", "debug:refreshNow", "debug:failToken", "debug:freeze", "debug:sim"] as const satisfies readonly Method[];
export const SIM_ACTIONS = ["drop", "refuse"] as const;
export type SimAction = (typeof SIM_ACTIONS)[number];
/** debug:freeze bounds (ms). */
export const FREEZE_MS = { min: 1000, max: 120_000 } as const;
export type DebugMethod = (typeof DEBUG_METHODS)[number];
/** debug:fakeExpiry bounds (seconds), besides 0 = off. */
export const FAKE_EXPIRY = { min: 20, max: 3600 } as const;

export type GetResult = { status: number; body: ArrayBuffer; auth: boolean };

export type Request<M extends Method = Method> = M extends Method ? { v: 1; id: number; type: M } & Methods[M]["args"] : never;

export type ErrorCode = "bad_request" | "not_implemented" | "not_connected" | "rate_limited" | "busy" | "unavailable" | "network" | "internal";
export type VaultError = { code: ErrorCode; message: string };

export type Response<M extends Method = Method> =
  | { v: 1; id: number; ok: true; result: Methods[M]["result"] }
  | { v: 1; id: number; ok: false; error: VaultError };

/**
 * - unavailable: the vault can't keep a login here (its storage is blocked, e.g. third-party storage off).
 * - disconnected: no login stored.
 * - locked: a passkey-protected login is stored; the user has to unlock it (one tap, in the popup).
 * - connecting: checking a login with OpenF1 (restore on load, a popup login, an unlock).
 * - connected: the vault holds a working token (in memory only).
 * - error: a login is stored but didn't work (see `error`): reconnect or disconnect.
 */
export type VaultState = "unavailable" | "disconnected" | "locked" | "connecting" | "connected" | "error";
/** "device": stay connected on this device (non-extractable key). "passkey": unlock with a passkey (PRF). */
export type StorageMode = "device" | "passkey";

/** Why a login failed: shown in the popup, and in the status when a stored login stops working. */
export type LoginErrorCode =
  | "wrong_credentials" // OpenF1 401
  | "rate_limited" // OpenF1 429 (nginx, on bursts)
  | "network" // fetch failed (offline, DNS, CSP, CORS)
  | "server" // OpenF1 5xx, or a response we can't read
  | "storage" // the stored login can't be read or written
  | "passkey" // the passkey didn't unlock it (wrong passkey, no PRF output)
  | "expired"; // the popup's ticket is stale
export type LoginError = { code: LoginErrorCode; message: string };

/**
 * The token refresh (scheduler.ts):
 * - off: no login in memory.
 * - scheduled: a good token; the next refresh is at nextRefreshAt (5/6 of its lifetime).
 * - refreshing: a /token call is in flight.
 * - retrying: the last refresh failed; the current token still works; next try at nextRefreshAt.
 * - expired: refreshes keep failing and the token has run out (gets go unauthenticated); retrying at the cap.
 * - stopped: /token refused the login (password changed or revoked): needsReauth. The current token is
 *   used until it expires; nothing more is asked of OpenF1 until the user reconnects.
 */
export type RefreshPhase = "off" | "scheduled" | "refreshing" | "retrying" | "expired" | "stopped";
/** Why the last refresh failed: a /token error, or "rejected" (OpenF1 refused a token it had just issued). */
export type RefreshError = LoginErrorCode | "rejected";
export type RefreshStatus = {
  tokenExpiresAt?: number;
  nextRefreshAt?: number;
  lastRefresh?: { at: number; ok: boolean; error?: RefreshError };
  /** Silent refreshes since the login / restore / unlock. */
  refreshCount?: number;
  /** Show "Reconnect your OpenF1 account". */
  needsReauth?: boolean;
  refresh?: RefreshPhase;
};

/**
 * The live stream (live.ts), run by the leader frame (tabs.ts) for the union of every tab's subscriptions:
 * - off: nothing subscribed, or no login.
 * - waiting: subscribed, but there's no valid token yet (not connected, locked, refresh failing).
 * - connecting: the first session is being opened.
 * - connected: streaming.
 * - handover: a new session (new token) is subscribed; the old one closes after a short overlap.
 * - reconnecting: the session dropped; a new one is being opened (with backoff).
 * - gap-filling: reconnected; fetching what was missed over REST before resuming live.
 * - connection-limit: the broker refused a session (CONNACK 5) with a token that is still valid: the
 *   account's 10-connection cap. The current session (if any) keeps streaming; retried with backoff.
 */
export type StreamPhase = "off" | "waiting" | "connecting" | "connected" | "handover" | "reconnecting" | "gap-filling" | "connection-limit";
export type StreamStatus = {
  phase: StreamPhase;
  /** The union of every tab's subscriptions. */
  topics: LiveTopic[];
  /** MQTT sessions open now (connecting or connected): 1, or 2 during a handover. */
  sessions: number;
  /** The most that were ever open at once (by this leader). */
  maxSessions: number;
  handovers: number;
  reconnects: number;
  /** Messages delivered to the app (each once). */
  delivered: number;
  /** Messages dropped as duplicates (handover overlap, gap-fill overlap). */
  duplicates: number;
  /** Messages that came from a REST gap-fill. */
  gapFilled: number;
  /** The latest `date` delivered per topic (OpenF1's own string). */
  lastSeen: Partial<Record<LiveTopic, string>>;
  /** When each topic started streaming (ms since the epoch): the gap-fill floor for a topic with no lastSeen. */
  since: Partial<Record<LiveTopic, number>>;
  /** The last thing that went wrong (a refusal, a drop, a failed gap-fill). */
  lastError?: string;
  /** The next retry (reconnecting, connection-limit, waiting). */
  retryAt?: number;
};

/** This frame's place among the vault frames of one browser (every tab of the app). */
export type TabStatus = {
  role: "leader" | "follower";
  /** This frame's random id (not stable across loads). */
  id: string;
  /** The leader's id (this frame's, when it leads). */
  leader: string | null;
  /** Vault frames alive, as the leader counts them (the leader only). */
  frames?: number;
  /** Since this frame loaded: leaders it has seen take over (itself included), leads it stole, leads it lost. */
  changes?: number;
  steals?: number;
  lost?: number;
};

/**
 * Dev vault only (simulate mode): the simulated session. Sim time t (ms) is where the replayed session is at
 * wall time w: t = anchorWall + (w - anchorWall) * speed; message dates are on that clock.
 */
export type SimStatus = {
  sessionKey: number;
  label: string;
  speed: number;
  anchorWall: number;
  /** Sim times: the start, lights out, the end (after which nothing more is published). */
  start: number;
  lightsOut: number;
  end: number;
  /** Lifetime of the simulated /token's tokens (s). */
  tokenS: number;
  /** Configured faults: drop every N wall minutes (0 off), delivery jitter (ms). */
  dropEveryMin: number;
  jitterMs: number;
  /** Bumped when the dev server's simulation is reset. */
  version: number;
};

/** The REST budget (budget.ts), as the debug panel shows it: status.budget, from the leader. */
export type BudgetStatus = {
  /** The account's limits are in force (a token in hand), or the anonymous ones. */
  auth: boolean;
  /** The limits in force now (halved for a minute after a 429). */
  perSecond: number;
  perMinute: number;
  inFlight: number;
  queued: number;
  /** Requests started in the last 60 s (this leader's, plus the previous leader's after a takeover). */
  usedThisMinute: number;
  /** Callers with requests queued or in flight. */
  callers: number;
  /** Of perMinute, kept for live gap-fills (the stream is running). */
  reserve: number;
  /** Requests started by this leader, and how many OpenF1 answered 429. */
  started: number;
  rateLimited: number;
  /** Everything waits until then (after a 429). */
  pausedUntil?: number;
  /** The limits are halved until then (after a 429). */
  shrunkUntil?: number;
};

export type VaultStatus = RefreshStatus & {
  state: VaultState;
  /** How the login is stored (when one is). */
  mode?: StorageMode;
  /** The OpenF1 account, masked (`d***@example.com`). */
  account?: string;
  // tokenExpiresAt (RefreshStatus): when the current token expires (ms since the epoch). The token itself
  // never leaves the vault.
  /** In state "error": what went wrong. */
  error?: LoginError;
  live: "off" | "connecting" | "on";
  /** The vault build (vault/package version + build), for the debug panel and bug reports. */
  version: string;
  /** The live stream (whichever tab runs it). */
  stream?: StreamStatus;
  /** Leader or follower. */
  tab?: TabStatus;
  /** Dev vault in simulate mode only: the data is a replay, not OpenF1. The app must say "SIMULATED". */
  sim?: SimStatus;
  /** The REST budget (whichever tab leads). */
  budget?: BudgetStatus;
};

/** One OpenF1 record as it came (MQTT payload or REST row), parsed. MQTT ones carry `_id` and `_key`. */
export type LiveMessage = Record<string, unknown>;

/**
 * Pushed to the app. Live data comes in batches (every ~150 ms), one event per topic, each message once and
 * in `date` order within a batch; only topics this port subscribed to.
 */
export type VaultEvent =
  | { v: 1; type: "event"; event: "status"; status: VaultStatus }
  | { v: 1; type: "event"; event: "data"; topic: LiveTopic; messages: LiveMessage[] };

// ---------------------------------------------------------------- popup <-> frame (window.postMessage)
//
// Storage is partitioned: the popup (top level, vault origin) can't see the frame's IndexedDB (embedded
// under the app's site). So the popup stores nothing; it finds the vault frames via `opener.frames`, posts
// to each with targetOrigin = the vault origin, and the frame waiting for its ticket answers (event.source).
// Both sides accept only event.origin === the vault's own origin, and only these exact shapes.
//
//   popup -> frame   {type:"popup:hello", ticket}                               (retried until welcomed)
//   frame -> popup   {type:"popup:welcome", ticket, kind:"connect", prfSalt}
//                    {type:"popup:welcome", ticket, kind:"unlock", prfSalt, credentialId, account}
//   popup -> frame   {type:"popup:login", ticket, username, password, mode}     connect: check with OpenF1
//   frame -> popup   {type:"popup:result", ticket, ok:true, next:"done" | "passkey"} | {…, ok:false, error}
//   popup -> frame   {type:"popup:passkey", ticket, credentialId, prf}         after "passkey": seal with it
//                    {type:"popup:device", ticket}                            after "passkey": no PRF, stay connected instead
//                    {type:"popup:unlock", ticket, prf}                       unlock
//   frame -> popup   {type:"popup:result", …}

/** Bytes of a PRF output (WebAuthn prf `results.first`), and of the salt it's evaluated with. */
export const PRF_BYTES = 32;
/** WebAuthn credential ids are at most 1023 bytes. */
const CREDENTIAL_ID_MAX = 1023;
export const USERNAME_MAX = 254;
export const PASSWORD_MAX = 1024;

export type PopupHello = { v: 1; type: "popup:hello"; ticket: Ticket };
export type PopupLogin = { v: 1; type: "popup:login"; ticket: Ticket; username: string; password: string; mode: StorageMode };
export type PopupPasskey = { v: 1; type: "popup:passkey"; ticket: Ticket; credentialId: ArrayBuffer; prf: ArrayBuffer };
export type PopupDevice = { v: 1; type: "popup:device"; ticket: Ticket };
export type PopupUnlock = { v: 1; type: "popup:unlock"; ticket: Ticket; prf: ArrayBuffer };
export type PopupMessage = PopupHello | PopupLogin | PopupPasskey | PopupDevice | PopupUnlock;

export type PopupWelcome =
  | { v: 1; type: "popup:welcome"; ticket: Ticket; kind: "connect"; prfSalt: ArrayBuffer }
  | { v: 1; type: "popup:welcome"; ticket: Ticket; kind: "unlock"; prfSalt: ArrayBuffer; credentialId: ArrayBuffer; account: string };
export type PopupResult =
  | { v: 1; type: "popup:result"; ticket: Ticket; ok: true; next: "done" | "passkey" }
  | { v: 1; type: "popup:result"; ticket: Ticket; ok: false; error: LoginError };
export type FrameToPopup = PopupWelcome | PopupResult;

// ---------------------------------------------------------------- validation (runs in the vault)

export type Parsed =
  | { ok: true; request: Request }
  | { ok: false; /** The request's id if it had a usable one (then it gets an error response), else null (dropped). */ id: number | null; error: VaultError };

const isRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x) && [Object.prototype, null].includes(Object.getPrototypeOf(x));

/** Exactly these own keys: no extra, no missing. */
const hasKeys = (x: Record<string, unknown>, keys: readonly string[]) => {
  const own = Object.keys(x);
  return own.length === keys.length && keys.every((k) => Object.hasOwn(x, k));
};

const isId = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) >= 0 && (x as number) < LIMITS.id;

const oneOf = <T extends string>(list: readonly T[], x: unknown): x is T => typeof x === "string" && (list as readonly string[]).includes(x);

export function isReady(x: unknown): x is Ready {
  return isRecord(x) && hasKeys(x, ["v", "type"]) && x.v === PROTOCOL_VERSION && x.type === "ready";
}

/** A hello needs exactly one port with it. */
export function isHello(x: unknown, ports: number): x is Hello {
  return ports === 1 && isRecord(x) && hasKeys(x, ["v", "type"]) && x.v === PROTOCOL_VERSION && x.type === "hello";
}

function topics(x: unknown): x is LiveTopic[] {
  return Array.isArray(x) && x.length >= 1 && x.length <= LIMITS.topics && x.every((t) => oneOf(LIVE_TOPICS, t)) && new Set(x).size === x.length;
}

/** A known name plus one of the comparison suffixes: `date`, `date>`, `date>=`. */
const paramKey = (k: string) => PARAM_OPS.some((op) => k.endsWith(op) && oneOf(PARAM_KEYS, k.slice(0, k.length - op.length)));

function params(x: unknown): x is Params {
  if (!isRecord(x)) return false;
  const entries = Object.entries(x);
  return (
    entries.length <= LIMITS.params &&
    entries.every(
      ([k, v]) =>
        paramKey(k) &&
        ((typeof v === "number" && Number.isFinite(v)) || (typeof v === "string" && v.length <= LIMITS.paramValue && PARAM_VALUE.test(v))),
    )
  );
}

const bad = (id: number | null, message: string): Parsed => ({ ok: false, id, error: { code: "bad_request", message } });

/**
 * Validate one inbound port message. `ports` is how many MessagePorts came with it. `debug` (dev vault
 * only) also accepts DEBUG_METHODS.
 * Never throws: anything unexpected is an error result.
 */
export function parseRequest(x: unknown, ports: number, opts: { debug?: boolean } = {}): Parsed {
  if (!isRecord(x)) return bad(null, "not an object");
  const id = isId(x.id) ? x.id : null;
  if (id === null) return bad(null, "missing or invalid id");
  if (x.v !== PROTOCOL_VERSION) return bad(id, "unsupported protocol version");
  if (!oneOf(METHODS, x.type) && !(opts.debug === true && oneOf(DEBUG_METHODS, x.type))) return bad(id, "unknown type");
  const type = x.type as Method;
  const argKeys: Record<Method, readonly string[]> = {
    status: [],
    connect: ["ticket"],
    unlock: ["ticket"],
    cancel: ["ticket"],
    disconnect: [],
    openPort: [],
    close: [],
    subscribe: ["topics"],
    unsubscribe: ["topics"],
    get: ["endpoint", "params"],
    "debug:spoilToken": [],
    "debug:fakeExpiry": ["seconds"],
    "debug:refreshNow": [],
    "debug:failToken": ["status", "times"],
    "debug:freeze": ["ms"],
    "debug:sim": ["action"],
  };
  if (!hasKeys(x, ["v", "id", "type", ...argKeys[type]])) return bad(id, `wrong fields for ${type}`);
  if (ports !== (type === "openPort" ? 1 : 0)) return bad(id, `${type} takes ${type === "openPort" ? "exactly one port" : "no ports"}`);
  if ((type === "connect" || type === "unlock" || type === "cancel") && !isTicket(x.ticket)) return bad(id, "ticket: 22 to 64 base64url characters");
  if ((type === "subscribe" || type === "unsubscribe") && !topics(x.topics)) return bad(id, "topics: 1 to 32 distinct known topics");
  if (type === "get") {
    if (!oneOf(REST_ENDPOINTS, x.endpoint)) return bad(id, "endpoint not allowed");
    if (!params(x.params)) return bad(id, "params not allowed");
  }
  if (type === "debug:failToken" && (![401, 429, 503].includes(x.status as number) || !Number.isInteger(x.times) || (x.times as number) < 0 || (x.times as number) > 10))
    return bad(id, "status: 401, 429 or 503; times: 0 to 10");
  if (type === "debug:freeze" && (!Number.isInteger(x.ms) || (x.ms as number) < FREEZE_MS.min || (x.ms as number) > FREEZE_MS.max)) return bad(id, `ms: ${FREEZE_MS.min} to ${FREEZE_MS.max}`);
  if (type === "debug:sim" && !oneOf(SIM_ACTIONS, x.action)) return bad(id, `action: ${SIM_ACTIONS.join(" or ")}`);
  if (type === "debug:fakeExpiry") {
    const n = x.seconds;
    if (!Number.isInteger(n) || (n !== 0 && ((n as number) < FAKE_EXPIRY.min || (n as number) > FAKE_EXPIRY.max))) return bad(id, `seconds: 0 or ${FAKE_EXPIRY.min} to ${FAKE_EXPIRY.max}`);
  }
  return { ok: true, request: x as Request };
}

// ---------------------------------------------------------------- popup messages (validated on both sides)

const bytes = (x: unknown, min: number, max: number): x is ArrayBuffer => x instanceof ArrayBuffer && x.byteLength >= min && x.byteLength <= max;
/** An email-shaped username: OpenF1 logins are email addresses. */
const USERNAME = /^[^\s@]+@[^\s@]+$/;
const isUsername = (x: unknown): x is string => typeof x === "string" && x.length <= USERNAME_MAX && USERNAME.test(x);
const isPassword = (x: unknown): x is string => typeof x === "string" && x.length >= 1 && x.length <= PASSWORD_MAX;
const popupBase = (x: unknown, type: string, keys: readonly string[]): x is Record<string, unknown> =>
  isRecord(x) && hasKeys(x, ["v", "type", "ticket", ...keys]) && x.v === PROTOCOL_VERSION && x.type === type && isTicket(x.ticket);

/** A message the frame accepts from the popup (it also checks event.origin and its pending ticket). Never throws. */
export function parsePopupMessage(x: unknown): PopupMessage | null {
  if (!isRecord(x)) return null;
  switch (x.type) {
    case "popup:hello":
      return popupBase(x, "popup:hello", []) ? (x as PopupHello) : null;
    case "popup:login":
      return popupBase(x, "popup:login", ["username", "password", "mode"]) && isUsername(x.username) && isPassword(x.password) && oneOf(["device", "passkey"], x.mode)
        ? (x as PopupLogin)
        : null;
    case "popup:passkey":
      return popupBase(x, "popup:passkey", ["credentialId", "prf"]) && bytes(x.credentialId, 1, CREDENTIAL_ID_MAX) && bytes(x.prf, PRF_BYTES, PRF_BYTES)
        ? (x as PopupPasskey)
        : null;
    case "popup:device":
      return popupBase(x, "popup:device", []) ? (x as PopupDevice) : null;
    case "popup:unlock":
      return popupBase(x, "popup:unlock", ["prf"]) && bytes(x.prf, PRF_BYTES, PRF_BYTES) ? (x as PopupUnlock) : null;
    default:
      return null;
  }
}

const LOGIN_ERRORS = ["wrong_credentials", "rate_limited", "network", "server", "storage", "passkey", "expired"] as const satisfies readonly LoginErrorCode[];
const isLoginError = (x: unknown): x is LoginError =>
  isRecord(x) && hasKeys(x, ["code", "message"]) && oneOf(LOGIN_ERRORS, x.code) && typeof x.message === "string" && x.message.length <= 500;

/** A message the popup accepts from the frame. Never throws. */
export function parseFrameMessage(x: unknown): FrameToPopup | null {
  if (!isRecord(x) || x.v !== PROTOCOL_VERSION || !isTicket(x.ticket)) return null;
  if (x.type === "popup:welcome") {
    if (x.kind === "connect" && hasKeys(x, ["v", "type", "ticket", "kind", "prfSalt"]) && bytes(x.prfSalt, PRF_BYTES, PRF_BYTES)) return x as PopupWelcome;
    if (
      x.kind === "unlock" &&
      hasKeys(x, ["v", "type", "ticket", "kind", "prfSalt", "credentialId", "account"]) &&
      bytes(x.prfSalt, PRF_BYTES, PRF_BYTES) &&
      bytes(x.credentialId, 1, CREDENTIAL_ID_MAX) &&
      typeof x.account === "string" &&
      x.account.length <= USERNAME_MAX
    )
      return x as PopupWelcome;
    return null;
  }
  if (x.type === "popup:result") {
    if (x.ok === true && hasKeys(x, ["v", "type", "ticket", "ok", "next"]) && oneOf(["done", "passkey"], x.next)) return x as PopupResult;
    if (x.ok === false && hasKeys(x, ["v", "type", "ticket", "ok", "error"]) && isLoginError(x.error)) return x as PopupResult;
  }
  return null;
}

/** `driver@example.com` -> `d***@example.com`. Only this masked form is stored in the clear or shown. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 1) return "***";
  return `${email[0]}***${email.slice(at)}`;
}
