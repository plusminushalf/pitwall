// Build the circuit and driver history files (src/history/types.ts) from the latest F1DB release, into public/ so Vite
// serves them in dev and copies them into dist/ for the deploy. Run by CI before every deploy; the files are
// built, never committed.
//
//   bun run history [release]     e.g. `bun run history v2026.16.0`; the latest release by default
//
// The release's zip is checked against its published SHA-256 and kept in data/f1db/<release>/ (gitignored), so
// running it again for the same release doesn't download anything.

import { mkdir, rm } from "node:fs/promises";
import { F1DB_CIRCUIT } from "../src/history/circuits";
import { buildCircuitHistories, historySource } from "./lib/circuitHistory";
import { buildDriverHistories } from "./lib/driverHistory";
import { F1DB_FILES, type F1db } from "./lib/f1dbTypes";

const REPO = "https://github.com/f1db/f1db";
const ZIP = "f1db-json-splitted.zip";
const OUT = "public/history/circuits";
const DRIVERS_OUT = "public/history/drivers";

/** The latest release's tag, from where GitHub redirects /releases/latest (no API call, so no API rate limit). */
async function latestRelease(): Promise<string> {
  const res = await fetch(`${REPO}/releases/latest`, { redirect: "manual" });
  const tag = res.headers.get("location")?.match(/\/releases\/tag\/([^/?#]+)$/)?.[1];
  if (!tag) throw new Error(`no latest F1DB release (HTTP ${res.status})`);
  return decodeURIComponent(tag);
}

async function download(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

/** The release's zip, downloaded once and checked against the release's checksums. */
async function releaseZip(release: string): Promise<string> {
  const path = `data/f1db/${release}/${ZIP}`;
  if (await Bun.file(path).exists()) return path;
  const base = `${REPO}/releases/download/${release}`;
  const [zip, sums] = await Promise.all([download(`${base}/${ZIP}`), download(`${base}/checksums_sha256.txt`)]);
  const expected = new TextDecoder()
    .decode(sums)
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .find(([, file]) => file === ZIP)?.[0];
  const actual = new Bun.CryptoHasher("sha256").update(zip).digest("hex");
  if (!expected || expected !== actual) throw new Error(`${ZIP} of ${release}: SHA-256 ${actual}, release says ${expected ?? "nothing"}`);
  await Bun.write(path, zip);
  return path;
}

async function readTable(zip: string, file: string): Promise<unknown> {
  const proc = Bun.spawn(["unzip", "-p", zip, file], { stdout: "pipe", stderr: "pipe" });
  const [text, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`unzip ${file}: ${err.trim() || `exit ${code}`}`);
  return JSON.parse(text);
}

const release = process.argv[2] ?? (await latestRelease());
const zip = await releaseZip(release);
const entries = await Promise.all(Object.entries(F1DB_FILES).map(async ([table, file]) => [table, await readTable(zip, file)] as const));
const db = Object.fromEntries(entries) as unknown as F1db;

const source = historySource(release, new Date().toISOString());
const { histories, index } = buildCircuitHistories(db, source);
const drivers = buildDriverHistories(db, source);

// Every circuit the app can ask for must have a file: a missing one means F1DB renamed a circuit.
const built = new Set(histories.map((h) => h.circuit.id));
const missing = Object.entries(F1DB_CIRCUIT).filter(([, id]) => !built.has(id));
if (missing.length > 0) {
  throw new Error(`no F1DB history for ${missing.map(([key, id]) => `circuit_key ${key} (${id})`).join(", ")}: fix F1DB_CIRCUIT in src/history/circuits.ts`);
}

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
let bytes = 0;
for (const h of histories) bytes += await Bun.write(`${OUT}/${h.circuit.id}.json`, JSON.stringify(h));
bytes += await Bun.write(`${OUT}/index.json`, JSON.stringify(index));
console.log(`F1DB ${release}: ${histories.length} circuits, ${(bytes / 1024).toFixed(0)} KB in ${OUT}/`);

await rm(DRIVERS_OUT, { recursive: true, force: true });
await mkdir(DRIVERS_OUT, { recursive: true });
bytes = 0;
for (const h of drivers.histories) bytes += await Bun.write(`${DRIVERS_OUT}/${h.driver.id}.json`, JSON.stringify(h));
bytes += await Bun.write(`${DRIVERS_OUT}/index.json`, JSON.stringify(drivers.index));
const { year, throughRound } = drivers.index;
console.log(
  `F1DB ${release}: ${drivers.histories.length} drivers, ${drivers.index.drivers.length} in ${year} (through R${throughRound}), ${(bytes / 1024).toFixed(0)} KB in ${DRIVERS_OUT}/`,
);
