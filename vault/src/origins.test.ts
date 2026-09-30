import { describe, expect, test } from "bun:test";
import { DEFAULT_APP_ORIGINS, fromParent, isAllowed, parentOrigin, parseOrigins } from "./origins";

const allowed = parseOrigins(DEFAULT_APP_ORIGINS);

describe("parseOrigins", () => {
  test("default and lists", () => {
    expect(allowed).toEqual(["http://localhost:5173", "http://127.0.0.1:5173"]);
    expect(parseOrigins(" https://a.example , https://b.example:8443,https://a.example")).toEqual(["https://a.example", "https://b.example:8443"]);
  });
  test("rejects anything but exact http(s) origins", () => {
    for (const bad of ["", " , ", "*", "https://*.example", "https://a.example/", "https://a.example/path", "a.example", "file:///x", "javascript:alert(1)", "null", "https://a.example:443", "HTTPS://A.example", "wss://a.example"]) {
      expect(() => parseOrigins(bad)).toThrow();
    }
  });
});

describe("allowlist", () => {
  test("exact matches only", () => {
    expect(isAllowed("http://localhost:5173", allowed)).toBe(true);
    expect(isAllowed("http://localhost:5174", allowed)).toBe(false);
    expect(isAllowed("http://localhost", allowed)).toBe(false);
    expect(isAllowed("https://localhost:5173", allowed)).toBe(false);
    expect(isAllowed("http://localhost:5173/", allowed)).toBe(false);
    expect(isAllowed("http://localhost:51730", allowed)).toBe(false);
    expect(isAllowed("null", [...allowed, "null"])).toBe(false);
    expect(isAllowed(undefined, allowed)).toBe(false);
  });

  test("parentOrigin: the direct parent only", () => {
    expect(parentOrigin(["http://127.0.0.1:5173"], allowed)).toBe("http://127.0.0.1:5173");
    // Nested inside an allowed page, but the direct parent is not allowed.
    expect(parentOrigin(["https://evil.example", "http://127.0.0.1:5173"], allowed)).toBe(null);
    expect(parentOrigin([], allowed)).toBe(null);
    expect(parentOrigin(undefined, allowed)).toBe(null);
    expect(parentOrigin(["null"], allowed)).toBe(null);
  });

  test("fromParent: right window and right origin", () => {
    const parent = {};
    const other = {};
    const o = "http://127.0.0.1:5173";
    expect(fromParent({ origin: o, source: parent }, parent, o, allowed)).toBe(true);
    expect(fromParent({ origin: o, source: other }, parent, o, allowed)).toBe(false);
    expect(fromParent({ origin: o, source: null }, parent, o, allowed)).toBe(false);
    expect(fromParent({ origin: "http://localhost:5173", source: parent }, parent, o, allowed)).toBe(false);
    expect(fromParent({ origin: "https://evil.example", source: parent }, parent, "https://evil.example", allowed)).toBe(false);
  });
});
