export type DigestStatus = 'ok' | 'retry' | 'fail';

/** Counts of valid events, not jobs or final job statuses. */
export type DigestCounts = Record<DigestStatus, number>;

/** One job, aggregated in event-time order (file line order breaks equal-time ties). */
export type DigestRow = {
  job: string;
  /** Latest event's owner, including an explicit null; never carry an older owner forward. */
  owner: string | null;
  /** All valid events for this job, including retry and fail events. */
  runs: number;
  /** Number of retry events, not runs minus one. */
  retries: number;
  /** Number of fail events; mark any failures even when lastStatus is ok. */
  failures: number;
  lastStatus: DigestStatus;
  /** Latest supplied error string in event-time order; later error-free events do not clear it. */
  lastError: string | null;
  /** Earliest/latest event's original at string, preserving its offset (no UTC conversion). */
  firstAt: string;
  lastAt: string;
};

export type NightDigest = {
  /** One row per exact job string, ascending by JS string comparison (< / >), not locale. */
  rows: DigestRow[];
  /** Nonblank lines rejected for invalid JSON or event schema, counted once each. */
  badLines: number;
  /** Every valid event contributes to exactly one status; sum(counts) = sum(row.runs). */
  counts: DigestCounts;
};

/**
 * Synchronous named export readNight from src/digest/read-night.ts; callers use
 * import { readNight } from './digest/read-night.js'. This file supplies types only.
 *
 * Read runsDir/<night>.jsonl. Accept only /^\d{4}-\d{2}-\d{2}$/ night identifiers,
 * with no calendar normalization. Reject every other input with null before any
 * filesystem access; never resolve a caller-supplied path outside runsDir.
 * A missing file (ENOENT) returns null; other I/O errors propagate.
 * Empty/whitespace-only files return rows: [], badLines: 0 and all counts zero.
 * Blank lines, including a trailing newline, are ignored. Invalid lines add one
 * badLines and contribute nothing to rows or counts; an all-bad file is not missing.
 *
 * A valid event is a JSON object with at (a valid RFC 3339 timestamp with Z or an
 * explicit offset), job (a nonblank string), status (DigestStatus), and owner
 * (string or null). error is optional but must be a string when present; unknown
 * fields are ignored. Preserve string values, including timestamp offsets.
 *
 * Compare timestamps by instant, not their spelling. Out-of-order events still
 * contribute to counts; firstAt/lastAt are chronological endpoints. For equal
 * instants, the earlier file line is first and the later line is last. owner and
 * lastStatus come from that last event. lastError is the most recent event's
 * supplied error (including an empty string), or null when no event supplied one.
 */
export type ReadNight = (runsDir: string, night: string) => NightDigest | null;
