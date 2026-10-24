import { describe, expect, test } from "bun:test"
import { parseUtc } from "./utc"

describe("parseUtc", () => {
    const at = Date.UTC(2026, 9, 24, 21, 1, 23, 456)
    test("a zoned timestamp as it says", () => {
        expect(parseUtc("2026-10-24T21:01:23.456000+00:00")).toBe(at)
        expect(parseUtc("2026-10-24T21:01:23.456Z")).toBe(at)
        expect(parseUtc("2026-10-24T16:01:23.456-05:00")).toBe(at)
    })
    test("one without a zone as UTC, not local time", () => {
        expect(parseUtc("2026-10-24T21:01:23.456000")).toBe(at)
        expect(parseUtc("2026-10-24T21:01:23.456")).toBe(at)
    })
    test("a date alone as UTC midnight", () => {
        expect(parseUtc("2026-10-24")).toBe(Date.UTC(2026, 9, 24))
    })
})
