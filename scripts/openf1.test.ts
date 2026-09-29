// OpenF1 client auth without the network: fetch is mocked, credentials are fake.

import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { AuthError, LiveWindowError, TOKEN_URL, accessToken, credentials, fetchEndpoint, invalidateToken, setRequestInterval } from "./openf1";

const saved = { user: process.env.OPENF1_USERNAME, pass: process.env.OPENF1_PASSWORD };
const realFetch = globalThis.fetch;

interface Call {
  url: string;
  method: string;
  auth: string | null;
  body: string | null;
}
let calls: Call[] = [];
let respond: (call: Call) => Response;

function mockFetch() {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      auth: headers.get("authorization"),
      body: init?.body != null ? String(init.body) : null,
    };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
}

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
let issued = 0;
const tokenOk = () => json({ access_token: `tok-${++issued}`, expires_in: "3600", token_type: "bearer" });

function setCreds(user?: string, pass?: string) {
  if (user == null) delete process.env.OPENF1_USERNAME;
  else process.env.OPENF1_USERNAME = user;
  if (pass == null) delete process.env.OPENF1_PASSWORD;
  else process.env.OPENF1_PASSWORD = pass;
}

beforeEach(() => {
  calls = [];
  issued = 0;
  invalidateToken();
  setRequestInterval(0);
  mockFetch();
});
afterEach(() => {
  globalThis.fetch = realFetch;
});
afterAll(() => {
  setCreds(saved.user, saved.pass);
  setRequestInterval(null);
  invalidateToken();
});

describe("without credentials (free tier)", () => {
  test("no token request, no Authorization header", async () => {
    setCreds();
    respond = () => json([{ session_key: 1 }]);
    expect(credentials()).toBeNull();
    expect(await accessToken()).toBeNull();
    expect(await fetchEndpoint("sessions", { session_key: 1 })).toEqual([{ session_key: 1 }]);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.openf1.org/v1/sessions?session_key=1");
    expect(calls[0].auth).toBeNull();
  });

  test("a 401 during a live session is a LiveWindowError, not retried", async () => {
    setCreds();
    respond = () => json({ detail: "Live F1 session in progress: historical data is available again 30 minutes after it ends" }, 401);
    const err = await fetchEndpoint("laps", { session_key: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(LiveWindowError);
    expect(err.status).toBe(401);
    expect(err.detail).toStartWith("Live F1 session in progress");
    expect(calls).toHaveLength(1);
  });

  test("a blank username counts as missing", () => {
    setCreds("  ", "secret");
    expect(credentials()).toBeNull();
  });
});

describe("with credentials (sponsor tier)", () => {
  test("fetches a token once (form-encoded) and sends it as a bearer", async () => {
    setCreds("fan@example.com", "s3cret&pass");
    respond = (c) => (c.url === TOKEN_URL ? tokenOk() : json([]));
    await fetchEndpoint("laps", { session_key: 1 });
    await fetchEndpoint("stints", { session_key: 1 });
    expect(calls.map((c) => c.method)).toEqual(["POST", "GET", "GET"]);
    const form = new URLSearchParams(calls[0].body!);
    expect(form.get("username")).toBe("fan@example.com");
    expect(form.get("password")).toBe("s3cret&pass");
    expect(calls[1].auth).toBe("Bearer tok-1");
    expect(calls[2].auth).toBe("Bearer tok-1");
  });

  test("concurrent callers share one token request", async () => {
    setCreds("u", "p");
    respond = (c) => (c.url === TOKEN_URL ? tokenOk() : json([]));
    const tokens = await Promise.all([accessToken(), accessToken(), accessToken()]);
    expect(tokens).toEqual(["tok-1", "tok-1", "tok-1"]);
    expect(calls).toHaveLength(1);
  });

  test("refreshes a few minutes before the hour is up", async () => {
    setCreds("u", "p");
    respond = (c) => (c.url === TOKEN_URL ? tokenOk() : json([]));
    const start = Date.now();
    const clock = spyOn(Date, "now");
    try {
      clock.mockReturnValue(start);
      expect(await accessToken()).toBe("tok-1");
      clock.mockReturnValue(start + 50 * 60_000);
      expect(await accessToken()).toBe("tok-1");
      clock.mockReturnValue(start + 56 * 60_000);
      expect(await accessToken()).toBe("tok-2");
    } finally {
      clock.mockRestore();
    }
  });

  test("a 401 on data gets a fresh token and retries once", async () => {
    setCreds("u", "p");
    let dataCalls = 0;
    respond = (c) => {
      if (c.url === TOKEN_URL) return tokenOk();
      return ++dataCalls === 1 ? json({ detail: "expired" }, 401) : json([{ ok: true }]);
    };
    expect(await fetchEndpoint("laps", { session_key: 1 })).toEqual([{ ok: true }]);
    expect(calls.map((c) => c.auth ?? c.method)).toEqual(["POST", "Bearer tok-1", "POST", "Bearer tok-2"]);
  });

  test("a persistent 401 fails instead of looping", async () => {
    setCreds("u", "p");
    respond = (c) => (c.url === TOKEN_URL ? tokenOk() : json({ detail: "no" }, 401));
    await expect(fetchEndpoint("laps", { session_key: 1 })).rejects.toThrow("OpenF1 401");
    expect(calls.filter((c) => c.url === TOKEN_URL)).toHaveLength(2);
  });

  test("rejected credentials: AuthError that doesn't leak the password", async () => {
    setCreds("u", "hunter2");
    respond = () => json({ detail: "Invalid username or password hunter2" }, 401);
    const err = await accessToken().catch((e) => e);
    expect(err).toBeInstanceOf(AuthError);
    expect(String(err.message)).not.toContain("hunter2");
    await expect(fetchEndpoint("laps", { session_key: 1 })).rejects.toBeInstanceOf(AuthError);
  });

  test("a new username gets its own token", async () => {
    respond = (c) => (c.url === TOKEN_URL ? tokenOk() : json([]));
    setCreds("a", "p");
    expect(await accessToken()).toBe("tok-1");
    setCreds("b", "p");
    expect(await accessToken()).toBe("tok-2");
  });
});
