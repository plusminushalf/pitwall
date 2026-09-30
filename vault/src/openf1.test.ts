import { describe, expect, test } from "bun:test";
import { jwtLifetime, parseTokenResponse, requestToken, TOKEN_URL, type Fetch } from "./openf1";

const JWT = "eyJhbGciOiJSUzI1NiJ9.fake.fake-signature";

describe("parseTokenResponse", () => {
  test("expires_in as a string (what OpenF1 sends)", () => {
    const r = parseTokenResponse(200, JSON.stringify({ access_token: JWT, token_type: "bearer", expires_in: "3600" }), 1000);
    expect(r).toEqual({ ok: true, token: { accessToken: JWT, issuedAt: 1000, expiresAt: 1000 + 3_600_000 } });
  });
  test("expires_in as a number too", () => {
    const r = parseTokenResponse(200, JSON.stringify({ access_token: JWT, expires_in: 120 }), 0);
    expect(r.ok && r.token.expiresAt).toBe(120_000);
  });
  test("the JWT's own exp - iat caps the lifetime (never lengthens it)", () => {
    const b64 = (o: object) => btoa(JSON.stringify(o)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
    const jwt = (claims: object) => `${b64({ alg: "RS256" })}.${b64(claims)}.c2lnbmF0dXJlLXNpZ25hdHVyZQ`;
    const life = (token: string, expiresIn = "3600") => {
      const r = parseTokenResponse(200, JSON.stringify({ access_token: token, expires_in: expiresIn }), 0);
      return r.ok ? r.token.expiresAt / 1000 : null;
    };
    expect(life(jwt({ iat: 1_700_000_000, exp: 1_700_003_600, email: "x@y.z" }))).toBe(3600);
    expect(life(jwt({ iat: 1_700_000_000, exp: 1_700_001_800 }))).toBe(1800);
    expect(life(jwt({ iat: 1_700_000_000, exp: 1_700_007_200 }))).toBe(3600);
    // Unreadable claims: expires_in alone.
    for (const t of [jwt({ iat: "x", exp: 5 }), jwt({ exp: 5 }), jwt({ iat: 10, exp: 5 }), "eyJhbGciOiJSUzI1NiJ9.!!!.sig-sig-sig", JWT]) expect(life(t)).toBe(3600);
    expect(jwtLifetime(jwt({ iat: 0, exp: 60 }))).toBe(60);
  });
  test("unreadable 200s are server errors", () => {
    for (const body of ["", "not json", "null", "[]", JSON.stringify({ access_token: JWT }), JSON.stringify({ access_token: JWT, expires_in: "1h" }), JSON.stringify({ access_token: JWT, expires_in: "-5" }), JSON.stringify({ access_token: JWT, expires_in: "0" }), JSON.stringify({ access_token: JWT, expires_in: "99999999" }), JSON.stringify({ access_token: JWT, expires_in: 1.5 }), JSON.stringify({ access_token: 5, expires_in: "3600" }), JSON.stringify({ access_token: "short", expires_in: "3600" })]) {
      const r = parseTokenResponse(200, body, 0);
      expect(r.ok ? "ok" : r.error.code).toBe("server");
    }
  });
  test("status codes", () => {
    const code = (status: number, body = "") => {
      const r = parseTokenResponse(status, body, 0);
      return r.ok ? "ok" : r.error.code;
    };
    expect(code(401, '{"detail":"Incorrect username or password"}')).toBe("wrong_credentials");
    expect(code(403)).toBe("wrong_credentials");
    expect(code(429, "<html><head><title>429 Too Many Requests</title></head><body><center><h1>429 Too Many Requests</h1></center><hr><center>nginx</center></body></html>")).toBe("rate_limited");
    expect(code(422, "{}")).toBe("server");
    expect(code(500)).toBe("server");
    expect(code(502, "<html>bad gateway</html>")).toBe("server");
  });
});

describe("requestToken", () => {
  test("posts a form body, no cookies, no referrer", async () => {
    let seen: { url: string; init: Parameters<Fetch>[1] } | null = null;
    const fetch: Fetch = async (url, init) => {
      seen = { url, init };
      return { status: 200, text: async () => JSON.stringify({ access_token: JWT, token_type: "bearer", expires_in: "3600" }) };
    };
    const r = await requestToken(fetch, "a@b.co", "p&ss=w rd", () => 5);
    expect(r.ok).toBe(true);
    expect(seen!.url).toBe(TOKEN_URL);
    expect(seen!.init.method).toBe("POST");
    expect(seen!.init.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(Object.fromEntries(new URLSearchParams(seen!.init.body))).toEqual({ username: "a@b.co", password: "p&ss=w rd" });
    expect(seen!.init.credentials).toBe("omit");
  });
  test("a failed fetch is a network error, without the password in it", async () => {
    const r = await requestToken(async () => {
      throw new TypeError("Failed to fetch secret-pw");
    }, "a@b.co", "secret-pw", Date.now);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("network");
      expect(JSON.stringify(r)).not.toContain("secret-pw");
    }
  });
  test("expiry counts from when the request was sent", async () => {
    let t = 1000;
    const r = await requestToken(async () => ((t = 9000), { status: 200, text: async () => JSON.stringify({ access_token: JWT, expires_in: "60" }) }), "a@b.co", "x", () => t);
    expect(r.ok && r.token.expiresAt).toBe(1000 + 60_000);
  });
});
