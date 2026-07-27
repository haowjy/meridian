/**
 * tool-command — reads a `ToolView` and answers the two questions the activity
 * timeline asks about every row: *which command is this?* and *what do we call
 * it?*
 *
 * The writer cares about the command, not the tool that carried it: `write`
 * covers reading, creating, editing, reverting and reviewing, and those are
 * five different things to someone watching their manuscript. Classifying once
 * here means the glyph, the chip tone, the visible verb and the announced verb
 * all derive from one decision and cannot drift apart.
 */
import { t } from "@lingui/core/macro";
import type { JsonValue } from "@meridian/contracts/protocol";
import { folderDisplayName } from "./document-display-name";
import type { ToolView } from "./group-delivery-segments";

export type WriteMode = "direct" | "draft";

/**
 * What the agent did, in the writer's terms. `skim` and `read` are one tool
 * argument apart (`format: "outline"`) but a different claim about the book: a
 * skim saw headings, a read saw prose.
 */
export type ToolCommand =
  | "read"
  | "skim"
  | "create"
  | "edit"
  | "undo"
  | "redo"
  | "review"
  | "search"
  | "list"
  | "invoke"
  | "unknown";

export function toolCommand(tool: ToolView): ToolCommand {
  switch (tool.toolName) {
    case "write":
      return writeCommand(toolInputObject(tool));
    case "grep":
      return "search";
    case "ls":
      return "list";
    case "invoke":
      return "invoke";
    default:
      return "unknown";
  }
}

function writeCommand(input: Record<string, JsonValue>): ToolCommand {
  switch (stringInput(input, "command")) {
    case "read":
      return stringInput(input, "format") === "outline" ? "skim" : "read";
    case "create":
      return "create";
    case "insert":
    case "replace":
      return "edit";
    case "undo":
      return "undo";
    case "redo":
      return "redo";
    case "diff":
      return "review";
    default:
      return "unknown";
  }
}

/**
 * Whether the command changed the writer's document. Drives the primary chip:
 * one pre-attentive signal separating *looked at* from *touched*.
 *
 * A draft is a proposal awaiting review, so it has mutated nothing — the draft
 * dock carries that signal instead. A failed command changed nothing either,
 * whatever it intended.
 */
export function isMutatingCommand(
  command: ToolCommand,
  { writeMode = "direct", failed = false }: { writeMode?: WriteMode; failed?: boolean } = {},
): boolean {
  if (failed || writeMode === "draft") return false;
  return command === "create" || command === "edit" || command === "undo" || command === "redo";
}

/**
 * A row title split the way the timeline renders it: the command leads at full
 * ink, and what it acted on follows, quieter. `parameter` is absent when the
 * phrase names nothing the writer would read as a separate thing.
 */
export type ToolActivityPhrase = {
  verb: string;
  /**
   * Carries its own trailing ellipsis while in flight, because the ellipsis
   * belongs at the end of the whole phrase rather than after the verb.
   */
  parameter?: string;
};

/** Both tenses of one row's phrase. Tense is protocol state, never timing. */
export type ToolActivityVocabulary = {
  /** Awaiting `tool_response`. */
  active: ToolActivityPhrase;
  /** Result in hand. */
  complete: ToolActivityPhrase;
};

export function toolActivityVocabulary(
  tool: ToolView,
  writeMode: WriteMode = "direct",
): ToolActivityVocabulary | null {
  const input = toolInputObject(tool);

  switch (toolCommand(tool)) {
    case "read":
      return { active: { verb: t`Reading…` }, complete: { verb: t`Read` } };
    // An outline read returns heading structure, not prose. A row saying "Read"
    // over that payload claims the model saw the words.
    case "skim":
      return { active: { verb: t`Skimming…` }, complete: { verb: t`Skimmed` } };
    case "create":
      return writeMode === "draft"
        ? { active: { verb: t`Drafting…` }, complete: { verb: t`Drafted` } }
        : { active: { verb: t`Writing…` }, complete: { verb: t`Wrote` } };
    case "edit":
      return writeMode === "draft"
        ? { active: { verb: t`Drafting…` }, complete: { verb: t`Drafted` } }
        : { active: { verb: t`Editing…` }, complete: { verb: t`Edited` } };
    // Reverting a change is not editing. Telling a writer their chapter was
    // edited when it was put back is the same over-claim as calling a skim a
    // read — and it holds in draft mode too.
    case "undo":
      return { active: { verb: t`Undoing…` }, complete: { verb: t`Undid` } };
    case "redo":
      return { active: { verb: t`Redoing…` }, complete: { verb: t`Redid` } };
    case "review":
      return {
        active: { verb: t`Checking recent changes…` },
        complete: { verb: t`Checked recent changes` },
      };
    case "search": {
      const pattern = stringInput(input, "pattern");
      if (!pattern) {
        return { active: { verb: t`Searching…` }, complete: { verb: t`Searched context` } };
      }
      const quoted = `“${truncatePattern(pattern)}”`;
      return {
        active: { verb: t`Searching`, parameter: `${quoted}…` },
        complete: { verb: t`Searched`, parameter: quoted },
      };
    }
    case "list": {
      const path = stringInput(input, "path");
      if (!path) {
        return { active: { verb: t`Exploring folders…` }, complete: { verb: t`Explored folders` } };
      }
      const folder = folderDisplayName(path);
      return {
        active: { verb: t`Exploring`, parameter: `${folder}…` },
        complete: { verb: t`Explored`, parameter: folder },
      };
    }
    case "invoke": {
      const slug = stringInput(input, "skillname");
      if (!slug) {
        return { active: { verb: t`Invoking a skill…` }, complete: { verb: t`Invoked a skill` } };
      }
      const skill = humanizeSkillSlug(slug);
      return {
        active: { verb: t`Invoking the ${skill} skill…` },
        complete: { verb: t`Invoked the ${skill} skill` },
      };
    }
    default:
      return null;
  }
}

/** Flattens a phrase for the screen reader, which hears no typography. */
export function toolActivityAnnouncement(phrase: ToolActivityPhrase): string {
  return phrase.parameter ? `${phrase.verb} ${phrase.parameter}` : phrase.verb;
}

/** Search patterns are the model's words; a long one must not run the row. */
function truncatePattern(pattern: string): string {
  return pattern.length <= 60 ? pattern : `${pattern.slice(0, 59).trimEnd()}…`;
}

export function toolInputObject(tool: ToolView): Record<string, JsonValue> {
  const raw = tool.input;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, JsonValue>;
  }
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as JsonValue;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, JsonValue>;
      }
    } catch {
      return {};
    }
  }
  return {};
}

export function stringInput(input: Record<string, JsonValue>, field: string): string | undefined {
  const value = input[field];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function humanizeSkillSlug(slug: string): string {
  return slug
    .split(/[-_]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}
