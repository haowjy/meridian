/** Shared word-count semantics for draft review and durable change trails. */

import { cleanupSemantic, DIFF_DELETE, DIFF_INSERT, makeDiff } from "@sanity/diff-match-patch";

export type WordDelta = { wordsAdded: number; wordsRemoved: number };

export function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

/** Counts the actual inserted and deleted payloads between two captured texts. */
export function wordDeltaBetweenTexts(before: string, after: string): WordDelta {
  const diffs = makeDiff(before, after);
  cleanupSemantic(diffs);
  return diffs.reduce<WordDelta>(
    (total, [operation, text]) => ({
      wordsAdded: total.wordsAdded + (operation === DIFF_INSERT ? countWords(text) : 0),
      wordsRemoved: total.wordsRemoved + (operation === DIFF_DELETE ? countWords(text) : 0),
    }),
    { wordsAdded: 0, wordsRemoved: 0 },
  );
}
