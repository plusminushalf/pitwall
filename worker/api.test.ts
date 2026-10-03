import { describe, expect, test } from "bun:test";
import { raceById, verdict } from "../src/predictions/model";
import { handleApi, memoryStore } from "./api";

const SINGAPORE = raceById(11388)!;
const BEFORE = SINGAPORE.start - 3 * 86_400_000;
const AFTER = SINGAPORE.start + 2 * 3_600_000;

const call = (store = memoryStore(), at = BEFORE) => {
  const req = (path: string, init?: RequestInit) => handleApi(new Request(`https://x${path}`, init), store, () => at);
  const post = (path: string, body: unknown) => req(path, { method: "POST", body: JSON.stringify(body) });
  return { store, req, post, at: (t: number) => call(store, t) };
};

const lock = async (api = call(), body: Record<string, unknown> = {}) => {
  const res = await api.post("/api/predictions", { race: SINGAPORE.id, teams: ["ferrari", "mercedes", "mclaren"], hook: "Ferrari will pit too late. As always.", tz: "Europe/Rome", ...body });
  return { res: res!, data: (await res!.json()) as any };
};

describe("Called It API", () => {
  test("locks a call with the server's time and returns its link and the caller's token", async () => {
    const { res, data } = await lock();
    expect(res.status).toBe(201);
    expect(data.prediction.id).toMatch(/^[a-z0-9]{7}$/);
    expect(data.prediction.lockedAt).toBe(BEFORE);
    expect(data.prediction.tz).toBe("Europe/Rome");
    expect(data.ownerToken).toHaveLength(48);
    expect(data.prediction.ownerHash).toBeUndefined();
  });

  test("ignores a time sent by the page", async () => {
    const { data } = await lock(call(), { lockedAt: 1 });
    expect(data.prediction.lockedAt).toBe(BEFORE);
  });

  test("refuses calls once lights are out, bad teams and long hooks", async () => {
    expect((await lock(call(memoryStore(), SINGAPORE.start))).res.status).toBe(409);
    expect((await lock(call(), { teams: ["ferrari", "ferrari", "mclaren"] })).res.status).toBe(400);
    expect((await lock(call(), { teams: ["ferrari", "mclaren"] })).res.status).toBe(400);
    expect((await lock(call(), { teams: ["ferrari", "mclaren", "brawn"] })).res.status).toBe(400);
    expect((await lock(call(), { hook: "x".repeat(61) })).res.status).toBe(400);
    expect((await lock(call(), { hook: "   " })).res.status).toBe(400);
    expect((await lock(call(), { race: 11234 })).res.status).toBe(409);
  });

  test("cleans the hook and falls back to UTC for an unknown time zone", async () => {
    const { data } = await lock(call(), { hook: "  Mercedes\nwill   panic first. ", tz: "Mars/Olympus" });
    expect(data.prediction.hook).toBe("Mercedes will panic first.");
    expect(data.prediction.tz).toBe("UTC");
  });

  test("anyone can read a call; there's no way to edit it", async () => {
    const api = call();
    const { data } = await lock(api);
    const read = await api.req(`/api/predictions/${data.prediction.id}`);
    expect(((await read!.json()) as any).prediction).toEqual(data.prediction);
    expect((await api.req(`/api/predictions/${data.prediction.id}`, { method: "PUT", body: "{}" }))!.status).toBe(405);
    expect((await api.req("/api/predictions/zzzzzzz"))!.status).toBe(404);
  });

  test("only the caller reveals, only after lights out, only once", async () => {
    const api = call();
    const { data } = await lock(api);
    const path = `/api/predictions/${data.prediction.id}/result`;
    const order = ["ferrari", "mercedes", "mclaren"];
    expect((await api.post(path, { token: data.ownerToken, order }))!.status).toBe(409);
    const later = api.at(AFTER);
    expect((await later.post(path, { token: "nope", order }))!.status).toBe(403);
    expect((await later.post(path, { token: data.ownerToken, order: ["ferrari", "mercedes", "haas"] }))!.status).toBe(400);
    const res = await later.post(path, { token: data.ownerToken, order });
    expect(res!.status).toBe(200);
    const revealed = ((await res!.json()) as any).prediction;
    expect(revealed.result).toEqual({ order, source: "manual", at: AFTER });
    expect(verdict(revealed, revealed.result)).toBe("called");
    expect((await later.post(path, { token: data.ownerToken, order: ["mclaren", "mercedes", "ferrari"] }))!.status).toBe(409);
  });

  test("leaves other paths alone", async () => {
    expect(await call().req("/predictions/abc")).toBeNull();
    expect(await call().req("/session/11377")).toBeNull();
  });
});

describe("verdict", () => {
  const p = { teams: ["ferrari", "mercedes", "mclaren"] as const } as any;
  test("all, some or none", () => {
    expect(verdict(p, { order: ["ferrari", "mercedes", "mclaren"] })).toBe("called");
    expect(verdict(p, { order: ["ferrari", "mclaren", "mercedes"] })).toBe("partial");
    expect(verdict(p, { order: ["mercedes", "mclaren", "ferrari"] })).toBe("missed");
  });
});
