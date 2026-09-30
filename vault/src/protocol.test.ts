import { describe, expect, test } from "bun:test";
import { isHello, isReady, LIMITS, LIVE_TOPICS, maskEmail, parseFrameMessage, parsePopupMessage, parseRequest } from "./protocol";

const T = "abcdefghijklmnopqrstuv_-";

const ok = (x: unknown, ports = 0) => parseRequest(x, ports).ok;
const err = (x: unknown, ports = 0) => {
  const p = parseRequest(x, ports);
  if (p.ok) throw new Error("expected invalid");
  return p;
};

describe("handshake messages", () => {
  test("ready and hello", () => {
    expect(isReady({ v: 1, type: "ready" })).toBe(true);
    expect(isReady({ v: 2, type: "ready" })).toBe(false);
    expect(isReady({ v: 1, type: "ready", x: 1 })).toBe(false);
    expect(isHello({ v: 1, type: "hello" }, 1)).toBe(true);
    expect(isHello({ v: 1, type: "hello" }, 0)).toBe(false);
    expect(isHello({ v: 1, type: "hello" }, 2)).toBe(false);
    expect(isHello({ v: 1, type: "hello", token: "x" }, 1)).toBe(false);
    expect(isHello("hello", 1)).toBe(false);
    expect(isHello(null, 1)).toBe(false);
  });
});

describe("parseRequest", () => {
  test("valid requests", () => {
    expect(ok({ v: 1, id: 0, type: "status" })).toBe(true);
    expect(ok({ v: 1, id: 7, type: "connect", ticket: T })).toBe(true);
    expect(ok({ v: 1, id: 7, type: "unlock", ticket: T })).toBe(true);
    expect(ok({ v: 1, id: 7, type: "cancel", ticket: T })).toBe(true);
    expect(ok({ v: 1, id: 7, type: "disconnect" })).toBe(true);
    expect(ok({ v: 1, id: 1, type: "subscribe", topics: ["laps", "car_data"] })).toBe(true);
    expect(ok({ v: 1, id: 1, type: "unsubscribe", topics: [...LIVE_TOPICS] })).toBe(true);
    expect(ok({ v: 1, id: 2, type: "get", endpoint: "laps", params: { session_key: 11377, driver_number: 1 } })).toBe(true);
    expect(ok({ v: 1, id: 2, type: "get", endpoint: "sessions", params: {} })).toBe(true);
    expect(ok({ v: 1, id: 2, type: "get", endpoint: "sessions", params: { year: 2026, session_type: "Race" } })).toBe(true);
    expect(ok({ v: 1, id: 2, type: "get", endpoint: "location", params: { "date>": "2024-03-02T15:00:00+00:00", "date<=": "2024-03-02T15:10:00.5" } })).toBe(true);
    expect(ok({ v: 1, id: 3, type: "openPort" }, 1)).toBe(true);
    expect(ok({ v: 1, id: 4, type: "close" }, 0)).toBe(true);
    expect(ok({ v: 1, id: 4, type: "close", now: true }, 0)).toBe(false);
    expect(ok({ v: 1, id: 4, type: "close" }, 1)).toBe(false);
    expect(ok(Object.assign(Object.create(null), { v: 1, id: 0, type: "status" }))).toBe(true);
  });

  test("no id: dropped", () => {
    for (const x of [null, undefined, 1, "status", [], { v: 1, type: "status" }, { v: 1, id: -1, type: "status" }, { v: 1, id: 1.5, type: "status" }, { v: 1, id: "1", type: "status" }, { v: 1, id: LIMITS.id, type: "status" }]) {
      expect(err(x).id).toBe(null);
    }
  });

  test("usable id: an error to answer", () => {
    const e = err({ v: 1, id: 5, type: "token" });
    expect(e.id).toBe(5);
    expect(e.error.code).toBe("bad_request");
    expect(err({ v: 2, id: 5, type: "status" }).id).toBe(5);
    expect(err({ v: 1, id: 5, type: "__proto__" }).id).toBe(5);
    expect(err({ v: 1, id: 5, type: "toString" }).id).toBe(5);
  });

  test("unknown types, including anything asking for secrets", () => {
    for (const type of ["token", "getToken", "password", "credentials", "hello", "ready", "event", ""]) expect(ok({ v: 1, id: 1, type })).toBe(false);
  });

  test("debug methods: unknown unless the (dev) vault opts in, and validated when it does", () => {
    const dev = (x: unknown) => parseRequest(x, 0, { debug: true }).ok;
    for (const req of [{ type: "debug:spoilToken" }, { type: "debug:refreshNow" }, { type: "debug:fakeExpiry", seconds: 120 }]) {
      expect(ok({ v: 1, id: 1, ...req })).toBe(false);
      expect(parseRequest({ v: 1, id: 1, ...req }, 0, { debug: false }).ok).toBe(false);
      expect(dev({ v: 1, id: 1, ...req })).toBe(true);
    }
    expect(dev({ v: 1, id: 1, type: "debug:fakeExpiry", seconds: 0 })).toBe(true);
    for (const seconds of [5, 19, 3601, 1.5, "120", -1, null]) expect(dev({ v: 1, id: 1, type: "debug:fakeExpiry", seconds })).toBe(false);
    expect(dev({ v: 1, id: 1, type: "debug:spoilToken", extra: 1 })).toBe(false);
    expect(dev({ v: 1, id: 1, type: "debug:other" })).toBe(false);
    expect(dev({ v: 1, id: 1, type: "debug:failToken", status: 503, times: 2 })).toBe(true);
    expect(ok({ v: 1, id: 1, type: "debug:failToken", status: 503, times: 2 })).toBe(false);
    for (const [status, times] of [[500, 1], [401, 11], [429, -1], [503, 1.5], ["401", 1]]) expect(dev({ v: 1, id: 1, type: "debug:failToken", status, times })).toBe(false);
  });

  test("extra or missing fields", () => {
    expect(ok({ v: 1, id: 1, type: "status", extra: true })).toBe(false);
    expect(ok({ v: 1, id: 1, type: "status", topics: ["laps"] })).toBe(false);
    expect(ok({ v: 1, id: 1, type: "subscribe" })).toBe(false);
    expect(ok({ v: 1, id: 1, type: "get", endpoint: "laps" })).toBe(false);
    expect(ok({ v: 1, id: 1, type: "get", endpoint: "laps", params: {}, url: "https://evil" })).toBe(false);
  });

  test("wrong types", () => {
    expect(ok({ v: 1, id: 1, type: "subscribe", topics: "laps" })).toBe(false);
    expect(ok({ v: 1, id: 1, type: "subscribe", topics: [1] })).toBe(false);
    expect(ok({ v: 1, id: 1, type: "subscribe", topics: [] })).toBe(false);
    expect(ok({ v: 1, id: 1, type: "subscribe", topics: ["laps", "laps"] })).toBe(false);
    expect(ok({ v: 1, id: 1, type: "subscribe", topics: ["v1/laps"] })).toBe(false);
    expect(ok({ v: 1, id: 1, type: "subscribe", topics: ["#"] })).toBe(false);
    expect(ok({ v: 1, id: 1, type: "get", endpoint: "laps", params: [] })).toBe(false);
    expect(ok({ v: 1, id: 1, type: "get", endpoint: "laps", params: null })).toBe(false);
    expect(ok({ v: 1, id: 1, type: "get", endpoint: "laps", params: new Date() })).toBe(false);
    expect(ok({ v: 1, id: 1, type: "get", endpoint: "laps", params: { session_key: true } })).toBe(false);
    expect(ok({ v: 1, id: 1, type: "get", endpoint: "laps", params: { session_key: NaN } })).toBe(false);
    expect(ok({ v: 1, id: 1, type: "get", endpoint: "laps", params: { session_key: { a: 1 } } })).toBe(false);
  });

  test("endpoints and params outside the allowlist", () => {
    for (const endpoint of ["token", "../token", "laps?x=1", "LAPS", "championship_drivers", ""]) {
      expect(ok({ v: 1, id: 1, type: "get", endpoint, params: {} })).toBe(false);
    }
    for (const params of [{ foo: 1 }, { "session_key&x": 1 }, { "date>>": "x" }, { "date=": "x" }, { session_key: "1&x=2" }, { session_key: "a/b" }, { session_key: "a\nb" }, { "": 1 }]) {
      expect(ok({ v: 1, id: 1, type: "get", endpoint: "laps", params })).toBe(false);
    }
  });

  test("oversize", () => {
    const nine = { session_key: 1, meeting_key: 1, driver_number: 1, year: 1, session_type: "a", session_name: "a", date: "a", date_start: "a", lap_number: 1 };
    expect(ok({ v: 1, id: 1, type: "get", endpoint: "laps", params: nine })).toBe(false);
    expect(ok({ v: 1, id: 1, type: "get", endpoint: "laps", params: { session_name: "a".repeat(LIMITS.paramValue) } })).toBe(true);
    expect(ok({ v: 1, id: 1, type: "get", endpoint: "laps", params: { session_name: "a".repeat(LIMITS.paramValue + 1) } })).toBe(false);
    expect(ok({ v: 1, id: 1, type: "subscribe", topics: Array(LIMITS.topics + 1).fill("laps") })).toBe(false);
    expect(ok({ v: 1, id: 1, type: "subscribe", topics: ["x".repeat(1e6)] })).toBe(false);
  });

  test("tickets", () => {
    for (const ticket of [undefined, 1, "", "a".repeat(21), "a".repeat(65), "a".repeat(21) + "=", "a".repeat(21) + "/", "a".repeat(21) + " "]) {
      expect(ok({ v: 1, id: 1, type: "connect", ticket })).toBe(false);
    }
    expect(ok({ v: 1, id: 1, type: "connect" })).toBe(false);
    expect(ok({ v: 1, id: 1, type: "connect", ticket: T, username: "a@b.c" })).toBe(false);
    expect(ok({ v: 1, id: 1, type: "disconnect", ticket: T })).toBe(false);
  });

  test("ports: only openPort takes one", () => {
    expect(ok({ v: 1, id: 1, type: "status" }, 1)).toBe(false);
    expect(ok({ v: 1, id: 1, type: "openPort" }, 0)).toBe(false);
    expect(ok({ v: 1, id: 1, type: "openPort" }, 2)).toBe(false);
  });
});

const buf = (n: number) => new ArrayBuffer(n);

describe("popup messages (frame side)", () => {
  test("valid", () => {
    expect(parsePopupMessage({ v: 1, type: "popup:hello", ticket: T })).not.toBeNull();
    expect(parsePopupMessage({ v: 1, type: "popup:login", ticket: T, username: "a@b.co", password: "pw", mode: "device" })).not.toBeNull();
    expect(parsePopupMessage({ v: 1, type: "popup:login", ticket: T, username: "a@b.co", password: "pw", mode: "passkey" })).not.toBeNull();
    expect(parsePopupMessage({ v: 1, type: "popup:passkey", ticket: T, credentialId: buf(16), prf: buf(32) })).not.toBeNull();
    expect(parsePopupMessage({ v: 1, type: "popup:device", ticket: T })).not.toBeNull();
    expect(parsePopupMessage({ v: 1, type: "popup:unlock", ticket: T, prf: buf(32) })).not.toBeNull();
  });

  test("invalid", () => {
    const bad = [
      null,
      "popup:hello",
      { v: 1, type: "popup:hello" },
      { v: 2, type: "popup:hello", ticket: T },
      { v: 1, type: "popup:hello", ticket: "x" },
      { v: 1, type: "popup:hello", ticket: T, extra: 1 },
      { v: 1, type: "popup:token", ticket: T },
      { v: 1, type: "popup:login", ticket: T, username: "not-an-email", password: "pw", mode: "device" },
      { v: 1, type: "popup:login", ticket: T, username: "a@b.co", password: "", mode: "device" },
      { v: 1, type: "popup:login", ticket: T, username: "a@b.co", password: "x".repeat(1025), mode: "device" },
      { v: 1, type: "popup:login", ticket: T, username: "a@b.co", password: "pw", mode: "cloud" },
      { v: 1, type: "popup:login", ticket: T, username: "a@b.co", password: "pw" },
      { v: 1, type: "popup:login", ticket: T, username: `${"a".repeat(250)}@b.co`, password: "pw", mode: "device" },
      { v: 1, type: "popup:passkey", ticket: T, credentialId: buf(16), prf: buf(31) },
      { v: 1, type: "popup:passkey", ticket: T, credentialId: buf(0), prf: buf(32) },
      { v: 1, type: "popup:passkey", ticket: T, credentialId: buf(1024), prf: buf(32) },
      { v: 1, type: "popup:passkey", ticket: T, credentialId: new Uint8Array(16), prf: buf(32) },
      { v: 1, type: "popup:unlock", ticket: T, prf: new Uint8Array(32) },
      { v: 1, type: "popup:unlock", ticket: T, prf: "x".repeat(32) },
    ];
    for (const x of bad) expect(parsePopupMessage(x)).toBeNull();
  });
});

describe("frame messages (popup side)", () => {
  test("welcome and results", () => {
    expect(parseFrameMessage({ v: 1, type: "popup:welcome", ticket: T, kind: "connect", prfSalt: buf(32) })).not.toBeNull();
    expect(parseFrameMessage({ v: 1, type: "popup:welcome", ticket: T, kind: "unlock", prfSalt: buf(32), credentialId: buf(20), account: "g***@x.io" })).not.toBeNull();
    expect(parseFrameMessage({ v: 1, type: "popup:result", ticket: T, ok: true, next: "done" })).not.toBeNull();
    expect(parseFrameMessage({ v: 1, type: "popup:result", ticket: T, ok: true, next: "passkey" })).not.toBeNull();
    expect(parseFrameMessage({ v: 1, type: "popup:result", ticket: T, ok: false, error: { code: "wrong_credentials", message: "no" } })).not.toBeNull();
    for (const x of [
      { v: 1, type: "popup:welcome", ticket: T, kind: "connect" },
      { v: 1, type: "popup:welcome", ticket: T, kind: "unlock", prfSalt: buf(32), account: "x" },
      { v: 1, type: "popup:result", ticket: T, ok: true },
      { v: 1, type: "popup:result", ticket: T, ok: true, next: "done", token: "eyJ" },
      { v: 1, type: "popup:result", ticket: T, ok: false, error: { code: "other", message: "no" } },
      { v: 1, type: "popup:result", ticket: "short", ok: true, next: "done" },
    ])
      expect(parseFrameMessage(x)).toBeNull();
  });
});

describe("maskEmail", () => {
  test("keeps the first letter and the domain", () => {
    expect(maskEmail("driver@example.com")).toBe("d***@example.com");
    expect(maskEmail("a@b.co")).toBe("a***@b.co");
    expect(maskEmail("weird@name@x.io")).toBe("w***@x.io");
    expect(maskEmail("nodomain")).toBe("***");
    expect(maskEmail("@x.io")).toBe("***");
  });
});
