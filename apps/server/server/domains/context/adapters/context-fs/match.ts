/**
 * Per-document search matching: which passage a query first hit, how to navigate
 * back to it, and how often the document holds it. Shared by the in-memory and
 * drizzle context stores so both report search hits identically.
 *
 * The unit of the scan is a **block**, not a text line. Manuscript documents
 * arrive as hashlines (`hash|body`), where one entry is one block and a
 * multi-line block carries its own newlines; every other scheme arrives as
 * plain markdown lines, where the two coincide. Scanning per entry is what
 * lets a hit carry the block hash the writer's editor navigates to, and it
 * keeps the query away from the hash itself — a hash is hex, and hex spells
 * words often enough to over-report a count.
 */
import { splitHashline } from "@meridian/agent-edit";

/** What one document contributed to a search. */
export interface DocumentMatch {
  /** The exact serialized text of the first matching entry. */
  excerpt: string;
  /** 1-based line number where that entry starts. */
  line: number;
  /**
   * Hash of the matched block. Absent for schemes whose documents carry no
   * hashlines — that absence is the contract, not a failure to parse.
   */
  blockHash?: string;
  /** Occurrences of the query across the whole document. At least 1. */
  matchCount: number;
}

/**
 * Find the first entry of `entries` containing `query` (case-insensitive) and
 * count every occurrence in the document. Returns null when nothing matches.
 */
export function matchDocument(
  entries: readonly string[],
  query: string,
  options: { hashlines: boolean },
): DocumentMatch | null {
  const needle = query.toLowerCase();
  if (needle.length === 0) return null;

  let first: Omit<DocumentMatch, "matchCount"> | null = null;
  let matchCount = 0;
  let line = 1;
  for (const entry of entries) {
    const parsed = options.hashlines ? splitHashline(entry) : null;
    const body = parsed?.body ?? entry;
    const occurrences = countOccurrences(body, needle);
    if (occurrences > 0 && !first) {
      first = { excerpt: entry, line, ...(parsed?.hash ? { blockHash: parsed.hash } : {}) };
    }
    matchCount += occurrences;
    line += entry.split("\n").length;
  }
  return first ? { ...first, matchCount } : null;
}

/** Non-overlapping occurrences of an already-lowercased needle. */
function countOccurrences(text: string, needle: string): number {
  const haystack = text.toLowerCase();
  let count = 0;
  let from = 0;
  for (;;) {
    const index = haystack.indexOf(needle, from);
    if (index < 0) return count;
    count += 1;
    from = index + needle.length;
  }
}
