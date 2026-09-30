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

/** OpenF1 MQTT topics (`v1/<topic>`) `subscribe` accepts: the live relay's set (server/store.ts). */
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

/** Each method: its arguments (besides v, id, type), its result, and how many ports come with the request. */
export type Methods = {
  status: { args: {}; result: VaultStatus };
  /** Start setting up an OpenF1 login (the setup popup; step 2). */
  connect: { args: {}; result: VaultStatus };
  /** Forget the stored login and close the live connection. */
  disconnect: { args: {}; result: VaultStatus };
  subscribe: { args: { topics: LiveTopic[] }; result: { topics: LiveTopic[] } };
  unsubscribe: { args: { topics: LiveTopic[] }; result: { topics: LiveTopic[] } };
  /** An authenticated OpenF1 read. The body is the raw response, transferred. */
  get: { args: { endpoint: RestEndpoint; params: Params }; result: { status: number; body: ArrayBuffer } };
  /** A second port (transferred with the request) that speaks this same protocol, e.g. for the download worker. */
  openPort: { args: {}; result: {} };
};
export type Method = keyof Methods;
export const METHODS = ["status", "connect", "disconnect", "subscribe", "unsubscribe", "get", "openPort"] as const satisfies readonly Method[];

export type Request<M extends Method = Method> = M extends Method ? { v: 1; id: number; type: M } & Methods[M]["args"] : never;

export type ErrorCode = "bad_request" | "not_implemented" | "not_connected" | "rate_limited" | "internal";
export type VaultError = { code: ErrorCode; message: string };

export type Response<M extends Method = Method> =
  | { v: 1; id: number; ok: true; result: Methods[M]["result"] }
  | { v: 1; id: number; ok: false; error: VaultError };

export type VaultStatus = {
  /** "none": no login stored. "locked": stored behind a passkey, not unlocked yet. */
  account: "none" | "locked" | "connected";
  storage: "device" | "passkey" | null;
  live: "off" | "connecting" | "on";
  /** The vault build (vault/package version + build), for the debug panel and bug reports. */
  version: string;
};

export type VaultEvent =
  | { v: 1; type: "event"; event: "status"; status: VaultStatus }
  | { v: 1; type: "event"; event: "message"; topic: LiveTopic; data: unknown };

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
 * Validate one inbound port message. `ports` is how many MessagePorts came with it.
 * Never throws: anything unexpected is an error result.
 */
export function parseRequest(x: unknown, ports: number): Parsed {
  if (!isRecord(x)) return bad(null, "not an object");
  const id = isId(x.id) ? x.id : null;
  if (id === null) return bad(null, "missing or invalid id");
  if (x.v !== PROTOCOL_VERSION) return bad(id, "unsupported protocol version");
  if (!oneOf(METHODS, x.type)) return bad(id, "unknown type");
  const type = x.type;
  const argKeys: Record<Method, readonly string[]> = {
    status: [],
    connect: [],
    disconnect: [],
    openPort: [],
    subscribe: ["topics"],
    unsubscribe: ["topics"],
    get: ["endpoint", "params"],
  };
  if (!hasKeys(x, ["v", "id", "type", ...argKeys[type]])) return bad(id, `wrong fields for ${type}`);
  if (ports !== (type === "openPort" ? 1 : 0)) return bad(id, `${type} takes ${type === "openPort" ? "exactly one port" : "no ports"}`);
  if ((type === "subscribe" || type === "unsubscribe") && !topics(x.topics)) return bad(id, "topics: 1 to 32 distinct known topics");
  if (type === "get") {
    if (!oneOf(REST_ENDPOINTS, x.endpoint)) return bad(id, "endpoint not allowed");
    if (!params(x.params)) return bad(id, "params not allowed");
  }
  return { ok: true, request: x as Request };
}
