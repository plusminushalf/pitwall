// The card as a 1080×1920 PNG, and the clipboard: the card or the text to post with it.

import { CARD_H, CARD_W } from "./Card";

export async function cardPng(node: HTMLElement): Promise<Blob> {
  await document.fonts.ready;
  // Loaded on the first copy, not with the page.
  const { domToBlob } = await import("modern-screenshot");
  return domToBlob(node, { width: CARD_W, height: CARD_H, scale: 1, type: "image/png", backgroundColor: "#08080b" });
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

/** Puts the card on the clipboard as a PNG; false where the browser can't. */
export async function copyImage(image: () => Promise<Blob>): Promise<boolean> {
  if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) return false;
  // A promise in the item, so Safari still counts the tap that asked for it.
  await navigator.clipboard.write([new ClipboardItem({ "image/png": image() })]);
  return true;
}

/** Whether this is a phone or tablet that can hand the card itself to another app (the share sheet: X, Instagram…). */
export function canShareImage(): boolean {
  if (typeof navigator.canShare !== "function" || !matchMedia("(pointer: coarse)").matches) return false;
  try {
    return navigator.canShare({ files: [new File([new Uint8Array(1)], "card.png", { type: "image/png" })] });
  } catch {
    return false;
  }
}

/** The card and its caption to the share sheet. The blob must be ready: the tap that asked has to still count. */
export async function shareImage(blob: Blob, text: string, name: string): Promise<"shared" | "cancelled" | "failed"> {
  try {
    await navigator.share({ files: [new File([blob], name, { type: "image/png" })], text });
    return "shared";
  } catch (e) {
    return e instanceof DOMException && e.name === "AbortError" ? "cancelled" : "failed";
  }
}
