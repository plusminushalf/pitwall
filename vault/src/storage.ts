// What the vault stores, and how. Small on purpose, and swappable (H2.4):
//
// - `Secret` is what the vault needs to get tokens without asking the user. OpenF1 only has passwords
//   today. If it ever offers a revocable refresh token or a scoped API key, add a kind here and store that
//   instead: nothing else in the stored format changes.
// - `sealDevice` / `sealPasskey` / `openLogin` encrypt it (AES-GCM-256). "device": a key from generateKey
//   with extractable:false, kept in IndexedDB as a CryptoKey beside the ciphertext, so script can use it
//   but never read it out. "passkey": a key derived (HKDF) from the passkey's PRF output, which only the
//   authenticator can produce; nothing derived is stored.
// - `LoginStore` is where the sealed login lives: IndexedDB in the frame (its partition under the app's
//   site), an in-memory fake in tests.
//
// The decrypted secret and any token live only in frame memory, never in storage.

export type Secret = { kind: "password"; username: string; password: string };

type Mode = "device" | "passkey";

export type Sealed = { iv: ArrayBuffer; ciphertext: ArrayBuffer };

export type StoredLogin =
  | { v: 1; mode: "device"; /** masked */ account: string; key: CryptoKey; sealed: Sealed }
  | {
      v: 1;
      mode: "passkey";
      account: string;
      credentialId: ArrayBuffer;
      /** The PRF input the popup evaluates the passkey with. */
      prfSalt: ArrayBuffer;
      /** HKDF salt for turning the PRF output into the AES key. */
      hkdfSalt: ArrayBuffer;
      sealed: Sealed;
    };

export interface LoginStore {
  /** The stored login, or null. Throws if storage can't be used at all. */
  load(): Promise<StoredLogin | null>;
  save(login: StoredLogin): Promise<void>;
  clear(): Promise<void>;
}

// ---------------------------------------------------------------- sealing

const utf8 = new TextEncoder();
const aad = (mode: Mode) => utf8.encode(`f1-replay-vault v1 ${mode}`);
const HKDF_INFO = utf8.encode("f1-replay-vault v1 passkey key");

export const randomBytes = (n: number): ArrayBuffer => crypto.getRandomValues(new Uint8Array(n)).buffer;

async function seal(key: CryptoKey, mode: Mode, secret: Secret): Promise<Sealed> {
  const iv = randomBytes(12);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(mode) }, key, utf8.encode(JSON.stringify(secret)));
  return { iv, ciphertext };
}

function parseSecret(text: string): Secret {
  const x = JSON.parse(text) as Record<string, unknown>;
  if (x?.kind !== "password" || typeof x.username !== "string" || typeof x.password !== "string") throw new Error("bad secret");
  return { kind: "password", username: x.username, password: x.password };
}

/** An AES-GCM key from a passkey's 32-byte PRF output. Non-extractable; never stored. */
async function passkeyKey(prf: ArrayBuffer, hkdfSalt: ArrayBuffer): Promise<CryptoKey> {
  const ikm = await crypto.subtle.importKey("raw", prf, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: hkdfSalt, info: HKDF_INFO }, ikm, { name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function sealDevice(secret: Secret, account: string): Promise<StoredLogin> {
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  return { v: 1, mode: "device", account, key, sealed: await seal(key, "device", secret) };
}

export async function sealPasskey(secret: Secret, account: string, prf: ArrayBuffer, credentialId: ArrayBuffer, prfSalt: ArrayBuffer): Promise<StoredLogin> {
  const hkdfSalt = randomBytes(32);
  const key = await passkeyKey(prf, hkdfSalt);
  return { v: 1, mode: "passkey", account, credentialId, prfSalt, hkdfSalt, sealed: await seal(key, "passkey", secret) };
}

/** Decrypt a stored login (`prf` for passkey mode). Throws if it doesn't open: wrong passkey, damaged data. */
export async function openLogin(login: StoredLogin, prf?: ArrayBuffer): Promise<Secret> {
  let key: CryptoKey;
  if (login.mode === "device") key = login.key;
  else if (prf) key = await passkeyKey(prf, login.hkdfSalt);
  else throw new Error("passkey needed");
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: login.sealed.iv, additionalData: aad(login.mode) }, key, login.sealed.ciphertext);
  return parseSecret(new TextDecoder().decode(plain));
}

/** A stored record from IndexedDB is only trusted in this exact shape. */
export function isStoredLogin(x: unknown): x is StoredLogin {
  if (typeof x !== "object" || x === null) return false;
  const r = x as Record<string, unknown>;
  const sealed = r.sealed as Record<string, unknown> | undefined;
  const buf = (b: unknown) => b instanceof ArrayBuffer;
  if (r.v !== 1 || typeof r.account !== "string" || !sealed || !buf(sealed.iv) || !buf(sealed.ciphertext)) return false;
  if (r.mode === "device") return typeof CryptoKey !== "undefined" && r.key instanceof CryptoKey;
  if (r.mode === "passkey") return buf(r.credentialId) && buf(r.prfSalt) && buf(r.hkdfSalt);
  return false;
}

// ---------------------------------------------------------------- stores

/** Tests. Keeps the object as is (CryptoKeys included). */
export class MemoryStore implements LoginStore {
  value: StoredLogin | null = null;
  fail = false;
  async load() {
    if (this.fail) throw new Error("storage blocked");
    return this.value;
  }
  async save(login: StoredLogin) {
    if (this.fail) throw new Error("storage blocked");
    this.value = login;
  }
  async clear() {
    this.value = null;
  }
}

const DB = "f1-vault";
const STORE = "login";
const KEY = "login";

/** The frame's IndexedDB: one database, one object store, one record. */
export class IdbStore implements LoginStore {
  private db: Promise<IDBDatabase> | null = null;

  private open(): Promise<IDBDatabase> {
    return (this.db ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error("blocked"));
    }).catch((e) => {
      this.db = null;
      throw e;
    }));
  }

  private async run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await this.open();
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  async load() {
    const x = await this.run("readonly", (s) => s.get(KEY));
    return isStoredLogin(x) ? x : null;
  }
  async save(login: StoredLogin) {
    await this.run("readwrite", (s) => s.put(login, KEY));
  }
  async clear() {
    await this.run("readwrite", (s) => s.delete(KEY));
  }
}
