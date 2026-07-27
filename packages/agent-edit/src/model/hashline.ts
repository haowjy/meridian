/**
 * hashline — the `hash|body` serialization the agent reads and addresses blocks
 * by, and its inverse.
 *
 * The prefix exists for the model: it is how a write command names the block it
 * means. It is not writer-facing vocabulary, so any surface that shows a line to
 * a human strips it first. Keeping both directions in one module is what makes
 * that strip provably the inverse of the write.
 */
import { DEFAULT_HASH_LENGTH, fullHashForItemId } from "./block-hash.js";

/**
 * Serialize one block for the agent. A multi-line body starts on its own line
 * so the prefix never runs into prose.
 */
export function toHashline(hash: string, body: string): string {
  return body.includes("\n") ? `${hash}|\n${body}` : `${hash}|${body}`;
}

/**
 * Longest a display hash can be: {@link fullHashForItemId} concatenates a
 * 64-bit FNV digest with two fixed-width hex fields, and a display hash is a
 * prefix of that.
 */
const MAX_HASH_LENGTH = fullHashForItemId({ clientID: 0, clock: 0 }).length;

/**
 * Anchored because a hash only ever leads a line, and length-bounded to the
 * real hash range because the alternative — splitting at the first `|` — eats
 * the leading cell of a markdown table row and the first clause of any prose
 * line that happens to contain a pipe. Lines that are not hashlines reach here
 * routinely: `grep` excerpts come back as raw markdown for every scheme that
 * has no branch shadow to read hashlines from.
 */
const HASH_PREFIX = new RegExp(`^[0-9a-f]{${DEFAULT_HASH_LENGTH},${MAX_HASH_LENGTH}}\\|`);

/** The writer-facing body of a line that may or may not carry a block hash. */
export function stripBlockHash(line: string): string {
  return line.replace(HASH_PREFIX, "");
}
