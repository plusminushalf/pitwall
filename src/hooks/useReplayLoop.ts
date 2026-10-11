import { useEffect } from "react"
import { followStep } from "../data/liveEdge"
import { ghost, useQuali } from "../qualiStore"
import {
    clock,
    comparing,
    hasStaged,
    liveEdge,
    streamLimit,
    useReplay
} from "../store"
import { runFrames } from "../widgetkit/frame"

const PUBLISH_EVERY_MS = 100
/**
 * The whole UI's frame rate at most: the clock and every per-frame draw (useFrame) tick together, at no more than
 * this. A 120 Hz display skips every other animation frame rather than drawing the map twice as often.
 */
export const MAX_FPS = 60
/** A tick is due a little early (rAF timestamps jitter), so a 60 Hz display still gets every frame. */
const TICK_MS = (1000 / MAX_FPS) * 0.75

/**
 * Advances the replay clock every tick (at most MAX_FPS a second) while playing. In live mode it follows the live edge
 * (a few seconds behind, in real time between updates) until the user scrubs back; playing forward
 * from there catches up and follows again. A race watched while it downloads plays up to what's in.
 */
export function useReplayLoop() {
    useEffect(() => {
        let raf = 0
        let last = performance.now()
        let lastPublish = 0
        let lastGhostPublish = 0
        let wasPlaying = false
        const frame = (now: number) => {
            raf = requestAnimationFrame(frame)
            if (now - last < TICK_MS) return
            const dt = now - last
            last = now
            const {
                playing,
                speed,
                session,
                publish,
                setPlaying,
                mode,
                followLive,
                live,
                goLive,
                stream,
                screen
            } = useReplay.getState()
            let moved = false
            if (session && mode === "live") {
                const ended = live.state === "ended"
                const target = liveEdge.target(now, ended)
                if (followLive) {
                    // Stay a little short of the newest data so every car has a sample ahead to move towards.
                    const limit = ended
                        ? liveEdge.now
                        : liveEdge.now - liveEdge.buffer() / 6
                    clock.t = followStep(
                        clock.t,
                        target,
                        dt,
                        liveEdge.rate,
                        limit
                    )
                    moved = true
                } else if (playing) {
                    clock.t = Math.min(clock.t + dt * speed, liveEdge.now)
                    // Caught up with the live edge: follow it rather than pausing.
                    if (clock.t >= target) goLive()
                    else moved = true
                }
            } else if (playing && session && !comparing({ session, screen })) {
                // (The lap comparison plays its ghost laps instead: the replay stays where it was left.)
                // A race streamed while it downloads only plays as far as what's in (and waits there for more).
                const { duration } = session.meta
                const end =
                    stream?.key === session.meta.sessionKey
                        ? streamLimit(stream.spans, clock.t, duration)
                        : duration
                const t = Math.min(clock.t + dt * speed, end)
                moved = t !== clock.t
                // Reaching what's in: published now, so it shows it's waiting there.
                if (moved && t === end) lastPublish = -Infinity
                clock.t = t
                if (clock.t >= duration) setPlaying(false)
            }
            // Live data that came in is published with the next tick too, even while the clock stands still.
            if (
                (moved || hasStaged()) &&
                now - lastPublish >= PUBLISH_EVERY_MS
            ) {
                lastPublish = now
                publish()
            }
            // The lap comparison on screen: its ghost laps play (to the longest; play at the end starts them again).
            if (playing && ghost.end > 0) {
                if (!wasPlaying && ghost.t >= ghost.end) ghost.t = 0
                const { ghostSpeed } = useQuali.getState()
                ghost.t = Math.min(ghost.t + dt * ghostSpeed, ghost.end)
                if (ghost.t >= ghost.end) {
                    setPlaying(false)
                    useQuali.setState({ ghostT: ghost.t })
                } else if (now - lastGhostPublish >= PUBLISH_EVERY_MS) {
                    lastGhostPublish = now
                    useQuali.setState({ ghostT: ghost.t })
                }
            }
            wasPlaying = playing
            // Canvas widgets draw this frame's time (widget kit useFrame).
            runFrames(now)
        }
        raf = requestAnimationFrame(frame)
        return () => cancelAnimationFrame(raf)
    }, [])
}
