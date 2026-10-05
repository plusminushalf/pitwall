import posthog from "posthog-js";

let initialized = false;

/** Whether the optional browser analytics client was successfully initialized. */
export const isPostHogEnabled = () => initialized;

/** Sends only purpose-written, non-PII application logs to PostHog Logs. */
export function logPostHog(message: string, attributes: Record<string, string | number | boolean>) {
  if (initialized) posthog.logger.info(message, attributes);
}

export function startPostHog() {
  if (initialized) return;

  const key = import.meta.env.VITE_POSTHOG_KEY;
  if (!key) {
    if (import.meta.env.DEV) {
      throw new Error("VITE_POSTHOG_KEY variable required by PostHog is missing or un-configured, this causes events to be silently missed. This error stops appearing once VITE_POSTHOG_KEY is configured");
    }
    return;
  }

  const host = import.meta.env.VITE_POSTHOG_HOST;
  if (!host) {
    if (import.meta.env.DEV) {
      throw new Error("VITE_POSTHOG_HOST variable required by PostHog is missing or un-configured, this causes events to be silently missed. This error stops appearing once VITE_POSTHOG_HOST is configured");
    }
    return;
  }

  posthog.init(key, {
    api_host: host,
    defaults: "2026-05-30",
    logs: {
      serviceName: "pitwall-web",
      environment: import.meta.env.MODE,
    },
    capture_exceptions: {
      capture_unhandled_errors: true,
      capture_unhandled_rejections: true,
      capture_console_errors: false,
    },
  });
  initialized = true;
}

export default posthog;
