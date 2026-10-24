// OpenF1's times are UTC, but not every record says so: one without a zone ("2026-10-24T21:01:23.456000") would be
// read by Date.parse as local time, an hour or more off wherever the page isn't on UTC.

const ZONED = /(?:Z|[+-]\d\d:?\d\d)$/i

/** Absolute ms of an OpenF1 timestamp, as UTC when it has no zone. */
export const parseUtc = (iso: string): number =>
    Date.parse(iso.length > 10 && !ZONED.test(iso) ? `${iso}Z` : iso)
