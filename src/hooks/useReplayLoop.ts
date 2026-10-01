import { useEffect } from "react";
import { runFrames } from "../blockkit/frame";
import { followStep } from "../data/liveEdge";
import { clock, liveEdge, streamLimit, useReplay } from "../store";

const PUBLISH_EVERY_MS = 100;

/**
 * Advances the replay clock every animation frame while playing. In live mode it follows the live edge
 * (a few seconds behind, in real time between updates) until the user scrubs back; playing forward
 * from there catches up and follows again. A race watched while it downloads plays up to what's in.
 */
export function useReplayLoop() {
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let lastPublish = 0;
    const frame = (now: number) => {
      const dt = now - last;
      last = now;
      const { playing, speed, session, publish, setPlaying, mode, followLive, live, goLive, stream } = useReplay.getState();
      let moved = false;
      if (session && mode === "live") {
        const ended = live.state === "ended";
        const target = liveEdge.target(now, ended);
        if (followLive) {
          // Stay a little short of the newest data so every car has a sample ahead to move towards.
          const limit = ended ? liveEdge.now : liveEdge.now - liveEdge.buffer() / 6;
          clock.t = followStep(clock.t, target, dt, liveEdge.rate, limit);
          moved = true;
        } else if (playing) {
          clock.t = Math.min(clock.t + dt * speed, liveEdge.now);
          // Caught up with the live edge: follow it rather than pausing.
          if (clock.t >= target) goLive();
          else moved = true;
        }
      } else if (playing && session) {
        // A race streamed while it downloads only plays as far as what's in (and waits there for more).
        const { duration } = session.meta;
        const end = stream?.key === session.meta.sessionKey ? streamLimit(stream.spans, clock.t, duration) : duration;
        const t = Math.min(clock.t + dt * speed, end);
        moved = t !== clock.t;
        // Reaching what's in: published now, so it shows it's waiting there.
        if (moved && t === end) lastPublish = -Infinity;
        clock.t = t;
        if (clock.t >= duration) setPlaying(false);
      }
      if (moved && now - lastPublish >= PUBLISH_EVERY_MS) {
        lastPublish = now;
        publish();
      }
      // Canvas blocks draw this frame's time (block kit useFrame).
      runFrames(now);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);
}
