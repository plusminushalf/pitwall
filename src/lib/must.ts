/** `x`, which a test needs to be there (a fixture's driver, a layout just made); throws if it's null or undefined. */
export function must<T>(x: T | null | undefined, what = "a value"): T {
    if (x == null) throw new Error(`expected ${what}`)
    return x
}
