// The site's Worker. Static files are served by Cloudflare as before (wrangler.jsonc); only Called It's paths run
// this first (run_worker_first): its API, and its page, which gets the call's hook in its link-preview tags.
// Calls are kept in one Durable Object's SQLite database (PredictionStore), written once and never edited.

import { DurableObject } from "cloudflare:workers";
import { calledIt, driverIn, ID_PATTERN, raceById, type Call, type Result } from "../src/predictions/model";
import { handleApi, type Store, type Stored } from "./api";

interface Env {
  ASSETS: Fetcher;
  PREDICTIONS: DurableObjectNamespace<PredictionStore>;
}

interface Row extends Record<string, SqlStorageValue> {
  id: string;
  race: number;
  call: string;
  locked_at: number;
  tz: string;
  owner_hash: string;
  result: string | null;
}

export class PredictionStore extends DurableObject<Env> implements Store {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS predictions (
      id TEXT PRIMARY KEY,
      race INTEGER NOT NULL,
      kind TEXT NOT NULL,
      call TEXT NOT NULL,
      locked_at INTEGER NOT NULL,
      tz TEXT NOT NULL,
      owner_hash TEXT NOT NULL,
      result TEXT
    )`);
  }

  async insert(p: Stored): Promise<boolean> {
    const cur = this.sql.exec(
      "INSERT INTO predictions (id, race, kind, call, locked_at, tz, owner_hash) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING",
      p.id,
      p.race,
      p.call.kind,
      JSON.stringify(p.call),
      p.lockedAt,
      p.tz,
      p.ownerHash,
    );
    return cur.rowsWritten > 0;
  }

  async get(id: string): Promise<Stored | null> {
    const row = this.sql.exec<Row>("SELECT * FROM predictions WHERE id = ?", id).toArray()[0];
    if (!row) return null;
    return {
      id: row.id,
      race: row.race,
      call: JSON.parse(row.call) as Call,
      lockedAt: row.locked_at,
      tz: row.tz,
      result: row.result ? (JSON.parse(row.result) as Result) : null,
      ownerHash: row.owner_hash,
    };
  }

  async reveal(id: string, result: Result): Promise<boolean> {
    const cur = this.sql.exec("UPDATE predictions SET result = ? WHERE id = ? AND result IS NULL", JSON.stringify(result), id);
    return cur.rowsWritten > 0;
  }
}

const PAGE = /^\/predictions(?:\/([^/]*))?\/?$/;

/** The page, with link-preview tags for the call in its path (if any): "Hamilton leads lap 1.", and once right, "Called it." */
async function page(req: Request, env: Env, store: Store, id: string | undefined): Promise<Response> {
  const html = await env.ASSETS.fetch(new URL("/predictions/", req.url));
  const p = id && ID_PATTERN.test(id) ? await store.get(id) : null;
  const r = p && raceById(p.race);
  const d = p && driverIn(p.race, p.call.driver);
  const name = d ? d.last : "Someone";
  const title = !p
    ? "Called It: receipts for your F1 calls"
    : p.result && calledIt(p.call, p.result)
      ? `${name} led lap 1. Called it.`
      : `${name} leads lap 1.`;
  const description = r
    ? `Locked in before lights out at the ${r.name}. Who leads lap 1?`
    : "Call who leads lap 1 before lights out. Locked with a server timestamp, nobody can edit it.";
  const url = new URL(req.url);
  return new HTMLRewriter()
    .on("title", { element: (el) => void el.setInnerContent(title) })
    .on('meta[property="og:title"], meta[name="twitter:title"]', { element: (el) => void el.setAttribute("content", title) })
    .on('meta[name="description"], meta[property="og:description"], meta[name="twitter:description"]', {
      element: (el) => void el.setAttribute("content", description),
    })
    .on('meta[property="og:url"]', { element: (el) => void el.setAttribute("content", url.origin + url.pathname) })
    .transform(new Response(html.body, { status: p || !id ? 200 : 404, headers: html.headers }));
}

export default {
  async fetch(req, env): Promise<Response> {
    // One database for every call: a few writes a minute at most, and one place to read them from.
    const stub = env.PREDICTIONS.get(env.PREDICTIONS.idFromName("all"));
    // RPC's types loosen tuples to arrays; the rows are the same Stored the object returns.
    const store: Store = {
      insert: (p) => stub.insert(p),
      get: async (id) => (await stub.get(id)) as Stored | null,
      reveal: (id, result) => stub.reveal(id, result),
    };
    const api = await handleApi(req, store);
    if (api) return api;
    const m = PAGE.exec(new URL(req.url).pathname);
    if (m && (req.method === "GET" || req.method === "HEAD")) return page(req, env, store, m[1] || undefined);
    return env.ASSETS.fetch(req);
  },
} satisfies ExportedHandler<Env>;
