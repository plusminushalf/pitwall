import type { SessionType } from "../../src/types";

/**
 * Version of the processed output (meta.json, drivers/, laps/) that ingestCore, normalize, quali and practice
 * produce, per session type. Bump a type's whenever its output changes (new repairs as well as schema changes;
 * `meta.version` only tracks the schema): the app records it per stored session and offers to re-process sessions
 * stored with another version from their raw cache, with no network needed. Per type, so a change to one kind of
 * session doesn't ask for every other one to be updated too.
 *
 * Race 2: a stint for each pit stop OpenF1's stints miss (compound UNKNOWN, ageAtStart null).
 * Practice 2: lap traces of the laps at pace, and meta.practice's lapLength / sectorDistances / traced.
 */
export const FORMAT_VERSIONS: Readonly<Record<SessionType, number>> = { Race: 2, Qualifying: 1, Practice: 2 };

/** The format a session of this type is processed in today (entries without a type are races). */
export const formatVersion = (sessionType: SessionType | undefined): number => FORMAT_VERSIONS[sessionType ?? "Race"];

/** Whether a stored session was processed in today's format for its type (else it's offered an update). */
export const isCurrentFormat = (e: { format: number; sessionType?: SessionType }): boolean => e.format === formatVersion(e.sessionType);
