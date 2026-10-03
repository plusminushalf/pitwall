// The page's side of the API (worker/api.ts), and the caller's tokens: a call's link is public, its token (kept in
// this browser, or in a reveal link's #owner=…) is what lets its caller enter the result.

import type { NewPrediction, Outcome, Prediction } from "./model";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { ...init, headers: { "content-type": "application/json" } });
  } catch {
    throw new ApiError("No connection. Try again.", 0);
  }
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new ApiError(body.error ?? "Something went wrong. Try again.", res.status);
  return body;
}

export async function lockPrediction(p: NewPrediction): Promise<Prediction> {
  const { prediction, ownerToken } = await call<{ prediction: Prediction; ownerToken: string }>("/api/predictions", {
    method: "POST",
    body: JSON.stringify(p),
  });
  saveToken(prediction.id, ownerToken);
  return prediction;
}

export const getPrediction = (id: string) => call<{ prediction: Prediction }>(`/api/predictions/${id}`).then((r) => r.prediction);

export const revealPrediction = (id: string, outcome: Outcome) =>
  call<{ prediction: Prediction }>(`/api/predictions/${id}/result`, {
    method: "POST",
    body: JSON.stringify({ token: tokenFor(id), outcome }),
  }).then((r) => r.prediction);

const TOKENS = "called-it:tokens";
const readTokens = (): Record<string, string> => {
  try {
    return JSON.parse(localStorage.getItem(TOKENS) ?? "{}");
  } catch {
    return {};
  }
};

export const tokenFor = (id: string): string | undefined => readTokens()[id];

export function saveToken(id: string, token: string) {
  try {
    localStorage.setItem(TOKENS, JSON.stringify({ ...readTokens(), [id]: token }));
  } catch {
    // Private mode: the reveal link still works.
  }
}

/** Takes a reveal link's token into this browser and out of the address bar. */
export function adoptTokenFromHash(id: string) {
  const token = new URLSearchParams(location.hash.slice(1)).get("owner");
  if (!token) return;
  saveToken(id, token);
  history.replaceState(history.state, "", location.pathname + location.search);
}

export const revealLink = (id: string) => `${location.origin}/predictions/${id}#owner=${tokenFor(id) ?? ""}`;
