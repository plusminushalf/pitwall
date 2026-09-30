import { describe, expect, test } from "bun:test";
import { csp, formatHeaders, headerRules, headersFor, pageOf, parseHeaders } from "./headers";

const apps = ["https://f1replay.app", "http://localhost:5173"];

describe("csp", () => {
  test("frame: embeddable by the app origins only", () => {
    const c = csp("frame", apps);
    expect(c).toContain("default-src 'none'");
    expect(c).toContain("script-src 'self'");
    expect(c).toContain("style-src 'self'");
    expect(c).toContain("connect-src https://api.openf1.org wss://mqtt.openf1.org:8084");
    expect(c).toContain("base-uri 'none'");
    expect(c).toContain("form-action 'none'");
    expect(c).toContain("frame-ancestors https://f1replay.app http://localhost:5173");
    expect(c).not.toContain("unsafe");
    expect(c).not.toContain("*");
  });
  test("popup: embeddable by nobody", () => {
    expect(csp("popup", apps)).toContain("frame-ancestors 'none'");
    expect(csp("popup", apps)).not.toContain("f1replay.app");
  });
  test("no app origins is an error, not an open policy", () => {
    expect(() => csp("frame", [])).toThrow();
  });
});

describe("_headers", () => {
  const rules = headerRules(apps);
  test("round trip", () => {
    expect(parseHeaders(formatHeaders(rules))).toEqual(rules);
  });
  test("every page path gets exactly one CSP, plus the common headers; no COOP", () => {
    for (const path of ["/frame.html", "/frame", "/popup.html", "/popup"]) {
      const h = headersFor(rules, path);
      expect(h["Content-Security-Policy"]).toBe(csp(pageOf(path)!, apps));
      expect(h["X-Content-Type-Options"]).toBe("nosniff");
      expect(h["Referrer-Policy"]).toBe("no-referrer");
      expect(h["Cross-Origin-Resource-Policy"]).toBe("cross-origin");
      expect(Object.keys(h).some((k) => k.toLowerCase() === "cross-origin-opener-policy")).toBe(false);
    }
    expect(headersFor(rules, "/assets/frame-abc.js")["Content-Security-Policy"]).toBeUndefined();
    expect(headersFor(rules, "/assets/frame-abc.js")["X-Content-Type-Options"]).toBe("nosniff");
  });
  test("pageOf", () => {
    expect(pageOf("/frame.html")).toBe("frame");
    expect(pageOf("/popup")).toBe("popup");
    expect(pageOf("/")).toBe(null);
    expect(pageOf("/frame.html/x")).toBe(null);
  });
});
