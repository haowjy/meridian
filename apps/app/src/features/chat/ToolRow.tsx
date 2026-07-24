/**
 * ToolRow — adapter from a normalized `ToolView` to one row in the activity
 * timeline.
 *
 * Thin binding: it picks the registered renderer for the tool name, evaluates
 * the title and optional expansion for the current view, and hands the result to the
 * shared `ActivityRow` primitive. Replaces the boxed `ToolCard`; one logical
 * tool invocation is now a single text-altitude row.
 *
 * Hidden tools: a few "tools" are protocol primitives whose UX lives elsewhere
 * (the custom interrupt card for `ask_user`). Their tool_use / tool_result
 * blocks are duplication when rendered as activity rows; the shared visibility
 * predicate keeps the rendered rows and process digest in agreement.
 */

import { ActivityRow, type ActivityRowStatus } from "./ActivityRow";
import type { ToolView } from "./group-delivery-segments";
import { rendererFor } from "./tool-renderers";
import { isToolViewVisible } from "./tool-view-visibility";

export type ToolRowProps = {
  tool: ToolView;
  writeMode?: "direct" | "draft";
};

export function ToolRow({ tool, writeMode = "direct" }: ToolRowProps) {
  if (!isToolViewVisible(tool)) return null;

  const renderer = rendererFor(tool.toolName);
  const status: ActivityRowStatus =
    tool.status === "partial" ? "running" : tool.isError ? "error" : "done";
  const expand = renderer.expand ? (renderer.expand(tool) ?? undefined) : undefined;

  return (
    <ActivityRow
      Icon={renderer.Icon}
      title={renderer.title(tool, { writeMode })}
      status={status}
      expand={expand}
    />
  );
}
