import { describe, expect, test } from "bun:test";
import { calledIt, raceById, SOMEONE_ELSE } from "../src/predictions/model";
import { handleApi, memoryStore } from "./api";

// Bahrain (at Sepang) has qualified; Singapore hasn't.
const BAHRAIN = raceById(11731)!;
const SINGAPORE = raceById(11388)!;
const BEFORE = BAHRAIN.start - 9 * 3_600_000;
const AFTER = BAHRAIN.start + 10 * 60_000;

const call = (store = memoryStore(), at = BEFORE) => {
  const req = (path: string, init?: RequestInit) => handleApi(new Request(`https://x${path}`, init), store, () => at);
  const post = (path: string, body: unknown) => req(path, { method: "POST", body: JSON.stringify(body) });
  return { store, req, post, at: (t: number) => call(store, t) };
};

const lock = async (api = call(), body: Record<string, unknown> = {}) => {
  const res = await api.post("/api/predictions", {
    race: BAHRAIN.id,
    call: { kind: "lap1-leader", driver: 44 },
    tz: "Europe/London",
    ...body,
  });
  return { res: res!, data: (await res!.json()) as any };
};

describe("Called It API", () => {
  test("locks a call with the server's time and returns its link and the caller's token", async () => {
    const { res, data } = await lock();
    expect(res.status).toBe(201);
    expect(data.prediction.id).toMatch(/^[a-z0-9]{7}$/);
    expect(data.prediction.call).toEqual({ kind: "lap1-leader", driver: 44 });
    expect(data.prediction.lockedAt).toBe(BEFORE);
    expect(data.prediction.tz).toBe("Europe/London");
    expect(data.ownerToken).toHaveLength(48);
    expect(data.prediction.ownerHash).toBeUndefined();
  });

  test("ignores a time sent by the page", async () => {
    const { data } = await lock(call(), { lockedAt: 1 });
    expect(data.prediction.lockedAt).toBe(BEFORE);
  });

  test("refuses calls once lights are out, before qualifying and outside the top five", async () => {
    expect((await lock(call(memoryStore(), BAHRAIN.start))).res.status).toBe(409);
    expect((await lock(call(), { race: SINGAPORE.id })).res.status).toBe(400);
    expect((await lock(call(), { call: { kind: "lap1-leader", driver: 1 } })).res.status).toBe(400); // Norris qualified sixth
    expect((await lock(call(), { call: { kind: "lap1-leader", driver: "44" } })).res.status).toBe(400);
    expect((await lock(call(), { call: { kind: "pit-order", teams: ["ferrari", "mercedes", "mclaren"] } })).res.status).toBe(400);
    expect((await lock(call(), { race: 11234 })).res.status).toBe(409);
  });

  test("falls back to UTC for an unknown time zone", async () => {
    const { data } = await lock(call(), { tz: "Mars/Olympus" });
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
    const outcome = { kind: "lap1-leader", driver: 44 };
    expect((await api.post(path, { token: data.ownerToken, outcome }))!.status).toBe(409);
    const later = api.at(AFTER);
    expect((await later.post(path, { token: "nope", outcome }))!.status).toBe(403);
    expect((await later.post(path, { token: data.ownerToken, outcome: { kind: "lap1-leader", driver: 1 } }))!.status).toBe(400);
    const res = await later.post(path, { token: data.ownerToken, outcome });
    expect(res!.status).toBe(200);
    const revealed = ((await res!.json()) as any).prediction;
    expect(revealed.result).toEqual({ ...outcome, source: "manual", at: AFTER });
    expect(calledIt(revealed.call, revealed.result)).toBe(true);
    expect((await later.post(path, { token: data.ownerToken, outcome: { kind: "lap1-leader", driver: 3 } }))!.status).toBe(409);
  });

  test("the leader can be someone outside the five", async () => {
    const api = call();
    const { data } = await lock(api);
    const res = await api.at(AFTER).post(`/api/predictions/${data.prediction.id}/result`, { token: data.ownerToken, outcome: { kind: "lap1-leader", driver: SOMEONE_ELSE } });
    const revealed = ((await res!.json()) as any).prediction;
    expect(calledIt(revealed.call, revealed.result)).toBe(false);
  });

  test("leaves other paths alone", async () => {
    expect(await call().req("/predictions/abc")).toBeNull();
    expect(await call().req("/session/11377")).toBeNull();
  });
});
