/**
 * Pure, i18n-aware helpers for curated tool-result rows and bounded preview
 * text. Owns only display formatting.
 *
 * One parser reads every array-shaped tool payload. It stops at the payload's
 * cap, which is what lets a closed row ask "is there anything behind this
 * chevron?" without paying for the whole list, and it answers that question
 * with the same code that fills the expand, so the two can't disagree.
 *
 * Rows say what they *are* rather than carrying a string the renderer has to
 * sniff: a document's name is a door, a folder's name is not, and only the
 * parser knows which it just read.
 *
 * Snippets arrive as the model saw them, which for manuscript documents means
 * a leading block hash. Hashes are how the model addresses a block; they are
 * not words, and the writer never sees one. This is the seam where a tool
 * payload becomes a line of the writer's book.
 */
import { t } from "@lingui/core/macro";
import { stripBlockHash } from "@meridian/agent-edit";

import type { JsonValue } from "@meridian/contracts/protocol";

export type ToolResultRow =
  /** A document the tool found or listed. Its name opens it. */
  | { kind: "document"; uri: string; subtitle?: string; snippet?: string }
  /** A folder in a listing. Never a door: folders are not documents. */
  | { kind: "folder"; uri: string }
  /** A result with no context document behind it. */
  | { kind: "plain"; title: string; subtitle?: string; snippet?: string };

/**
 * Capped rows plus what they were cut from. `total` counts every entry the
 * tool returned, including ones too malformed to render: the writer is being
 * told the size of the payload, not the size of what we could parse.
 */
export type ToolResultRows = {
  rows: ToolResultRow[];
  total: number;
};

type RowSpec = {
  /** How many rows fit before the list has to report the rest as a count. */
  cap: number;
  toRow: (entry: Record<string, JsonValue>) => ToolResultRow | null;
};

/** Three lines each (name, location, passage), so fewer of them fit. */
const SEARCH_HITS: RowSpec = { cap: 4, toRow: searchHit };
/** One line each. */
const LISTING: RowSpec = { cap: 8, toRow: listingEntry };
const WEB_RESULTS: RowSpec = { cap: 4, toRow: webResult };

export function normalizeToolResultRows(output: JsonValue | undefined): ToolResultRows {
  if (Array.isArray(output)) return capped(output, arraySpec(output));
  if (!output || typeof output !== "object") return { rows: [], total: 0 };
  const obj = output as Record<string, JsonValue>;

  if (Array.isArray(obj.results)) return capped(obj.results, WEB_RESULTS);

  if (typeof obj.url === "string" || typeof obj.summary === "string") {
    return {
      rows: [
        {
          kind: "plain",
          title: (typeof obj.title === "string" && obj.title) || t`(fetched)`,
          subtitle: typeof obj.url === "string" ? obj.url : undefined,
          snippet:
            (typeof obj.summary === "string" && obj.summary) ||
            (typeof obj.excerpt === "string" ? obj.excerpt : undefined),
        },
      ],
      total: 1,
    };
  }

  return { rows: [], total: 0 };
}

/**
 * `grep` and `ls` both return a bare array; their entries are what tell them
 * apart. A search hit carries the passage it matched, a listing entry carries
 * what kind of thing it is.
 */
function arraySpec(entries: readonly JsonValue[]): RowSpec {
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    if (typeof entry.excerpt === "string") return SEARCH_HITS;
    if (entry.kind === "file" || entry.kind === "directory") return LISTING;
  }
  return SEARCH_HITS;
}

/** Takes rows until the cap is full, so a long payload is never fully walked. */
function capped(entries: readonly JsonValue[], spec: RowSpec): ToolResultRows {
  const rows: ToolResultRow[] = [];
  for (const entry of entries) {
    if (rows.length === spec.cap) break;
    if (!isRecord(entry)) continue;
    const row = spec.toRow(entry);
    if (row) rows.push(row);
  }
  return { rows, total: entries.length };
}

function isRecord(value: JsonValue): value is Record<string, JsonValue> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function searchHit(row: Record<string, JsonValue>): ToolResultRow | null {
  if (typeof row.uri !== "string" || typeof row.excerpt !== "string") return null;
  return {
    kind: "document",
    uri: row.uri,
    subtitle: typeof row.line === "number" ? t`Line ${row.line}` : undefined,
    snippet: stripBlockHash(row.excerpt),
  };
}

/**
 * An `ls` entry. `kind` picks the glyph and decides door versus plain text;
 * it routes nothing, because no folder route exists to route to.
 */
function listingEntry(row: Record<string, JsonValue>): ToolResultRow | null {
  if (typeof row.uri !== "string") return null;
  if (row.kind === "directory") return { kind: "folder", uri: row.uri };
  if (row.kind === "file") return { kind: "document", uri: row.uri };
  return null;
}

function webResult(row: Record<string, JsonValue>): ToolResultRow {
  return {
    kind: "plain",
    title: typeof row.title === "string" ? row.title : t`(untitled)`,
    subtitle:
      typeof row.url === "string"
        ? row.url
        : typeof row.source === "string"
          ? row.source
          : undefined,
    snippet:
      typeof row.snippet === "string"
        ? row.snippet
        : typeof row.note === "string"
          ? row.note
          : undefined,
  };
}

/** `4 of 42` — a fact about the payload, never an invitation to see more. */
export function resultBoundLabel({ rows, total }: ToolResultRows): string | null {
  if (total <= rows.length) return null;
  const shown = rows.length;
  return t`${shown} of ${total}`;
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}
