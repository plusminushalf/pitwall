// The card as a 1080×1920 PNG, and handing it on: download it, or share it (the image where the platform takes
// files, else the link; without the Web Share API, the link is copied).

import { CARD_H, CARD_W } from "./Card";

export async function cardPng(node: HTMLElement): Promise<Blob> {
  await document.fonts.ready;
  // Loaded on the first download or share, not with the page.
  const { domToBlob } = await import("modern-screenshot");
  return domToBlob(node, { width: CARD_W, height: CARD_H, scale: 1, type: "image/png", backgroundColor: "#08080b" });
}

export function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export type Shared = "shared" | "copied" | "cancelled";

export async function share(opts: { url: string; text: string; image?: () => Promise<Blob>; name: string }): Promise<Shared> {
  try {
    if (navigator.share) {
      const blob = opts.image && "canShare" in navigator ? await opts.image() : null;
      const file = blob && new File([blob], opts.name, { type: "image/png" });
      // With a file, some apps drop the url: it goes in the text too.
      if (file && navigator.canShare({ files: [file] })) await navigator.share({ files: [file], text: `${opts.text} ${opts.url}` });
      else await navigator.share({ url: opts.url, text: opts.text });
      return "shared";
    }
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") return "cancelled";
  }
  await copy(opts.url);
  return "copied";
}

export async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const t = Object.assign(document.createElement("textarea"), { value: text });
    document.body.append(t);
    t.select();
    document.execCommand("copy");
    t.remove();
  }
}
