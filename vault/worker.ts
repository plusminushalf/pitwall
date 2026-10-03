// The Cloudflare Worker in front of the vault's static files (wrangler.jsonc): it runs only for /openf1/* (the REST
// pass-through, proxy.ts); everything else is served from dist/ as before, with dist/_headers.

import { handleProxy } from "./proxy.ts";

type Env = { ASSETS: { fetch(req: Request): Promise<Response> } };

export default {
  fetch(req: Request, env: Env): Promise<Response> {
    if (new URL(req.url).pathname.startsWith("/openf1/")) return handleProxy(req);
    return env.ASSETS.fetch(req);
  },
};
