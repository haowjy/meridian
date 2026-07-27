/**
 * Pure, i18n-aware helpers for curated tool-result rows and bounded preview
 * text. Owns only display formatting.
 *
 * Result lists are capped so one chatty search can't run the transcript, and
 * the cap is reported rather than hidden: the server returns the full list, so
 * the client always knows both numbers. A silently clipped list is the one
 * kind of truncation the writer can't detect, which makes it the one that has
 * to be stated.
 *
 * The parse stops at the cap, which is what lets a closed row ask "is there
 * anything behind this chevron?" without paying for the whole payload. One
 * parser answers that question and fills the expand, so the two can't disagree
 * about whether a row has contents.
 *
 * Snippets arrive as the model saw them, which for manuscript documents means
 * a leading block hash. Hashes are how the model addresses a block; they are
 * not words, and the writer never sees one. This is the seam where a search
 * result stops being a tool payload and becomes a line of the writer's book.
 */
import { t } from "@lingui/core/macro";
import { stripBlockHash } from "@meridian/agent-edit";

import type { JsonValue } from "@meridian/contracts/protocol";

/** How many result rows an expand shows before it reports the rest as a count. */
const RESULT_ROW_CAP = 4;

export type ToolResultRow = { title: string; subtitle?: string; snippet?: string };

/**
 * Capped rows plus what they were cut from. `total` counts every result the
 * tool returned, including entries too malformed to render — the writer is
 * being told the size of the payload, not the size of what we could parse.
 */
export type ToolResultRows = {
  rows: ToolResultRow[];
  total: number;
};

export function normalizeToolResultRows(output: JsonValue | undefined): ToolResultRows {
  if (Array.isArray(output)) return capped(output, searchHit);
  if (!output || typeof output !== "object") return { rows: [], total: 0 };
  const obj = output as Record<string, JsonValue>;

  if (Array.isArray(obj.results)) return capped(obj.results, webResult);

  if (typeof obj.url === "string" || typeof obj.summary === "string") {
    return {
      rows: [
        {
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

/** Takes rows until the cap is full, so a long payload is never fully walked. */
function capped(
  entries: readonly JsonValue[],
  toRow: (entry: Record<string, JsonValue>) => ToolResultRow | null,
): ToolResultRows {
  const rows: ToolResultRow[] = [];
  for (const entry of entries) {
    if (rows.length === RESULT_ROW_CAP) break;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const row = toRow(entry as Record<string, JsonValue>);
    if (row) rows.push(row);
  }
  return { rows, total: entries.length };
}

function searchHit(row: Record<string, JsonValue>): ToolResultRow | null {
  if (typeof row.uri !== "string" || typeof row.excerpt !== "string") return null;
  return {
    title: row.uri,
    subtitle: typeof row.line === "number" ? t`Line ${row.line}` : undefined,
    snippet: stripBlockHash(row.excerpt),
  };
}

function webResult(row: Record<string, JsonValue>): ToolResultRow {
  return {
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

/** `5 of 42` — a fact about the payload, never an invitation to see more. */
export function resultBoundLabel({ rows, total }: ToolResultRows): string | null {
  if (total <= rows.length) return null;
  const shown = rows.length;
  return t`${shown} of ${total}`;
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}
