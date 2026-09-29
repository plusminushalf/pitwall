// Live mode's clock: the relay's live edge as it moves, which the replay clock follows a few seconds behind.

/** How far behind the live edge the replay follows (wall time), so cars always have samples ahead. */
export const FOLLOW_BUFFER_MS = 3_000;
/** Between updates the edge is extrapolated this long at most (wall time), then it waits for data. */
const MAX_EXTRAPOLATE_MS = 2_000;
/**
 * Recent (wall, edge) samples, used to measure how fast the edge moves (1 live; faster in simulations)
 * and to extrapolate it. Some messages carry an edge that is already a little old when they arrive (the
 * relay computes `meta` before sending it), so the rate is a least-squares fit and the extrapolation
 * uses the most advanced sample.
 */
const WINDOW_MS = 10_000;
const RATE_MIN_SPAN_MS = 1_000;

/**
 * The relay's live edge (`now`, ms since meta.t0) as of each message, extrapolated between messages at
 * the rate it has been moving. Times in wall ms (performance.now()).
 */
export class LiveEdge {
  /** Latest edge received. */
  now = 0;
  /** Session ms per wall ms. */
  rate = 1;
  private samples: { wall: number; now: number }[] = [];

  /** A new edge from the relay; `restart` after a (re)connect or a new session: forget the old samples. */
  update(now: number, wall: number, restart = false): void {
    if (restart) this.samples = [];
    this.now = now;
    const s = this.samples;
    s.push({ wall, now });
    while (s.length > 2 && wall - s[0].wall > WINDOW_MS) s.shift();
    if (s.length < 3 || wall - s[0].wall < RATE_MIN_SPAN_MS) return;
    let mw = 0;
    let mn = 0;
    for (const p of s) {
      mw += p.wall;
      mn += p.now;
    }
    mw /= s.length;
    mn /= s.length;
    let num = 0;
    let den = 0;
    for (const p of s) {
      num += (p.wall - mw) * (p.now - mn);
      den += (p.wall - mw) ** 2;
    }
    if (den > 0) this.rate = Math.min(Math.max(num / den, 0), 1_000);
  }

  /** The edge extrapolated to `wall` (each sample at most MAX_EXTRAPOLATE_MS ahead), never behind the latest. */
  at(wall: number): number {
    let edge = this.now;
    for (const p of this.samples) edge = Math.max(edge, p.now + Math.min(Math.max(wall - p.wall, 0), MAX_EXTRAPOLATE_MS) * this.rate);
    return edge;
  }

  /** Buffer behind the edge in session ms (FOLLOW_BUFFER_MS of wall time at the edge's rate). */
  buffer(): number {
    return FOLLOW_BUFFER_MS * Math.max(1, this.rate);
  }

  /** Where the replay clock sits while following live; the edge itself once no more data will come. */
  target(wall: number, final = false): number {
    return Math.max(0, final ? this.now : this.at(wall) - this.buffer());
  }
}

/**
 * One animation frame of following live: `t` moves at the edge's rate, sped up while behind `target` and
 * slowed down while ahead of it (so corrections never jump backwards), and never past `limit` (the
 * data received so far). Far off (just joined, tab was hidden...) it jumps.
 */
export function followStep(t: number, target: number, dt: number, rate: number, limit: number): number {
  const scale = Math.max(1, rate);
  const err = target - t;
  const next = Math.abs(err) > 5_000 * scale ? target : t + dt * scale * Math.min(Math.max(1 + err / (2_000 * scale), 0), 2);
  return Math.max(0, Math.min(next, limit));
}
