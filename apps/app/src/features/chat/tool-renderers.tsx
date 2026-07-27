/**
 * tool-renderers — the per-tool presentation registry that drives the activity
 * timeline's tier-2 rows.
 *
 * Each registered tool contributes: an icon, a single-line title that reads
 * the tool's input (e.g. `Read Chapter 1`, `Searched "dragon"`, `Invoked the Outline skill`),
 * an optional inline expansion (curated — search result rows, stream tail, or
 * skill output).
 *
 * Three-tier contract documented in `.context/CONTEXT.md`:
 *   - **Tier 1 (default fallback)** — unknown tool. Static one-line row
 *     showing the humanized tool name only. No expand or interaction.
 *   - **Tier 2 (registered)** — the entries in this file. Per-tool one-liner
 *     plus optional curated expansion.
 *   - **Tier 3 (generative)** — model-authored React. Not implemented here.
 *
 * Titles never derive their own tense: both forms come from `tool-command`, so
 * the visible row and the screen-reader announcement cannot disagree.
 *
 * Hard rule: **never expose raw JSON in default UX**. Renderers produce
 * curated content (titles, result rows, terminal tail) only. If we need raw
 * JSON for debugging, it goes behind a dev-only setting — not into chat.
 */
import { t } from "@lingui/core/macro";
import {
  type JsonValue,
  meridianErrorFromStructuredToolOutput,
} from "@meridian/contracts/protocol";
import { FilePen, FolderTree, type LucideIcon, Search, Sparkles, Wrench } from "lucide-react";
import type { ReactNode } from "react";
import { documentDisplayName, isContextUri } from "./document-display-name";
import type { ToolView } from "./group-delivery-segments";
import {
  humanizeSkillSlug,
  type ToolActivityPhrase,
  toolActivityVocabulary,
  toolCommand,
  toolInputObject,
  type WriteMode,
} from "./tool-command";
import { normalizeToolResultRows, truncate } from "./tool-result-preview";

export type ToolRenderContext = {
  writeMode?: WriteMode;
};

export type ToolRenderer = {
  Icon: LucideIcon;
  /** Single-line summary of the tool action. Already i18n'd. */
  title: (tool: ToolView, context?: ToolRenderContext) => ReactNode;
  /** Inline expansion content. `null` = no expand affordance on this row. */
  expand?: (tool: ToolView) => ReactNode | null;
};

/* ── input helpers ─────────────────────────────────────────────────────── */

function inputObject(tool: ToolView): Record<string, JsonValue> {
  return toolInputObject(tool);
}

function asString(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** The phrase for the tool's current protocol state — never guessed from timing. */
function activityPhrase(tool: ToolView, writeMode?: WriteMode): ToolActivityPhrase | null {
  const vocabulary = toolActivityVocabulary(tool, writeMode);
  if (!vocabulary) return null;
  return tool.status === "complete" ? vocabulary.complete : vocabulary.active;
}

export function DocumentName({ path }: { path: string }) {
  const displayName = documentDisplayName(path);
  return (
    <span className="flex min-w-0 items-baseline gap-1.5">
      <span className="min-w-0 truncate">{displayName.title}</span>
      {displayName.qualifier ? (
        <span className="shrink-0 text-ink-subtle">({displayName.qualifier})</span>
      ) : null}
    </span>
  );
}

/** A command and what it acted on, laid out as one line. */
function CommandTitle({ verb, parameter }: { verb: ReactNode; parameter?: ReactNode }) {
  return (
    <span className="flex w-full min-w-0 items-baseline gap-1.5">
      <span className="shrink-0">{verb}</span>
      {parameter ? <span className="flex min-w-0 items-baseline">{parameter}</span> : null}
    </span>
  );
}

/** A parameter the timeline shows as text rather than as a destination. */
function TextParameter({ children }: { children: ReactNode }) {
  return <span className="min-w-0 truncate">{children}</span>;
}

function PhraseTitle({ phrase }: { phrase: ToolActivityPhrase }) {
  return (
    <CommandTitle
      verb={phrase.verb}
      parameter={phrase.parameter ? <TextParameter>{phrase.parameter}</TextParameter> : undefined}
    />
  );
}

/* ── inline-expand renderers (curated, never JSON) ─────────────────────── */

function ResultRows({ rows }: { rows: ReturnType<typeof normalizeToolResultRows> }) {
  return (
    <ul className="space-y-2">
      {rows.map((row) => (
        <li key={`${row.title}|${row.subtitle ?? ""}|${row.snippet ?? ""}`} className="space-y-0.5">
          <div className="text-compact font-medium text-prose-foreground">
            {isContextUri(row.title) ? <DocumentName path={row.title} /> : row.title}
          </div>
          {row.subtitle ? (
            <div className="truncate font-mono text-meta text-muted-foreground">{row.subtitle}</div>
          ) : null}
          {row.snippet ? (
            <div className="text-xs leading-relaxed text-ink-muted">{row.snippet}</div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/**
 * Terminal-style tail for stream-producing tools. Renders as
 * dimmed mono text — no card chrome, just the recent output. Keeps the last
 * ~14 lines so a chatty command can't unbalance the row.
 */
function StreamTail({ stream }: { stream: string }) {
  const lines = stream.split("\n");
  const visible = lines.length > 14 ? lines.slice(-14).join("\n") : stream;
  return (
    // Bounded, NON-scrolling teaser: the transcript viewport is the single scroll
    // owner, so this row must never own a nested scrollport. Slicing to 14 logical
    // lines does not bound *visual* height — one long line soft-wraps to many rows
    // in the narrow docked layout — so cap the box and clip. `justify-end` keeps the
    // newest output pinned to the bottom (older lines clip off the top under a fade).
    <div className="flex max-h-48 flex-col justify-end overflow-hidden [mask-image:linear-gradient(to_bottom,transparent,black_1.5rem)]">
      <pre
        className="font-mono text-meta leading-relaxed break-words whitespace-pre-wrap text-ink-muted"
        aria-live="polite"
      >
        {visible}
      </pre>
    </div>
  );
}

function PlainOutput({ value }: { value: string }) {
  return (
    <div className="text-compact whitespace-pre-wrap text-ink-muted">{truncate(value, 800)}</div>
  );
}

function invokeSkillSlug(tool: ToolView): string | undefined {
  return asString(inputObject(tool).skillname);
}

/**
 * Classify server-side invoke gate failures. Matches the two strings emitted
 * by `skill-tools.ts` — kept separate from i18n so unit tests can lock the
 * contract without a Lingui compile context.
 */
export type InvokeSkillFailureKind = "unknown" | "no-longer-available";

export function classifyInvokeSkillFailure(output: string): InvokeSkillFailureKind | null {
  if (output.startsWith('Unknown skill "')) return "unknown";
  if (/^Skill "[^"]+" is no longer available\./.test(output)) return "no-longer-available";
  return null;
}

/**
 * Map server-side invoke gate failures to reader-facing copy. The dispatcher
 * emits machine strings with slug + available-skills suffix; chat never shows
 * those verbatim — only the two freeze-contract messages below.
 */
export function invokeSkillFailureCopy(
  output: JsonValue | null,
  slug: string | undefined,
): string | null {
  if (typeof output !== "string" || output.length === 0) return null;
  const kind = classifyInvokeSkillFailure(output);
  if (kind === "unknown") {
    const skillName = slug ? humanizeSkillSlug(slug) : undefined;
    return skillName
      ? t`The ${skillName} skill isn't available in this chat.`
      : t`That skill isn't available in this chat.`;
  }
  if (kind === "no-longer-available") {
    const skillName = slug ? humanizeSkillSlug(slug) : undefined;
    return skillName
      ? t`The ${skillName} skill is no longer available in this chat — start a new chat to use the current version.`
      : t`This skill is no longer available in this chat — start a new chat to use the current version.`;
  }
  return null;
}

function writeFailureStatus(output: JsonValue | null): string | null {
  if (output == null) return null;
  if (typeof output === "object" && !Array.isArray(output)) {
    const status = asString((output as Record<string, JsonValue>).status);
    if (status) return status;
  }
  const message =
    typeof output === "string" ? output : meridianErrorFromStructuredToolOutput(output).message;
  return /^status:\s*([a-z_]+)/i.exec(message.trim())?.[1]?.toLowerCase() ?? null;
}

function writeFailureDocumentName(tool: ToolView): string | null {
  const path = asString(inputObject(tool).path);
  if (!path) return null;
  const { title, qualifier } = documentDisplayName(path);
  return qualifier ? `${title} (${qualifier})` : title;
}

/** Writer copy is derived from failure shape; machine messages remain diagnostics only. */
export function writeToolFailureCopy(tool: ToolView): string {
  const name = writeFailureDocumentName(tool);
  switch (writeFailureStatus(tool.output)) {
    case "not_found":
    case "document_not_found":
      return name ? t`Couldn't find ${name}.` : t`That document couldn't be found.`;
    case "ambiguous_match":
      return name
        ? t`The requested passage in ${name} wasn't specific enough.`
        : t`The requested passage wasn't specific enough.`;
    case "cant_undo_dependent":
      return t`That change can't be undone because later edits depend on it.`;
    case "partial_failure":
      return name
        ? t`Some changes to ${name} couldn't be completed.`
        : t`Some changes couldn't be completed.`;
    case "invalid_write":
      return name ? t`That change couldn't be made in ${name}.` : t`That change couldn't be made.`;
    default:
      return name
        ? t`Something went wrong while changing ${name}.`
        : t`Something went wrong while making that change.`;
  }
}

/**
 * What a failed command is called. A failure is its own claim — "Read
 * chapter-3" over an error is as wrong as any other over-claim — so it never
 * reuses the success verb.
 */
function writeFailureVerb(tool: ToolView, writeMode: WriteMode | undefined): string {
  switch (toolCommand(tool)) {
    case "read":
    case "skim":
      return t`Couldn't read`;
    case "undo":
      return t`Couldn't undo`;
    case "redo":
      return t`Couldn't redo`;
    case "review":
      return t`Couldn't check recent changes`;
    case "edit":
      return writeMode === "draft" ? t`Couldn't draft` : t`Couldn't edit`;
    default:
      return writeMode === "draft" ? t`Couldn't draft` : t`Couldn't write`;
  }
}

/** The verb with no document to attach it to — `Wrote` alone reads as a fragment. */
function pathlessWriteTitle(phrase: ToolActivityPhrase, tool: ToolView): ReactNode {
  switch (toolCommand(tool)) {
    case "read":
    case "skim":
      return t`Read file`;
    case "create":
      return t`Wrote file`;
    case "edit":
      return t`Edited file`;
    default:
      return <PhraseTitle phrase={phrase} />;
  }
}

function WriteToolTitle({ tool, context }: { tool: ToolView; context?: ToolRenderContext }) {
  const path = asString(inputObject(tool).path);
  if (tool.isError) {
    const verb = writeFailureVerb(tool, context?.writeMode);
    return path ? <CommandTitle verb={verb} parameter={<DocumentName path={path} />} /> : verb;
  }

  const phrase = activityPhrase(tool, context?.writeMode);
  if (!phrase) return path ? <DocumentName path={path} /> : humanizeToolName(tool.toolName);
  // A partial call has no settled path yet, so the row names no document —
  // and therefore offers no door onto one.
  if (tool.status !== "complete") return <PhraseTitle phrase={phrase} />;
  if (!path) return pathlessWriteTitle(phrase, tool);
  return <CommandTitle verb={phrase.verb} parameter={<DocumentName path={path} />} />;
}

function writeExpand(tool: ToolView): ReactNode | null {
  if (!tool.isError) return null;
  return <div className="text-compact text-destructive">{writeToolFailureCopy(tool)}</div>;
}

function invokeExpand(tool: ToolView): ReactNode | null {
  if (tool.isError) {
    const copy = invokeSkillFailureCopy(tool.output, invokeSkillSlug(tool));
    if (!copy) return null;
    return <div className="text-compact text-destructive">{copy}</div>;
  }
  return streamOrOutput(tool);
}

function streamOrOutput(tool: ToolView): ReactNode | null {
  // While running: live tail keeps the freshest output visible. Once complete,
  // prefer the curated final `output` field (e.g. "exit 0", a summary line) —
  // the raw stream transcript is noise next to a tight terminal summary.
  if (tool.status === "complete" && typeof tool.output === "string" && tool.output.length > 0) {
    return <PlainOutput value={tool.output} />;
  }
  if (tool.streamedOutput && tool.streamedOutput.length > 0) {
    return <StreamTail stream={tool.streamedOutput} />;
  }
  if (typeof tool.output === "string" && tool.output.length > 0) {
    return <StreamTail stream={tool.output} />;
  }
  return null;
}

function resultRowsOrNothing(tool: ToolView): ReactNode | null {
  const rows = normalizeToolResultRows(tool.output ?? undefined);
  if (rows.length === 0) return null;
  return <ResultRows rows={rows} />;
}

/* ── registry ──────────────────────────────────────────────────────────── */

function humanizeToolName(toolName: string): string {
  const words = toolName.replaceAll("_", " ");
  return words.length > 0 ? words[0].toUpperCase() + words.slice(1) : words;
}

/** A registered tool whose whole title is its phrase, with no document to name. */
function phraseTitle(tool: ToolView): ReactNode {
  const phrase = activityPhrase(tool);
  return phrase ? <PhraseTitle phrase={phrase} /> : humanizeToolName(tool.toolName);
}

/**
 * Tier-1 default — unknown tool. Static one-liner; no expand affordance,
 * no destination. Arguments are developer detail and never enter the title.
 */
const DEFAULT_RENDERER: ToolRenderer = {
  Icon: Wrench,
  title: (tool) => humanizeToolName(tool.toolName),
};

const RENDERERS: Record<string, ToolRenderer> = {
  write: {
    Icon: FilePen,
    title: (tool, context) => <WriteToolTitle tool={tool} context={context} />,
    expand: writeExpand,
  },
  ls: {
    Icon: FolderTree,
    title: phraseTitle,
  },
  grep: {
    Icon: Search,
    title: phraseTitle,
    expand: resultRowsOrNothing,
  },
  invoke: {
    Icon: Sparkles,
    title: phraseTitle,
    expand: invokeExpand,
  },
};

export function rendererFor(toolName: string): ToolRenderer {
  return RENDERERS[toolName] ?? DEFAULT_RENDERER;
}
