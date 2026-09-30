// Equality checks for hook results: a block re-renders only when what it reads changed.

/** Same keys with identical values (or same-length arrays with identical items). */
export function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || !a || !b) return false;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const ka = Object.keys(a);
  const rb = b as Record<string, unknown>;
  return ka.length === Object.keys(b).length && ka.every((k) => Object.is((a as Record<string, unknown>)[k], rb[k]));
}

/** Structural equality over plain objects, arrays and Maps (other objects by identity). */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || !a || !b) return false;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  if (a instanceof Map) {
    if (!(b instanceof Map) || a.size !== b.size) return false;
    for (const [k, v] of a) if (!b.has(k) || !deepEqual(v, b.get(k))) return false;
    return true;
  }
  const proto = Object.getPrototypeOf(a);
  if ((proto !== Object.prototype && proto !== null) || Object.getPrototypeOf(b) !== proto) return false;
  const ka = Object.keys(a);
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  return ka.length === Object.keys(b).length && ka.every((k) => k in rb && deepEqual(ra[k], rb[k]));
}
