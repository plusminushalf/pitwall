// The REST pass-through (proxy.ts) and the Worker in front of the vault (worker.ts): what it forwards, what it refuses,
// and that only the token and Accept go on.

import { describe, expect, test } from "bun:test";
import { handleProxy, parseQuery, UPSTREAM } from "./proxy";
import worker from "./worker";

const ORIGIN = "https://pitwall-auth.garvit.in";
const TOKEN = "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln";

type Sent = { url: string; init: RequestInit };
function upstream(status = 200, body = '[{"lap_number":1}]', headers: Record<string, string> = { "Content-Type": "application/json" }) {
  const sent: Sent[] = [];
  const f = (async (url: string, init: RequestInit) => {
    sent.push({ url, init });
    return new Response(body, { status, headers });
  }) as unknown as typeof fetch;
  return { sent, f };
}

const req = (path: string, headers: Record<string, string> = {}, method = "GET") =>
  new Request(`${ORIGIN}${path}`, { method, headers: { "Sec-Fetch-Site": "same-origin", Authorization: TOKEN, Accept: "application/json", ...headers } });

describe("REST pass-through", () => {
  test("forwards a get the vault allows, with only the token and Accept, and passes the answer back uncached", async () => {
    const { sent, f } = upstream(200, '[{"lap_number":1}]');
    const res = await handleProxy(req("/openf1/v1/laps?session_key=11731&date%3E=2026-10-04T07:00:00.000Z", { Cookie: "a=b", "X-Forwarded-For": "1.2.3.4", Origin: ORIGIN }), { fetch: f });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('[{"lap_number":1}]');
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe(`${UPSTREAM}laps?session_key=11731&date>=2026-10-04T07%3A00%3A00.000Z`);
    expect(sent[0]!.init.headers).toEqual({ Authorization: TOKEN, Accept: "application/json" });
    expect(sent[0]!.init.method).toBe("GET");
  });

  test("OpenF1's errors come back as they are (404 no results, 401, 429 with Retry-After)", async () => {
    for (const [status, extra] of [[404, {}], [401, {}], [429, { "Retry-After": "2" }]] as const) {
      const { f } = upstream(status, '{"detail":"x"}', { "Content-Type": "application/json", ...extra });
      const res = await handleProxy(req("/openf1/v1/sessions?session_key=latest"), { fetch: f });
      expect(res.status).toBe(status);
      if (status === 429) expect(res.headers.get("retry-after")).toBe("2");
    }
  });

  test("refuses anything else, without asking OpenF1", async () => {
    const cases: [Request, number][] = [
      [req("/openf1/v1/laps?session_key=1", {}, "POST"), 405],
      [req("/openf1/v1/laps?session_key=1", { "Sec-Fetch-Site": "cross-site" }), 403],
      [new Request(`${ORIGIN}/openf1/v1/laps?session_key=1`, { headers: { Authorization: TOKEN } }), 403], // no Sec-Fetch-Site (not a browser page of ours)
      [req("/openf1/v1/laps?session_key=1", { Authorization: "" }), 401], // anonymous: never a free-tier proxy
      [req("/openf1/v1/laps?session_key=1", { Authorization: "Basic dXNlcjpwYXNz" }), 401],
      [req("/openf1/v1/token"), 404],
      [req("/openf1/v1/laps/1"), 404],
      [req("/openf1/v1/../token"), 404],
      [req("/openf1/v2/laps"), 404],
      [req("/openf1/v1/laps?csv=true"), 400],
      [req("/openf1/v1/laps?session_key=1&session_key=2"), 400],
      [req("/openf1/v1/laps?session_key=%3Cscript%3E"), 400],
    ];
    for (const [r, status] of cases) {
      const { sent, f } = upstream();
      const res = await handleProxy(r, { fetch: f });
      expect([r.method, new URL(r.url).pathname + new URL(r.url).search, res.status]).toEqual([r.method, new URL(r.url).pathname + new URL(r.url).search, status]);
      expect(sent).toHaveLength(0);
    }
  });

  test("OpenF1 unreachable or slow: 502 / 504, not a hang", async () => {
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect((await handleProxy(req("/openf1/v1/laps?session_key=1"), { fetch: down })).status).toBe(502);
    const slow = ((_: string, init: RequestInit) =>
      new Promise((_r, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason)))) as unknown as typeof fetch;
    expect((await handleProxy(req("/openf1/v1/laps?session_key=1"), { fetch: slow, timeoutMs: 20 })).status).toBe(504);
    const redirect = upstream(302, "", { Location: "https://elsewhere.example/" });
    expect((await handleProxy(req("/openf1/v1/laps?session_key=1"), { fetch: redirect.f })).status).toBe(502);
  });

  test("the query must be one the vault's `get` accepts", () => {
    expect(parseQuery("?session_key=latest")).toEqual({ session_key: "latest" });
    // (As the vault writes it, restUrl: the URL parser encodes `>` and `<`, not `=`.)
    expect(parseQuery("?session_key=9&date%3E=2026-10-04T07%3A00%3A00.000Z&date%3C2026-10-04T08%3A00%3A00.000Z")).toEqual({
      session_key: "9",
      "date>=": "2026-10-04T07:00:00.000Z",
      "date<": "2026-10-04T08:00:00.000Z",
    });
    expect(parseQuery("")).toEqual({});
    expect(parseQuery("?foo=1")).toBeNull();
    expect(parseQuery(`?session_key=${"1".repeat(65)}`)).toBeNull();
    expect(parseQuery("?a=1&b=2&c=3&d=4&e=5&f=6&g=7&h=8&i=9")).toBeNull();
  });

  test("the Worker: /openf1/ to the pass-through, everything else to the static files", async () => {
    const assets: string[] = [];
    const env = { ASSETS: { fetch: async (r: Request) => (assets.push(new URL(r.url).pathname), new Response("file")) } };
    expect(await (await worker.fetch(new Request(`${ORIGIN}/frame.html`), env)).text()).toBe("file");
    const res = await worker.fetch(new Request(`${ORIGIN}/openf1/v1/laps?session_key=1`, { method: "POST" }), env);
    expect(res.status).toBe(405);
    expect((await worker.fetch(new Request(`${ORIGIN}/openf1/whatever`), env)).status).toBe(403);
    expect(assets).toEqual(["/frame.html"]);
  });
});
