// The live session state is shared with the browser (src/live/store.ts). What only the relay does with it:
// write everything received to the raw cache when a session ends.

import { mkdir } from "node:fs/promises";
import { writeCache } from "../scripts/openf1";
import type { LiveStore, Rec } from "../src/live/store";

export * from "../src/live/store";

const ms = (iso: unknown) => (typeof iso === "string" ? Date.parse(iso) : NaN);

/**
 * Write everything `store` received to `dir` in the gzip cache layout scripts/ingest.ts reads, so
 * `bun run ingest <key>` works offline afterwards. Needs a store made with `keepRaw`. Returns the number of
 * files written.
 */
export async function writeRawCache(store: LiveStore, dir: string): Promise<number> {
  await mkdir(dir, { recursive: true });
  const strip = (records: Rec[]) => records.map(({ _id, _key, ...r }) => r);
  const byDate = (records: Rec[]) => {
    const sorted = [...records].sort((a, b) => ms(a.date) - ms(b.date));
    // Duplicate samples (backfill/MQTT overlap): keep the last of each timestamp.
    return sorted.filter((r, i) => i === sorted.length - 1 || ms(sorted[i + 1].date) !== ms(r.date));
  };
  const files: [string, unknown][] = [
    ["sessions", [store.session]],
    ["meeting", store.meeting ? [store.meeting] : []],
    ["drivers", store.list("drivers")],
    ["laps", store.list("laps")],
    ["stints", store.list("stints")],
    ["pit", store.list("pit")],
    ["position", store.list("position")],
    ["intervals", store.list("intervals")],
    ["race_control", store.list("race_control")],
    ["weather", store.list("weather")],
    ["team_radio", store.list("team_radio")],
    ["overtakes", store.list("overtakes")],
    ["session_result", store.list("session_result")],
  ];
  if (store.circuit) files.push(["circuit", store.circuit]);
  const numbers = new Set<number>([...store.list<{ driver_number: number }>("drivers").map((d) => d.driver_number)]);
  for (const n of numbers) {
    files.push([`car_data_${n}`, byDate(store.rawTelemetry("car_data", n))]);
    files.push([`location_${n}`, byDate(store.rawTelemetry("location", n))]);
  }
  for (const [name, data] of files) {
    await writeCache(`${dir}/${name}.json`, Array.isArray(data) ? strip(data as Rec[]) : data);
  }
  return files.length;
}
