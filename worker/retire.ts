// Only for the deploy that deletes Called It's old Durable Object (wrangler.jsonc): no path runs this.
export default {
  fetch: (req: Request, env: { ASSETS: { fetch: (r: Request) => Promise<Response> } }) => env.ASSETS.fetch(req),
};
