// PostHog on the hosted site, alongside Cloudflare Web Analytics (analytics.ts): page views, the events sent with
// track(), clicks (autocapture) and uncaught errors, to PostHog's EU cloud. Only in production builds made with
// VITE_POSTHOG_KEY (`bun run deploy`); the key is public, every event sends it. Never from the dev server, so working
// on the app (through a proxy or not) doesn't count as a visit.
//
// posthog-js is ~95 KB gzipped, so it loads after the page in a chunk of its own; anything tracked before it's
// ready isn't sent. It keeps a random visitor ID in localStorage, no cookie.

import type { PostHog } from "posthog-js";

let ph: PostHog | null = null;
let started = false;

export function startPostHog() {
  const key = import.meta.env.VITE_POSTHOG_KEY;
  if (!key || import.meta.env.DEV || started) return;
  started = true;
  void import("posthog-js").then(({ default: posthog }) => {
    posthog.init(key, {
      api_host: import.meta.env.VITE_POSTHOG_HOST ?? "https://eu.i.posthog.com",
      defaults: "2026-05-30",
      persistence: "localStorage",
      // Page views on pushes (Home -> a session, live mode, back Home) and Back / Forward, as Cloudflare counts them.
      // Replaces aren't visits: the address follows the replay's clock, and countEvent's paths are Cloudflare's.
      before_send: (e) => (e?.event === "$pageview" && e.properties.navigation_type === "replaceState" ? null : e),
      capture_exceptions: {
        capture_unhandled_errors: true,
        capture_unhandled_rejections: true,
        capture_console_errors: false,
      },
    });
    ph = posthog;
  });
}

/** Sends an event, e.g. track("widget_added", { widget_id: "track-map" }). Nothing about who; no-op when off. */
export function track(event: string, props?: Record<string, string | number | boolean>) {
  ph?.capture(event, props);
}
