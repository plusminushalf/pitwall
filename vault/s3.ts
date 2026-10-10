// Spike S3's success check, automated (`bun run vault:e2e --s3`; about 25 minutes): a simulated live session
// across two app tabs with every fault the vault is meant to survive, then the leak check.
//
// The session: race 11291 (Montreal 2026; data/raw/11291, gitignored), from 30 min before lights out to 5 min
// after the finish (2.1 h), at 6x, with 120 s tokens (a refresh and an MQTT handover every 100 s), 30 ms
// delivery jitter. All 14 topics in every tab. (Not 11377, the other test race: none of its pit stops is published
// after a later-dated one, so it can't show the late pit stop below.) On the way:
//   - two forced broker drops (reconnect + REST gap-fill);
//   - an outage timed on a pit stop published late: #87's slow stop on lap 30 entered the pit lane before three
//     others and left it after them, so when it is published the leader's pit lastSeen is already later than its
//     date. The broker drops just after the first of those later-dated stops is out, and the reconnect is refused
//     once (CONNACK 5), so the outage spans #87's publication: only the gap-fill can deliver it (a `date>=lastSeen`
//     gap-fill would miss it; pit is refetched whole);
//   - one CONNACK 5 refusal on a handover with a valid token (the connection cap: keep the old session);
//   - the leader tab closes; a new tab opens (the follower takes over the lead, the new tab follows);
//   - the new follower reloads;
//   - the leader's vault frame freezes for 25 s (freeze.ts; see there why not CDP): the visible follower
//     steals the lead after ~10 s; the old leader wakes, finds it lost the lock, and emits nothing stale.
// Pass criteria, per tab (a reload is a new tab), for the time it was open (its first subscribe to its last
// read, minus a margin at both ends):
//   - per topic, the app received every message the source published, once (laps and stints: every
//     document's final version; an intermediate version replaced during an outage can't be gap-filled,
//     since REST only has the latest; those are counted, not failed), and nothing the source didn't publish;
//   - per topic, the largest gap between consecutive message dates received is at most the source's own
//     largest gap in that window + 2 s (sim);
//   - never more than 2 concurrent broker sessions (the dev server's session table, which like OpenF1's
//     broker keeps a frozen tab's session until 1.5 x keepalive);
//   - then the leak check in both open tabs (app-origin storage + app heap snapshot: no password, no JWT).
// It also reports the arrival stalls (the longest time without car_data arriving, in sim time) and the size of
// the freeze -> steal window.

import { canonical, hash53 } from "./src/live";
import { SIM_TOPICS, VERSIONED, buildTimeline, offsetOf, shift, type SimTopic, type Timeline } from "./simdata";

export type S3Helpers = {
  chromium: any;
  repo: string;
  APP: string;
  VAULT: string;
  launchArgs: string[];
  appHmr: RegExp;
  keepAppLoaded: (ws: any) => void;
  /** Home's Settings panel, opened, where the OpenF1 account controls are. */
  account: (page: any) => Promise<any>;
  check: (name: string, ok: boolean, detail?: unknown) => void;
  up: (url: string) => Promise<boolean>;
  waitUp: (url: string, ms?: number) => Promise<void>;
  start: (cmd: string[], env?: Record<string, string>) => any;
  stop: (p: any) => void;
  findAppSecrets: (page: any, secrets: string[]) => Promise<{ findings: { what: string; where: string }[]; scanned: Record<string, number> }>;
  headed: boolean;
};

// (VAULT_S3_SPEED / VAULT_S3_START: a shorter run while working on it; the check is the defaults.)
const SESSION = Number(process.env.VAULT_S3_SESSION || 11291);
const SPEED = Number(process.env.VAULT_S3_SPEED || 6);
const START_S = Number(process.env.VAULT_S3_START || -1800);
const TOKEN_S = 120;
const JITTER_MS = 30;
/** Ignore this much (sim ms) at both ends of a tab's window: what was in flight when it subscribed or was read. */
const MARGIN_SIM = 30_000;
const GAP_TOLERANCE_SIM = 2_000;
const FREEZE_MS = 25_000;
const DENSE = ["car_data", "location"];

type Rec = Record<string, any>;
type Dump = { topics: Record<string, { h: string; d: string; k: string[] }>; arrivals: [number, string, number][] };
type TabRun = { name: string; fromSim: number; toSim: number; dump: Dump; openedWall: number; closedWall: number };

/** The recorder, installed in an app page: every message (content hash, date), and when batches arrived. */
function recorderSource() {
  return `(() => {
    ${canonical.toString()}
    ${hash53.toString()}
    const w = window;
    const rec = { topics: {}, arrivals: [], phases: [] };
    w.__rec = rec;
    // (Diagnostics: this tab's view of the stream phase, as status events brought it.)
    w.__vault.onEvent((e) => {
      const p = e.event === "status" && e.status.stream ? e.status.stream.phase : null;
      if (p && p !== rec.phase) rec.phases.push([Date.now(), (rec.phase = p)]);
    });
    w.__phases = (from) => rec.phases.filter((x) => x[0] >= from);
    w.__vault.onData((topic, ms) => {
      let r = rec.topics[topic];
      if (!r) r = rec.topics[topic] = { h: [], d: [], k: [] };
      const versioned = topic === "laps" || topic === "stints";
      for (const m of ms) {
        const { _id, _key, ...rest } = m;
        r.h.push(parseInt(hash53(canonical(rest)), 36));
        r.d.push(Date.parse(typeof m.date === "string" ? m.date : typeof m.date_start === "string" ? m.date_start : ""));
        if (versioned) r.k.push(m.driver_number + ":" + (topic === "laps" ? m.lap_number : m.stint_number));
      }
      rec.arrivals.push([Date.now(), topic, ms.length]);
    });
    w.__dumpRec = () => {
      const b64 = (arr) => {
        const bytes = new Uint8Array(new Float64Array(arr).buffer);
        let s = "";
        for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        return btoa(s);
      };
      const topics = {};
      for (const [t, r] of Object.entries(rec.topics)) topics[t] = { h: b64(r.h), d: b64(r.d), k: r.k };
      return { topics, arrivals: rec.arrivals };
    };
  })()`;
}

/**
 * Pit stops published after a later-dated one (the car entered the pit lane first and left it last), with the
 * moment to drop the broker: just after the first later-dated stop is published (so the pit lastSeen is already
 * past this stop's date), leaving `windowMs` until this stop's own publication. Original (unshifted) times.
 */
export function latePits(tl: Timeline): { i: number; rec: Rec; published: number; drop: number; windowMs: number }[] {
  const idx = [...tl.byTopic.get("pit")!];
  const out: { i: number; rec: Rec; published: number; drop: number; windowMs: number }[] = [];
  for (const x of idx) {
    const dated = Date.parse(tl.recs[x]!.date);
    const first = Math.min(...idx.filter((y) => Date.parse(tl.recs[y]!.date) > dated && tl.at[y]! < tl.at[x]!).map((y) => tl.at[y]!));
    if (!Number.isFinite(first) || first < tl.startOrig) continue;
    const windowMs = tl.at[x]! - first;
    out.push({ i: x, rec: tl.recs[x]!, published: tl.at[x]!, drop: first + Math.min(3_000, windowMs / 4), windowMs });
  }
  return out;
}

const unb64 = (s: string) => {
  const b = Buffer.from(s, "base64");
  return new Float64Array(b.buffer, b.byteOffset, b.byteLength / 8);
};

export async function runS3(h: S3Helpers): Promise<void> {
  const { check } = h;
  const SIM = `${h.VAULT}/__sim`;
  console.log(`S3: simulated session #${SESSION}, ${SPEED}x, from lights out ${START_S} s, ${TOKEN_S} s tokens, jitter ${JITTER_MS} ms`);

  // ---------------------------------------------------------------- servers
  if (!(await h.up(h.APP))) {
    console.log(`starting the app dev server on ${h.APP}`);
    h.start(["bun", "run", "dev", "--", "--port", "5173", "--strictPort"], { VITE_VAULT_ORIGIN: h.VAULT });
    await h.waitUp(h.APP);
  }
  let vault: any = null;
  if (await h.up(`${h.VAULT}/frame.html`)) {
    if (!(await h.up(`${SIM}/config`))) {
      check("S3 needs the vault dev server in simulate mode on :5174 (another vault server is running there)", false);
      return;
    }
    console.log(`using the simulating vault dev server already on ${h.VAULT}`);
  } else {
    vault = h.start(["bun", "run", "vault"], { VAULT_SIMULATE: String(SESSION), VAULT_SIMULATE_SPEED: String(SPEED), VAULT_SIMULATE_START: String(START_S), VAULT_SIMULATE_TOKEN_S: String(TOKEN_S), VAULT_SIMULATE_JITTER: String(JITTER_MS) });
    await h.waitUp(`${SIM}/config`, 60_000);
  }
  const post = async (path: string) => {
    const r = await fetch(`${SIM}${path}`, { method: "POST" });
    return r.json() as Promise<any>;
  };
  const stats = async () => (await (await fetch(`${SIM}/stats`)).json()) as any;

  console.log("S3: building the source timeline");
  const tl: Timeline = buildTimeline(h.repo, SESSION, START_S);
  const late = latePits(tl);
  const config = await post(`/control/reset?session=${SESSION}&speed=${SPEED}&start=${START_S}&token=${TOKEN_S}&jitter=${JITTER_MS}&dropEvery=0&refuseAt=`);
  const clock = { anchorWall: config.anchorWall as number, startOrig: tl.startOrig, speed: SPEED };
  const offset = offsetOf(clock);
  const simAt = (wall: number) => clock.anchorWall + (wall - clock.anchorWall) * SPEED;
  const wallAt = (sim: number) => clock.anchorWall + (sim - clock.anchorWall) / SPEED;
  const endSim = config.end as number;
  const t0 = Date.now();
  const at = (s: number) => new Date(wallAt(s)).toISOString().slice(11, 19);
  const log = (s: string) => console.log(`  [${((Date.now() - t0) / 1000).toFixed(0).padStart(4)} s wall, sim ${new Date(simAt(Date.now())).toISOString().slice(11, 19)}] ${s}`);
  console.log(`  the session ends at sim ${new Date(endSim).toISOString().slice(11, 19)} (wall ${at(endSim)}, in ${((wallAt(endSim) - Date.now()) / 60_000).toFixed(1)} min)`);

  // ---------------------------------------------------------------- browser
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "vault-s3-"));
  const ctx = await h.chromium.launchPersistentContext(dir, { headless: !h.headed, viewport: { width: 1280, height: 800 }, args: h.launchArgs });
  await ctx.routeWebSocket(h.appHmr, h.keepAppLoaded);
  await ctx.addInitScript(`(() => { if (location.origin !== ${JSON.stringify(h.VAULT)} || !location.pathname.startsWith("/popup")) return; window.close = () => { window.__closed = true; }; })();`);
  const pageErrors: string[] = [];
  const runs: TabRun[] = [];
  const fakeUser = "s3-sim@example.invalid";
  const fakePass = `s3-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  const leaders = new Map<string, { handovers: number; reconnects: number; duplicates: number; gapFilled: number; maxSessions: number }>();
  const statusLog: { wall: number; tab: string; role: string; leader: string | null; phase?: string }[] = [];
  const st = (p: any) => p.evaluate(() => (window as any).__vault.getState().status);

  const open = async (name: string) => {
    const p = await ctx.newPage();
    p.on("pageerror", (e: Error) => pageErrors.push(`${name}: ${e.message}`));
    await p.goto(`${h.APP}/?vault=debug`);
    await p.waitForFunction(() => !!(window as any).__vault?.getState().status?.tab, null, { timeout: 30_000 });
    return p;
  };
  const record = async (p: any) => {
    await p.evaluate(recorderSource());
    await p.evaluate((topics: string[]) => (window as any).__vault.subscribe(topics), [...SIM_TOPICS]);
    return Date.now();
  };
  const dump = async (name: string, p: any, openedWall: number): Promise<TabRun> => {
    const closedWall = Date.now();
    const d: Dump = await p.evaluate(() => (window as any).__dumpRec());
    const run = { name, fromSim: simAt(openedWall) + MARGIN_SIM, toSim: simAt(closedWall) - MARGIN_SIM, dump: d, openedWall, closedWall };
    runs.push(run);
    return run;
  };
  const poll = async (tabs: [string, any][]) => {
    for (const [name, p] of tabs) {
      const s = await st(p).catch(() => null);
      if (!s?.tab) continue;
      statusLog.push({ wall: Date.now(), tab: name, role: s.tab.role, leader: s.tab.leader, phase: s.stream?.phase });
      if (s.tab.role === "leader" && s.stream) {
        const prev = leaders.get(s.tab.id);
        leaders.set(s.tab.id, {
          handovers: Math.max(prev?.handovers ?? 0, s.stream.handovers),
          reconnects: Math.max(prev?.reconnects ?? 0, s.stream.reconnects),
          duplicates: Math.max(prev?.duplicates ?? 0, s.stream.duplicates),
          gapFilled: Math.max(prev?.gapFilled ?? 0, s.stream.gapFilled),
          maxSessions: Math.max(prev?.maxSessions ?? 0, s.stream.maxSessions),
        });
      }
    }
  };
  /** Sleep until wall time `until`, polling the tabs' status every 2 s. */
  const until = async (wall: number, tabs: [string, any][]) => {
    while (Date.now() < wall) {
      await poll(tabs);
      await Bun.sleep(Math.min(2000, Math.max(0, wall - Date.now())));
    }
  };
  const waitFor = async (what: string, p: any, pred: (s: any) => boolean, ms = 30_000) => {
    const end = Date.now() + ms;
    let s: any;
    while (Date.now() < end) {
      s = await st(p);
      if (s && pred(s)) return s;
      await Bun.sleep(200);
    }
    throw new Error(`timed out waiting for ${what}: ${JSON.stringify({ tab: s?.tab, phase: s?.stream?.phase })}`);
  };

  let freezeStart = 0;
  let stealAt = 0;
  let thawAt = 0;
  let pitReport = null as { publishedSim: number; dropSim: number; backSim: number; hash: number; dated: number } | null;
  try {
    // Two tabs; log in (any email and password: the simulation's /token) in the first.
    const A = await open("A");
    const B = await open("B");
    const popupP = A.waitForEvent("popup");
    await (await h.account(A)).getByTestId("vault-connect").click();
    const popup = await popupP;
    await popup.locator("#login").waitFor({ timeout: 10_000 });
    const popupSays = await popup.getByTestId("popup-sim").isVisible();
    await popup.getByLabel("OpenF1 email").fill(fakeUser);
    await popup.getByLabel("OpenF1 password").fill(fakePass);
    await popup.getByRole("button", { name: "Connect" }).click();
    await (await h.account(A)).locator("[data-testid=vault-state][data-state=connected]").waitFor({ timeout: 20_000 });
    await (await h.account(B)).locator("[data-testid=vault-state][data-state=connected]").waitFor({ timeout: 20_000 });
    await popup.close().catch(() => {});
    check("S3: fake login (the simulation's /token), both tabs connected, the app and the login popup say SIMULATED", popupSays && (await A.getByTestId("vault-sim-badge").isVisible()) && (await B.getByTestId("vault-sim-badge").isVisible()));
    const sa = await st(A);
    check("S3: A leads, B follows", sa.tab.role === "leader" && (await st(B)).tab.role === "follower");
    const openA = await record(A);
    const openB = await record(B);
    await waitFor("the stream", A, (s) => s.stream?.phase === "connected" && s.stream.topics.length === SIM_TOPICS.length);
    log("A (leader) and B (follower) subscribed to every topic");
    await post("/control/stats-reset");

    const span = wallAt(endSim) - Date.now();
    const mark = (f: number) => Date.now() + span * f;
    const tDrop1 = mark(0.1);
    const tRefuse = mark(0.2);
    const tCloseA = mark(0.33);
    const tReloadC = mark(0.47);
    let tFreeze = mark(0.6);
    const tDrop2 = mark(0.8);
    // The late pit stop's outage: between A's close and the freeze (tabs B and C), clear of the other events.
    const pit = late
      .map((c) => ({ ...c, wall: wallAt(c.drop + offset), publishedSim: c.published + offset, dated: Date.parse(c.rec.date) + offset }))
      .filter((c) => c.wall > tCloseA + 30_000 && c.wall < tFreeze + 30_000 && Math.abs(c.wall - tReloadC) > 30_000)
      .sort((a, b) => b.windowMs - a.windowMs)[0];
    if (pit && tFreeze - pit.wall < 90_000) tFreeze = pit.wall + 90_000;
    check(
      `S3: the session has a pit stop published after a later-dated one, inside the scenario (${late.length} such stops in the session)`,
      !!pit && tFreeze < tDrop2 - 60_000,
      pit ? `#${pit.rec.driver_number} lap ${pit.rec.lap_number}: ${(pit.windowMs / 1000).toFixed(1)} s sim from the first later-dated stop's publication to its own` : "",
    );
    const pitOutage = async (leader: any, tabs: [string, any][]) => {
      if (!pit) return;
      await until(pit.wall, tabs);
      const before = (await st(leader)).stream;
      const dropped = await post("/control/drop");
      const armed = await post("/control/refuse?n=1");
      log(`late pit stop: dropped the broker just after the first later-dated stop's publication (${JSON.stringify(dropped)}); the reconnect is refused once (${JSON.stringify(armed)})`);
      const back = await waitFor("the reconnect after the pit outage", leader, (s) => s.stream.reconnects > before.reconnects && s.stream.phase === "connected", 60_000).catch((e) => e);
      const backSim = simAt(Date.now());
      pitReport = { publishedSim: pit.publishedSim, dropSim: simAt(pit.wall), backSim, dated: pit.dated, hash: parseInt(hash53(canonical(JSON.parse(JSON.stringify(shift(pit.rec, offset))))), 36) };
      check(
        "S3: the late pit stop was published during the outage (the reconnect and gap-fill came after it)",
        !(back instanceof Error) && backSim > pit.publishedSim,
        back instanceof Error ? back.message : `back ${((backSim - pit.publishedSim) / 1000).toFixed(1)} s sim after its publication`,
      );
    };

    await until(tDrop1, [["A", A], ["B", B]]);
    log(`drop 1: ${JSON.stringify(await post("/control/drop"))}`);
    await waitFor("the reconnect", A, (s) => s.stream.reconnects >= 1 && s.stream.phase === "connected", 60_000);
    log("A reconnected and gap-filled");

    await until(tRefuse, [["A", A], ["B", B]]);
    const armedAt = Date.now();
    await post("/control/refuse?n=1");
    log("armed one CONNACK 5 for the next CONNECT (the next handover)");
    const limited = await waitFor("connection-limit", A, (s) => s.stream.phase === "connection-limit", 130_000).catch((e) => e);
    const why = async () => {
      const phases: [number, string][] = await A.evaluate((from: number) => (window as any).__phases(from), armedAt);
      const s = await stats();
      return `phases since armed: ${phases.map(([t, p]) => `+${((t - armedAt) / 1000).toFixed(1)} s ${p}`).join(", ") || "none"}; broker: ${s.connects} connects, ${s.refused} refused`;
    };
    check("S3: CONNACK 5 on a handover with a valid token: connection-limit, the old session kept", !(limited instanceof Error) && limited.stream.sessions === 1, limited instanceof Error ? `${limited.message}; ${await why()}` : `${limited.stream.sessions} session(s)`);
    await waitFor("the retried handover", A, (s) => s.stream.phase === "connected", 60_000);
    log("the handover completed after the backoff");

    await until(tCloseA, [["A", A], ["B", B]]);
    await dump("A", A, openA);
    await A.close();
    log("closed the leader tab A");
    const tookB = await waitFor("B takes over", B, (s) => s.tab.role === "leader" && s.stream?.phase === "connected", 30_000).catch((e) => e);
    check("S3: the leader tab closed: B takes over and streams", !(tookB instanceof Error), tookB instanceof Error ? tookB.message : "");
    const C = await open("C");
    await (await h.account(C)).locator("[data-testid=vault-state][data-state=connected]").waitFor({ timeout: 20_000 });
    let openC = await record(C);
    check("S3: a new tab C follows B, connected with the shared login", (await st(C)).tab.role === "follower" && (await st(C)).tab.leader === (await st(B)).tab.id);
    log("opened tab C (follower)");

    if (pit && pit.wall < tReloadC) await pitOutage(B, [["B", B], ["C", C]]);
    await until(tReloadC, [["B", B], ["C", C]]);
    await dump("C1", C, openC);
    await C.reload();
    await C.waitForFunction(() => !!(window as any).__vault?.getState().status?.tab, null, { timeout: 30_000 });
    await (await h.account(C)).locator("[data-testid=vault-state][data-state=connected]").waitFor({ timeout: 20_000 });
    openC = await record(C);
    log(`reloaded the follower C (${(await st(C)).tab.role})`);

    if (pit && pit.wall > tReloadC) await pitOutage(B, [["B", B], ["C", C]]);
    await until(tFreeze, [["B", B], ["C", C]]);
    const bId = (await st(B)).tab.id;
    freezeStart = Date.now();
    await B.evaluate((ms: number) => (window as any).__vault.debug.freeze(ms), FREEZE_MS);
    log(`froze B's vault frame (the leader) for ${FREEZE_MS / 1000} s`);
    const stole = await waitFor("C steals the lead", C, (s) => s.tab.role === "leader", 20_000).catch((e) => e);
    stealAt = Date.now();
    check("S3: a frozen leader: the visible follower steals the lock", !(stole instanceof Error) && stole.tab.steals === 1, stole instanceof Error ? stole.message : `after ${((stealAt - freezeStart) / 1000).toFixed(1)} s`);
    await waitFor("C streams", C, (s) => s.stream?.phase === "connected", 30_000).catch(() => {});
    log(`C leads after ${((stealAt - freezeStart) / 1000).toFixed(1)} s; ${JSON.stringify((await stats()).sessions.length)} broker session(s) open`);
    await Bun.sleep(Math.max(0, freezeStart + FREEZE_MS + 3000 - Date.now()));
    thawAt = freezeStart + FREEZE_MS;
    const sb = await waitFor("B follows again", B, (s) => s.tab.role === "follower", 15_000).catch((e) => e);
    check("S3: the old leader wakes, finds it lost the lock, and follows C", !(sb instanceof Error) && sb.tab.lost === 1 && sb.tab.leader === (await st(C)).tab.id && sb.tab.id === bId, sb instanceof Error ? sb.message : "");
    log("B woke up and follows C");

    await until(tDrop2, [["B", B], ["C", C]]);
    log(`drop 2: ${JSON.stringify(await post("/control/drop"))}`);
    await waitFor("the reconnect", C, (s) => s.stream.reconnects >= 1 && s.stream.phase === "connected", 60_000);

    // To the end of the session (and the late documents), then read both tabs.
    await until(wallAt(endSim) + (MARGIN_SIM * 2) / SPEED, [["B", B], ["C", C]]);
    await poll([["B", B], ["C", C]]);
    await dump("B", B, openB);
    await dump("C2", C, openC);
    const final = await stats();
    log(`session over; broker stats ${JSON.stringify({ max: final.max, connects: final.connects, refused: final.refused, kicked: final.kicked, expired: final.expired, drops: final.drops, tokens: final.tokens, rest: final.rest, rest429: final.rest429, rest401: final.rest401 })}`);

    // ---------------------------------------------------------------- the comparison
    console.log("S3: comparing every tab with the source");
    const srcHash = new Float64Array(tl.at.length);
    for (let i = 0; i < tl.at.length; i++) srcHash[i] = parseInt(hash53(canonical(JSON.parse(JSON.stringify(shift(tl.recs[i]!, offset))))), 36);
    const simOf = (i: number) => tl.at[i]! + offset;
    type Row = { tab: string; topic: string; expected: number; got: number; missing: number; dup: number; unexpected: number; skippedVersions: number; repeats: number; gapExcess: number; srcGap: number; gotGap: number; missingAt: number[] };
    const rows: Row[] = [];
    for (const run of runs) {
      for (const topic of SIM_TOPICS) {
        const idx = tl.byTopic.get(topic)!;
        const r = run.dump.topics[topic];
        const hs = r ? unb64(r.h) : new Float64Array(0);
        const ds = r ? unb64(r.d) : new Float64Array(0);
        const all = new Set<number>();
        const inWin: number[] = [];
        // Content published before the tab opened: the vault (rightly) treats a later identical copy as a
        // duplicate (dedupe is by content; a new tab gets the leader's seen keys), so it isn't expected again.
        const earlier = new Set<number>();
        const opened = simAt(run.openedWall);
        let repeats = 0;
        for (const i of idx) {
          if (simOf(i) <= simAt(run.closedWall)) all.add(srcHash[i]!);
          if (simOf(i) <= opened) earlier.add(srcHash[i]!);
          else if (simOf(i) > run.fromSim && simOf(i) <= run.toSim) {
            if (earlier.has(srcHash[i]!)) repeats++;
            else inWin.push(i);
          }
        }
        const got = new Map<number, number>();
        for (const x of hs) got.set(x, (got.get(x) ?? 0) + 1);
        let dup = 0;
        for (const n of got.values()) if (n > 1) dup += n - 1;
        let unexpected = 0;
        for (const x of got.keys()) if (!all.has(x)) unexpected++;
        const expectedSet = new Set(inWin.map((i) => srcHash[i]!));
        let missing = 0;
        let skipped = 0;
        const missingAt: number[] = [];
        if (VERSIONED.has(topic as SimTopic)) {
          // Each document's last version in the window must be there; earlier ones may have been replaced.
          const last = new Map<string, number>();
          for (const i of inWin) last.set(tl.keys[i]!, i);
          const finals = new Set([...last.values()]);
          for (const i of finals)
            if (!got.has(srcHash[i]!)) {
              missing++;
              missingAt.push(simOf(i));
              const versions = inWin.filter((j) => tl.keys[j] === tl.keys[i]);
              const seen = versions.filter((j) => got.has(srcHash[j]!)).length;
              console.log(`    (${run.name} ${topic} ${tl.keys[i]}: final at sim ${new Date(simOf(i)).toISOString().slice(11, 23)} missing; ${versions.length} versions in the window, ${seen} received; emitted with ${tl.at.filter((a) => a === tl.at[i]).length - 1} others)`);
            }
          const finalHashes = new Set([...finals].map((i) => srcHash[i]!));
          for (const x of expectedSet) if (!finalHashes.has(x) && !got.has(x)) skipped++;
        } else for (const i of inWin) if (!got.has(srcHash[i]!)) (missing++, missingAt.push(simOf(i)));
        // Gaps between consecutive dates, source vs received, inside the window (dated topics).
        const gapOf = (dates: number[]) => {
          const s = [...new Set(dates.filter((d) => Number.isFinite(d) && d > run.fromSim && d <= run.toSim))].sort((a, b) => a - b);
          let g = 0;
          for (let i = 1; i < s.length; i++) g = Math.max(g, s[i]! - s[i - 1]!);
          return { g, n: s.length };
        };
        const srcDates = inWin.map((i) => Date.parse(String(tl.recs[i]!.date ?? ""))).map((d) => d + offset);
        const src = gapOf(srcDates);
        const mine = gapOf([...ds]);
        const dated = src.n > 1 && !VERSIONED.has(topic as SimTopic) && topic !== "pit";
        rows.push({ tab: run.name, topic, expected: expectedSet.size, got: got.size, missing, dup, unexpected, skippedVersions: skipped, repeats, srcGap: src.g, gotGap: dated ? mine.g : 0, gapExcess: dated && mine.n ? mine.g - src.g : 0, missingAt });
      }
    }

    // Arrival stalls: the longest time with no car_data / location arriving at the app, per tab (sim s), inside
    // and outside the freeze/steal window (the freeze until 5 s after the thaw). A drop's stall is the reconnect
    // plus the gap-fill (the rows arrive late, but in place: the date-gap check above is what "no visible gap"
    // means).
    const stalls = runs.map((run) => {
      const t = run.dump.arrivals.filter((a) => DENSE.includes(a[1])).map((a) => a[0]).filter((x) => x >= run.openedWall + 5000);
      let out = 0;
      let inside = 0;
      for (let i = 1; i < t.length; i++) {
        const g = t[i]! - t[i - 1]!;
        const overlaps = freezeStart > 0 && t[i]! >= freezeStart && t[i - 1]! <= thawAt + 5000;
        if (overlaps) inside = Math.max(inside, g);
        else out = Math.max(out, g);
      }
      return { tab: run.name, stallSim: (out * SPEED) / 1000, freezeStallSim: (inside * SPEED) / 1000 };
    });

    // ---------------------------------------------------------------- the table
    const pad = (s: unknown, n: number) => String(s).padStart(n);
    console.log("\n  S3 summary (sim time; windows are each tab's open time minus 30 s sim at both ends)");
    console.log(`  ${"tab".padEnd(4)} ${pad("window", 13)} ${pad("expected", 9)} ${pad("received", 9)} ${pad("missing", 8)} ${pad("dupes", 6)} ${pad("unexpect", 8)} ${pad("skipped v", 9)} ${pad("repeats", 7)} ${pad("worst gap vs source", 30)} ${pad("stall out/in freeze", 19)}`);
    for (const run of runs) {
      const rs = rows.filter((r) => r.tab === run.name);
      const sum = (k: keyof Row) => rs.reduce((n, r) => n + (r[k] as number), 0);
      const worst = rs.reduce((w, r) => (r.gapExcess > w.gapExcess ? r : w), rs[0]!);
      const stall = stalls.find((s) => s.tab === run.name)!;
      const win = `${new Date(run.fromSim).toISOString().slice(11, 16)}-${new Date(run.toSim).toISOString().slice(11, 16)}`;
      console.log(
        `  ${run.name.padEnd(4)} ${pad(win, 13)} ${pad(sum("expected"), 9)} ${pad(sum("got"), 9)} ${pad(sum("missing"), 8)} ${pad(sum("dup"), 6)} ${pad(sum("unexpected"), 8)} ${pad(sum("skippedVersions"), 9)} ${pad(sum("repeats"), 7)} ${pad(`${worst.topic} +${(worst.gapExcess / 1000).toFixed(1)} s (${(worst.gotGap / 1000).toFixed(1)}/${(worst.srcGap / 1000).toFixed(1)})`, 30)} ${pad(`${stall.stallSim.toFixed(0)} s / ${stall.freezeStallSim ? `${stall.freezeStallSim.toFixed(0)} s` : "-"}`, 19)}`,
      );
    }
    console.log("  (worst gap: the largest excess of a topic's gap between consecutive received message dates over the source's own, received/source s;");
    console.log("   skipped v: lap/stint versions replaced during an outage, which REST can't return; repeats: republished content identical to what");
    console.log("   was delivered before the tab opened; stall: the longest time without car_data/location arriving, sim s, outside / inside the");
    console.log("   freeze window, i.e. from the freeze to 5 s after the thaw)");
    const bad = rows.filter((r) => r.missing || r.dup || r.unexpected);
    const hmsms = (t: number) => new Date(t).toISOString().slice(11, 23);
    if (bad.length)
      for (const r of bad.slice(0, 20)) {
        const m = r.missingAt.sort((a, b) => a - b);
        console.log(`    ${r.tab} ${r.topic}: expected ${r.expected}, missing ${r.missing}${m.length ? ` (sim ${hmsms(m[0]!)} .. ${hmsms(m.at(-1)!)})` : ""}, dupes ${r.dup}, unexpected ${r.unexpected}`);
      }
    const simT = (w: number) => (w ? hmsms(simAt(w)) : "-");
    console.log(`  (sim times: A closed ${simT(runs.find((r) => r.name === "A")?.closedWall ?? 0)}, freeze ${simT(freezeStart)}, steal ${simT(stealAt)}, thaw ${simT(thawAt)})`);
    const totalLeaders = [...leaders.values()];
    const sumL = (k: "handovers" | "reconnects" | "duplicates" | "gapFilled") => totalLeaders.reduce((n, l) => n + l[k], 0);
    const stealWindow = stealAt && freezeStart ? stealAt - freezeStart : 0;
    const cStall = stalls.find((s) => s.tab === "C2");
    console.log(
      `  events: ${final.drops} drops, ${final.refused} CONNACK 5, ${sumL("handovers")} handovers, ${sumL("reconnects")} reconnects, ${totalLeaders.length} leaders, ${sumL("duplicates")} dupes dropped, ${sumL("gapFilled")} gap-filled, ${final.tokens} /token, ${final.rest} REST (${final.rest429} 429, ${final.rest401} 401), max ${final.max} concurrent sessions (${final.kicked} kicked by a reused clientId, ${final.expired} expired)`,
    );
    console.log(`  freeze -> steal: ${(stealWindow / 1000).toFixed(1)} s wall = ${((stealWindow * SPEED) / 1000).toFixed(0)} s sim; arrivals at C stalled ${cStall?.freezeStallSim ? cStall.freezeStallSim.toFixed(0) : "?"} s sim in it, B's app ${stalls.find((s) => s.tab === "B")?.freezeStallSim.toFixed(0) ?? "?"} s sim`);

    if (pitReport) {
      const p = pitReport;
      const inWindow = runs.filter((r) => p.publishedSim > r.fromSim && p.publishedSim <= r.toSim);
      const got = inWindow.map((r) => ({ tab: r.name, n: r.dump.topics.pit ? [...unb64(r.dump.topics.pit.h)].filter((x) => x === p.hash).length : 0 }));
      console.log(`  late pit stop: dated sim ${hmsms(p.dated)}, published ${hmsms(p.publishedSim)} (${((p.publishedSim - p.dated) / 1000).toFixed(0)} s later); outage from ${hmsms(p.dropSim)} to ${hmsms(p.backSim)}; received ${got.map((g) => `${g.tab} x${g.n}`).join(", ")}`);
      check("S3: the late pit stop reached every tab open at the time, once (gap-filled: pit is refetched whole)", inWindow.length >= 2 && got.every((g) => g.n === 1), got.map((g) => `${g.tab} x${g.n}`).join(", "));
    }
    for (const run of runs) {
      const rs = rows.filter((r) => r.tab === run.name);
      check(`S3 ${run.name}: every message of every topic once, nothing extra (laps/stints: final versions)`, rs.every((r) => !r.missing && !r.dup && !r.unexpected), rs.filter((r) => r.missing || r.dup || r.unexpected).map((r) => `${r.topic} -${r.missing} x${r.dup} ?${r.unexpected}`).join(", "));
      check(`S3 ${run.name}: no gap between message dates beyond the source's own + 2 s`, rs.every((r) => r.gapExcess <= GAP_TOLERANCE_SIM), rs.filter((r) => r.gapExcess > GAP_TOLERANCE_SIM).map((r) => `${r.topic} +${(r.gapExcess / 1000).toFixed(1)} s`).join(", "));
    }
    const vaultMax = Math.max(0, ...totalLeaders.map((l) => l.maxSessions));
    check("S3: never more than 2 concurrent broker sessions (the broker's table; and each leader's own count)", final.max <= 2 && vaultMax <= 2, `broker max ${final.max}, leaders' max ${vaultMax}`);
    check("S3: the gap-fill REST stayed under OpenF1's rate limit (no 429)", final.rest429 === 0, `${final.rest429} 429s`);
    for (const [p, label] of [[B, "B"], [C, "C"]] as const) {
      const report = await h.findAppSecrets(p, [fakePass]);
      check(`S3 leak check, tab ${label}: no password or JWT readable from the app origin (heap ${((report.scanned["heap snapshot (app main frame)"] ?? 0) / 1e6).toFixed(1)} MB + storage)`, report.findings.length === 0 && (report.scanned["heap snapshot (app main frame)"] ?? 0) > 1e6, report.findings.map((f) => `${f.what} in ${f.where}`).join("; "));
    }
    check("S3: no page errors", pageErrors.length === 0, pageErrors.slice(0, 5).join(" | "));
  } catch (e) {
    check("S3 run", false, e instanceof Error ? (e.stack ?? e.message) : String(e));
  } finally {
    await ctx.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
    if (vault) h.stop(vault);
  }
}
