// What a phone gets instead of the app: Pitwall is built for a desktop or laptop screen (PRODUCT.md). Tablets
// and narrow desktop windows still get the app: a phone is a touch screen with no hover that is under 768 px
// wide upright, or under 500 px tall on its side.

import { useState } from "react";
import { Logo } from "./Logo";

const TOUCH = "(hover: none) and (pointer: coarse)";
export const isPhone = () => matchMedia(`${TOUCH} and (max-width: 767px), ${TOUCH} and (max-height: 500px)`).matches;

export function DesktopOnly() {
  const [copied, setCopied] = useState(false);
  // The whole link, so a shared race opens at the same place on the computer.
  const copy = () =>
    navigator.clipboard.writeText(location.href).then(
      () => setCopied(true),
      () => {},
    );
  return (
    <div className="flex h-full items-center justify-center px-6">
      <div className="max-w-sm text-center text-sm text-zinc-400">
        <h1 className="mb-4 flex justify-center text-zinc-100">
          <Logo className="h-10 w-auto" />
        </h1>
        <p className="text-base font-semibold text-zinc-100">Pitwall is desktop only for now.</p>
        <p className="mt-2">
          Open <span className="text-zinc-200">{location.host}</span> on a desktop or laptop.
        </p>
        <button
          onClick={copy}
          className="mt-5 rounded border border-zinc-700 px-4 py-2 font-semibold text-zinc-200 transition-colors hover:border-zinc-500 hover:text-white"
        >
          {copied ? "Link copied" : "Copy link"}
        </button>
      </div>
    </div>
  );
}
