/**
 * Version of the processed output (meta.json, drivers/, laps/) that ingestCore, normalize and quali produce.
 * Bump it whenever that output changes (new repairs as well as schema changes; `meta.version` only tracks
 * the schema): the app records it per stored session and offers to re-process sessions stored with another
 * version from their raw cache, with no network needed.
 */
export const FORMAT_VERSION = 1;
