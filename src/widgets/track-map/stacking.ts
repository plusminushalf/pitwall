// Which car's dot is on top, and which car's label goes first, kept steady through the running order's
// changes (lap 1 reshuffles it every few seconds, the back of a pack stacked within a few px). Pure.

/**
 * The draw order (back to front) for this frame. It follows `target` (the running order, back-markers first),
 * except that two dots that overlap keep the order they were drawn in last frame (`last`) while they do, so a
 * pack's stack doesn't flip as positions change; once they part (or `held` says it's been long enough), the
 * target's order applies. `focused` is always on top. Cars not in `last` go where the target puts them.
 * Returns the order and whether it's holding back a swap.
 */
export function stackOrder(
  last: readonly number[] | null,
  target: readonly number[],
  focused: number | null,
  overlap: (a: number, b: number) => boolean,
  held: boolean,
): { order: number[]; holding: boolean } {
  const rest = target.filter((n) => n !== focused);
  const top = focused != null && target.includes(focused) ? [focused] : [];
  if (!last || held) return { order: [...rest, ...top], holding: false };
  // Last frame's order for the cars it had, in the places the target gives cars it had.
  const was = new Map(last.map((n, i) => [n, i]));
  const kept = rest.filter((n) => was.has(n)).sort((a, b) => was.get(a)! - was.get(b)!);
  let k = 0;
  const keep = rest.map((n) => (was.has(n) ? kept[k++] : n));
  // A swap shows only between dots that overlap: hold the order while any of those would swap.
  const at = new Map(rest.map((n, i) => [n, i]));
  for (let i = 0; i < keep.length; i++) {
    for (let j = i + 1; j < keep.length; j++) {
      if (at.get(keep[i])! > at.get(keep[j])! && overlap(keep[i], keep[j])) return { order: [...keep, ...top], holding: true };
    }
  }
  return { order: [...rest, ...top], holding: false };
}

/**
 * The order labels are placed in, from the draw order: the focused car, then the cars labelled last frame, then
 * the rest, each by priority (top of the stack first). So a label stays with its car while it fits, rather than
 * passing to whichever car the running order puts ahead of it.
 */
export function labelOrder<T>(drawOrder: readonly T[], focused: (c: T) => boolean, labelled: (c: T) => boolean): T[] {
  const top = [...drawOrder].reverse();
  return [...top.filter(focused), ...top.filter((c) => !focused(c) && labelled(c)), ...top.filter((c) => !focused(c) && !labelled(c))];
}
