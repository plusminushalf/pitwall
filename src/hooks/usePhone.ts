// Is this a phone? One answer for the whole app, so every screen switches to its phone layout at the same
// moment. A phone is a narrow viewport (under 768 px) or a touch screen with no hover, whichever comes first;
// tablets in landscape and narrow desktop windows therefore get the phone layout too, which is the safe side.
// `useCoarsePointer` is the touch-only question (show hover-only controls, bigger hit targets) and is true on
// tablets of any width.

import { useSyncExternalStore } from "react";

const PHONE = "(max-width: 767px), (hover: none) and (pointer: coarse) and (max-height: 500px)";
const COARSE = "(hover: none) and (pointer: coarse)";

function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (notify) => {
      const mql = matchMedia(query);
      mql.addEventListener("change", notify);
      return () => mql.removeEventListener("change", notify);
    },
    () => matchMedia(query).matches,
    () => false,
  );
}

export const usePhone = () => useMedia(PHONE);
export const useCoarsePointer = () => useMedia(COARSE);
export const isPhone = () => matchMedia(PHONE).matches;
