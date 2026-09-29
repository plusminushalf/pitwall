// Ingest every completed race and sprint of a season, one session at a time.
//
//   bun run ingest:season [year] [--force] [--quali]
//
// --quali also ingests qualifying, sprint qualifying and sprint shootout sessions.
//
// Skips cancelled and not-yet-run sessions, and already-ingested ones unless --force.
// Sessions run sequentially (the OpenF1 free-tier rate limit is per client), a failure
// doesn't stop the run, and a summary table is printed at the end.

import { statfs } from "node:fs/promises";
import { seasonSessions, type SeasonSession } from "./season";

// A race needs ~20 MB of gzipped raw cache + ~25 MB of output, but the raw JSON is held in
// memory and written in one go; stop well before the disk gets tight.
const MIN_FREE_BYTES = 1.5e9;

const args = process.argv.slice(2);
const force = args.includes("--force");
const quali = args.includes("--quali");
const year = Number(args.find((a) => !a.startsWith("--")) ?? new Date().getUTCFullYear());
if (!Number.isInteger(year)) {
  console.error("usage: bun run ingest:season [year] [--force] [--quali]");
  process.exit(1);
}

const all = await seasonSessions(year, { quali });
const todo = all.filter((s) => s.status === "pending" || (force && s.status === "ingested"));
console.log(`${year}: ${all.length} ${quali ? "race/sprint/qualifying" : "race/sprint"} sessions, ${todo.length} to ingest${force ? " (--force)" : ""}`);

interface Outcome {
  result: string;
  seconds?: number;
}
const outcomes = new Map<number, Outcome>();
for (const s of all) {
  if (!todo.includes(s)) outcomes.set(s.session.session_key, { result: `skipped: ${s.status === "ingested" ? "already ingested" : s.status}` });
}

async function freeBytes(): Promise<number> {
  const s = await statfs(".");
  return s.bavail * s.bsize;
}

/** Forward a child's output stream to ours while keeping a copy. */
async function tee(stream: ReadableStream<Uint8Array>, out: NodeJS.WriteStream): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of stream) {
    out.write(chunk);
    text += decoder.decode(chunk, { stream: true });
  }
  return text + decoder.decode();
}

/** The thrown error's message from Bun's uncaught-error output, else the last line printed. */
function failureReason(stderr: string, code: number): string {
  const error = stderr.match(/^(?:\w*Error|error): (.+)$/m)?.[1];
  const last = stderr.trim().split("\n").at(-1)?.trim();
  return (error ?? last ?? `exit code ${code}`).slice(0, 120);
}

/** Things in ingest's sanity summary worth a second look. */
function sanityNotes(stdout: string): string[] {
  const notes: string[] = [];
  const mismatches = stdout.match(/lap count mismatch/g)?.length ?? 0;
  if (mismatches) notes.push(`${mismatches} lap-count mismatch${mismatches > 1 ? "es" : ""}`);
  if (/\| chequered none \|/.test(stdout)) notes.push("no chequered flag");
  if (/circuit info unavailable/.test(stdout)) notes.push("no circuit info");
  const qualiProblems = stdout.match(/^ {2}<-- /gm)?.length ?? 0;
  if (qualiProblems) notes.push(`${qualiProblems} qualifying problem${qualiProblems > 1 ? "s" : ""}`);
  return notes;
}

const label = ({ session: s }: SeasonSession) =>
  `${s.session_key} ${s.date_start.slice(0, 10)} ${s.circuit_short_name} ${s.session_name}`;

for (const [i, s] of todo.entries()) {
  const key = s.session.session_key;
  const free = await freeBytes();
  if (free < MIN_FREE_BYTES) {
    console.error(`\nOnly ${(free / 1e9).toFixed(2)} GB free (< ${MIN_FREE_BYTES / 1e9} GB); stopping.`);
    for (const rest of todo.slice(i)) outcomes.set(rest.session.session_key, { result: "skipped: low disk space" });
    break;
  }

  console.log(`\n=== [${i + 1}/${todo.length}] ${label(s)} (${(free / 1e9).toFixed(1)} GB free) ===`);
  const started = performance.now();
  const proc = Bun.spawn([process.execPath, "scripts/ingest.ts", String(key)], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    tee(proc.stdout, process.stdout),
    tee(proc.stderr, process.stderr),
    proc.exited,
  ]);
  const seconds = (performance.now() - started) / 1000;
  const notes = code === 0 ? sanityNotes(stdout) : [];
  outcomes.set(key, {
    result: code === 0 ? ["ok", ...notes].join(", ") : `FAILED: ${failureReason(stderr, code)}`,
    seconds,
  });
}

console.log(`\n${year} season ingest summary\n`);
const nameWidth = Math.max(7, ...all.map((s) => s.session.session_name.length));
console.log(` key    date        circuit            ${"session".padEnd(nameWidth)}  time    result`);
for (const s of all) {
  const { session_key, date_start, circuit_short_name, session_name } = s.session;
  const o = outcomes.get(session_key)!;
  const time = o.seconds != null ? `${Math.floor(o.seconds / 60)}m${String(Math.round(o.seconds % 60)).padStart(2, "0")}s` : "";
  console.log(
    ` ${String(session_key).padEnd(6)} ${date_start.slice(0, 10)}  ${circuit_short_name.padEnd(17)}  ${session_name.padEnd(nameWidth)}  ${time.padEnd(6)}  ${o.result}`,
  );
}

const failed = [...outcomes.values()].filter((o) => o.result.startsWith("FAILED")).length;
const ok = [...outcomes.values()].filter((o) => o.result.startsWith("ok")).length;
console.log(`\n${ok} ingested, ${failed} failed, ${all.length - ok - failed} skipped`);
process.exit(failed ? 1 : 0);
