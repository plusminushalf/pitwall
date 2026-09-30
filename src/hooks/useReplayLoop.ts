import { useEffect } from "react";
import { runFrames } from "../blockkit/frame";
import { followStep } from "../data/liveEdge";
import { clock, liveEdge, useReplay } from "../store";

const PUBLISH_EVERY_MS = 100;

/**
 * Advances the replay clock every animation frame while playing. In live mode it follows the live edge
 * (a few seconds behind, in real time between updates) until the user scrubs back; playing forward
 * from there catches up and follows again.
 */
export function useReplayLoop() {
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let lastPublish = 0;
    const frame = (now: number) => {
      const dt = now - last;
      last = now;
      const { playing, speed, session, publish, setPlaying, mode, followLive, live, goLive } = useReplay.getState();
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
        clock.t = Math.min(clock.t + dt * speed, session.meta.duration);
        if (clock.t >= session.meta.duration) setPlaying(false);
        else moved = true;
      }
      if (moved && now - lastPublish >= PUBLISH_EVERY_MS) {
        lastPublish = now;
        publish();
      }
      // Canvas blocks draw this frame's time (block kit useFrame).
      runFrames();
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);
}
