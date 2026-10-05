import { startPostHog } from "./posthog";

// Cloudflare Web Analytics on the hosted site: visits and page views per path (/, /session/<key>, /live), no cookies.
// Only in builds made with VITE_CF_BEACON_TOKEN (`bun run deploy`); the token is public, every page view sends it.
//
// The beacon counts every same-document navigation the Navigation API reports, history.replaceState included, and
// the address bar follows the replay's clock about once a second (hooks/useUrlState.ts). So a listener registered
// before the beacon loads keeps "replace" navigations from reaching the beacon's: only pushes (Home -> a session,
// live mode, back Home) and Back / Forward count. Browsers without the Navigation API get the beacon's pushState
// patch, which ignores replaceState anyway.

let on = false;
/** A replace that's an event being counted (countEvent), not the clock. */
let counting = false;

export function startAnalytics() {
  startPostHog();
  const token = import.meta.env.VITE_CF_BEACON_TOKEN;
  if (!token) return;
  on = true;
  window.navigation?.addEventListener("navigate", (e) => {
    if (e.navigationType === "replace" && !counting) e.stopImmediatePropagation();
  });
  const beacon = document.createElement("script");
  beacon.defer = true;
  beacon.src = "https://static.cloudflareinsights.com/beacon.min.js";
  beacon.dataset.cfBeacon = JSON.stringify({ token });
  document.head.append(beacon);
}

/**
 * Counts something that happened as a page view of a path of its own, e.g. /predictions/lock/bahrain-gp/p5-nor, so it
 * shows under Top paths in Cloudflare Web Analytics, which has no events of its own and nothing to add a server for.
 * The address bar shows the path for an instant and goes back; nothing loads from it, and (with the Navigation API)
 * nothing is left in the history.
 */
export function countEvent(path: string) {
  if (!on) return;
  const here = location.pathname + location.search + location.hash;
  const state: unknown = history.state;
  if (window.navigation) {
    // The beacon takes the destination from the navigate event, so a replace does, and this one goes through.
    counting = true;
    try {
      history.replaceState(state, "", path);
    } finally {
      counting = false;
    }
  } else {
    // No Navigation API: the beacon's pushState patch counts the push (it ignores replaceState). The history keeps a
    // second entry for this page; Back once stays here.
    history.pushState(state, "", path);
  }
  history.replaceState(state, "", here);
}
