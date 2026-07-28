/**
 * Where a searched passage is in the document *now* — the honest half of a
 * search-match door.
 *
 * A search result names a block and the term that matched it. Between the
 * search and the click the writer may have edited, moved or deleted that
 * block, so arriving means re-deciding, against live text, whether the promise
 * can still be kept. Three outcomes, and no fourth: the passage is where it
 * said, the passage is somewhere unambiguous, or we say it changed. Landing on
 * a nearby-but-wrong paragraph is the failure this module exists to refuse.
 *
 * Pure over a ProseMirror document: no editor, no Yjs, no timing.
 */
import type { Node as PMNode } from "@tiptap/pm/model";

export type TextRange = { from: number; to: number };

export type PassageResolution =
  /** The block still holds the term. Its occurrences there are the landing. */
  | { kind: "block"; ranges: TextRange[] }
  /** The block is gone or has changed, but the term occurs exactly once. */
  | { kind: "refound"; ranges: TextRange[] }
  /** Nowhere, or several equally plausible somewheres. Say so instead of guessing. */
  | { kind: "stale" };

/**
 * Resolve a searched passage against live text. `block` is the span the block
 * hash resolved to, or null when the hash no longer names a live block.
 */
export function resolvePassage(
  doc: PMNode,
  block: TextRange | null,
  term: string,
): PassageResolution {
  if (term.length === 0) return { kind: "stale" };
  if (block) {
    const inside = findTerm(doc, term, block);
    if (inside.length > 0) return { kind: "block", ranges: inside };
  }
  // Outline's resilience without its "first duplicate wins": one occurrence is
  // an answer, several are a coin flip about the writer's own prose.
  const everywhere = findTerm(doc, term, { from: 0, to: doc.content.size });
  return everywhere.length === 1 ? { kind: "refound", ranges: everywhere } : { kind: "stale" };
}

/**
 * Every occurrence of `term` inside `range`, case-insensitively — the casing
 * the search itself matched with.
 */
export function findTerm(doc: PMNode, term: string, range: TextRange): TextRange[] {
  const needle = term.toLowerCase();
  if (needle.length === 0) return [];
  const found: TextRange[] = [];
  const from = Math.max(0, range.from);
  const to = Math.min(doc.content.size, range.to);
  if (from >= to) return found;

  doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isTextblock) return true;
    const { text, positions } = linearText(node, pos + 1);
    const haystack = text.toLowerCase();
    let index = haystack.indexOf(needle);
    while (index >= 0) {
      const start = positions[index];
      const end = positions[index + needle.length - 1] + 1;
      if (start >= from && end <= to) found.push({ from: start, to: end });
      index = haystack.indexOf(needle, index + needle.length);
    }
    // A textblock's inline content is already flattened above.
    return false;
  });
  return found;
}

/**
 * A textblock's text with a document position per character. Built by walking
 * inline children rather than reading `textContent`, because marks split text
 * into several nodes and inline leaves (an image, a figure) occupy positions
 * while contributing no characters — either drift would land the highlight on
 * the wrong words.
 */
function linearText(block: PMNode, start: number): { text: string; positions: number[] } {
  let text = "";
  const positions: number[] = [];
  let offset = 0;
  block.forEach((child) => {
    if (child.isText && child.text) {
      for (let index = 0; index < child.text.length; index += 1) {
        positions.push(start + offset + index);
      }
      text += child.text;
    }
    offset += child.nodeSize;
  });
  return { text, positions };
}
