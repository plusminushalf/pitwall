// List race and sprint sessions for a season, with their session keys for ingest.
//
//   bun run races [year] [--quali] [--practice]   (qualifying and sprint qualifying, free practice sessions too)

import { seasonSessions } from "./season";

const args = process.argv.slice(2);
const quali = args.includes("--quali");
const practice = args.includes("--practice");
const year = Number(args.find((a) => !a.startsWith("--")) ?? new Date().getUTCFullYear());
const sessions = await seasonSessions(year, { quali, practice });
const width = Math.max(7, ...sessions.map((s) => s.session.session_name.length));

const kinds = ["race", quali && "qualifying", practice && "practice"].filter(Boolean).join(", ");
console.log(`${year}: ${sessions.length} ${kinds} sessions\n`);
console.log(` key    date        ${"session".padEnd(width)}  circuit`);
for (const { session: s, status } of sessions) {
  const note = status === "pending" ? "" : status;
  console.log(
    ` ${String(s.session_key).padEnd(6)} ${s.date_start.slice(0, 10)}  ${s.session_name.padEnd(width)}  ${s.circuit_short_name.padEnd(16)} ${note}`,
  );
}
