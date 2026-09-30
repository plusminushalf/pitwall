import { describe, expect, test } from "bun:test";
import { isStoredLogin, MemoryStore, openLogin, randomBytes, sealDevice, sealPasskey, type Secret } from "./storage";

const secret: Secret = { kind: "password", username: "a@b.co", password: "hunter2-unique" };
const text = (b: ArrayBuffer) => new TextDecoder().decode(b);

describe("device mode", () => {
  test("round trip, with a non-extractable key", async () => {
    const login = await sealDevice(secret, "a***@b.co");
    expect(login.mode).toBe("device");
    expect(text(login.sealed.ciphertext)).not.toContain("hunter2");
    expect(await openLogin(login)).toEqual(secret);
    if (login.mode !== "device") throw new Error();
    expect(login.key.extractable).toBe(false);
    expect(crypto.subtle.exportKey("raw", login.key)).rejects.toThrow();
    expect(isStoredLogin(login)).toBe(true);
  });
  test("tampering is detected", async () => {
    const login = await sealDevice(secret, "a***@b.co");
    new Uint8Array(login.sealed.ciphertext)[0]! ^= 1;
    expect(openLogin(login)).rejects.toThrow();
  });
});

describe("passkey mode", () => {
  test("opens only with the same PRF output; nothing derived is stored", async () => {
    const prf = randomBytes(32);
    const login = await sealPasskey(secret, "a***@b.co", prf, randomBytes(16), randomBytes(32));
    if (login.mode !== "passkey") throw new Error();
    expect(Object.keys(login).sort()).toEqual(["account", "credentialId", "hkdfSalt", "mode", "prfSalt", "sealed", "v"]);
    expect(await openLogin(login, prf)).toEqual(secret);
    expect(openLogin(login, randomBytes(32))).rejects.toThrow();
    expect(openLogin(login)).rejects.toThrow();
    expect(isStoredLogin(login)).toBe(true);
  });
  test("a device ciphertext can't be opened as a passkey one (bound by AAD)", async () => {
    const dev = await sealDevice(secret, "x");
    if (dev.mode !== "device") throw new Error();
    const prf = randomBytes(32);
    const pk = await sealPasskey(secret, "x", prf, randomBytes(16), randomBytes(32));
    const mixed = { ...pk, sealed: dev.sealed };
    expect(openLogin(mixed, prf)).rejects.toThrow();
  });
});

describe("isStoredLogin", () => {
  test("rejects other shapes", () => {
    for (const x of [null, 1, {}, { v: 1, mode: "device", account: "x", key: {}, sealed: { iv: new ArrayBuffer(12), ciphertext: new ArrayBuffer(1) } }, { v: 2, mode: "passkey" }, { v: 1, mode: "cloud", account: "x", sealed: { iv: new ArrayBuffer(12), ciphertext: new ArrayBuffer(1) } }]) {
      expect(isStoredLogin(x)).toBe(false);
    }
  });
});

describe("MemoryStore", () => {
  test("load / save / clear, and a blocked store throws", async () => {
    const s = new MemoryStore();
    expect(await s.load()).toBeNull();
    const login = await sealDevice(secret, "x");
    await s.save(login);
    expect(await s.load()).toBe(login);
    await s.clear();
    expect(await s.load()).toBeNull();
    s.fail = true;
    expect(s.load()).rejects.toThrow();
  });
});
