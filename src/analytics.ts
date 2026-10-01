// Cloudflare Web Analytics on the hosted site: visits and page views per path (/, /session/<key>, /live), no cookies.
// Only in builds made with VITE_CF_BEACON_TOKEN (`bun run deploy`); the token is public, every page view sends it.
//
// The beacon counts every same-document navigation the Navigation API reports, history.replaceState included, and
// the address bar follows the replay's clock about once a second (hooks/useUrlState.ts). So a listener registered
// before the beacon loads keeps "replace" navigations from reaching the beacon's: only pushes (Home -> a session,
// live mode, back Home) and Back / Forward count. Browsers without the Navigation API get the beacon's pushState
// patch, which ignores replaceState anyway.

export function startAnalytics() {
  const token = import.meta.env.VITE_CF_BEACON_TOKEN;
  if (!token) return;
  window.navigation?.addEventListener("navigate", (e) => {
    if (e.navigationType === "replace") e.stopImmediatePropagation();
  });
  const beacon = document.createElement("script");
  beacon.defer = true;
  beacon.src = "https://static.cloudflareinsights.com/beacon.min.js";
  beacon.dataset.cfBeacon = JSON.stringify({ token });
  document.head.append(beacon);
}
