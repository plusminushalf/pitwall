import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { buildSession } from "../data/session"
import type { DriverTelemetry, SessionMeta } from "../types"
import {
    activationDistance,
    detectionDistance,
    overtakeModeOf,
    overtakeSwitch
} from "./overtakeMode"

test("race control's switches", () => {
    expect(overtakeSwitch("OVERTAKE ENABLED")).toBe(true)
    expect(overtakeSwitch("OVERTAKE DISABLED")).toBe(false)
    expect(
        overtakeSwitch("LAPPED CARS MAY NOW OVERTAKE THE SAFETY CAR: 55, 5, 11")
    ).toBe(null)
})

// ---------------------------------------------------------------- a real race

const dir = new URL("../../data/sessions/11731/", import.meta.url).pathname
const available = existsSync(`${dir}meta.json`)

describe.skipIf(!available)("overtake mode: Kuala Lumpur 2026", () => {
    const meta: SessionMeta = available
        ? JSON.parse(readFileSync(`${dir}meta.json`, "utf8"))
        : (null as unknown as SessionMeta)
    const telemetry: DriverTelemetry[] = available
        ? meta.drivers.map((d) =>
              JSON.parse(readFileSync(`${dir}drivers/${d.number}.json`, "utf8"))
          )
        : []
    const s = available ? buildSession(meta, telemetry) : null
    const mode = (n: number, lap: number) =>
        s ? overtakeModeOf(s, n, lap) : null

    test("detected on the way into T15, the last corner, not at the line", () => {
        if (!s) return
        const d = detectionDistance(s)
        expect(d).toBeGreaterThan(4_900)
        expect(d).toBeLessThan(5_100)
    })

    test("activated at T15's exit: after the detection point, before the line", () => {
        if (!s) return
        const d = detectionDistance(s)
        const a = activationDistance(s)
        expect(a - d).toBeGreaterThan(30)
        expect(a - d).toBeLessThan(70)
    })

    test("LEC chasing VER: within a second into T15", () => {
        const m = mode(16, 20)
        expect(m?.ahead).toBe(1)
        expect(m?.gap).toBeGreaterThan(0.5)
        expect(m?.gap).toBeLessThan(0.7)
    })

    test("side by side into T15: the car ahead is the one there first, not the one first over the line", () => {
        // LEC led VER into T15 at the end of lap 18; VER crossed the line 35 ms ahead.
        expect(mode(16, 19)?.ahead).toBe(27)
    })

    test("none on lap 1, before race control enables it, or out of the window", () => {
        expect(mode(16, 1)).toBe(null)
        expect(mode(16, 14)).toBe(null)
        expect(mode(12, 48)).toBe(null)
        expect(mode(16, 48)).toBe(null)
    })
})
