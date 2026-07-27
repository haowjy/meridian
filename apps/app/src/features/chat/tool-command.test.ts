import type { Block } from "@meridian/contracts/protocol";
import { describe, expect, it, vi } from "vitest";

import type { ToolView } from "./group-delivery-segments";
import {
  isMutatingCommand,
  toolActivityAnnouncement,
  toolActivityVocabulary,
  toolCommand,
} from "./tool-command";

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((copy, part, index) => copy + part + (values[index] ?? ""), ""),
}));

function toolView(overrides: Partial<ToolView> = {}): ToolView {
  return {
    toolCallId: "call_1",
    toolName: "write",
    input: {},
    output: null,
    status: "complete",
    isError: false,
    message: null,
    streamedOutput: null,
    keyBlock: { id: "b1", type: "tool_result", sequence: 1 } as unknown as Block,
    ...overrides,
  };
}

function phrases(tool: ToolView, writeMode?: "direct" | "draft") {
  const vocabulary = toolActivityVocabulary(tool, writeMode);
  if (!vocabulary) return null;
  return {
    active: toolActivityAnnouncement(vocabulary.active),
    complete: toolActivityAnnouncement(vocabulary.complete),
  };
}

describe("command classification", () => {
  it.each([
    [{ command: "read" }, "read"],
    [{ command: "read", format: "full" }, "read"],
    [{ command: "read", format: "outline" }, "skim"],
    [{ command: "create" }, "create"],
    [{ command: "insert" }, "edit"],
    [{ command: "replace" }, "edit"],
    [{ command: "undo" }, "undo"],
    [{ command: "redo" }, "redo"],
    [{ command: "diff" }, "review"],
  ])("reads %o as its writer-facing command", (input, expected) => {
    expect(toolCommand(toolView({ input }))).toBe(expected);
  });

  it.each([
    ["grep", "search"],
    ["ls", "list"],
    ["invoke", "invoke"],
    ["return_result", "unknown"],
  ])("maps the %s tool to the %s command", (toolName, expected) => {
    expect(toolCommand(toolView({ toolName }))).toBe(expected);
  });
});

describe("the verb table", () => {
  it("says a skim was a skim, never a read", () => {
    expect(phrases(toolView({ input: { command: "read", format: "outline" } }))).toEqual({
      active: "Skimming…",
      complete: "Skimmed",
    });
  });

  it.each([
    ["undo", "Undoing…", "Undid"],
    ["redo", "Redoing…", "Redid"],
  ])("says %s reverted rather than edited, in both write modes", (command, active, complete) => {
    for (const writeMode of ["direct", "draft"] as const) {
      expect(phrases(toolView({ input: { command } }), writeMode)).toEqual({ active, complete });
    }
  });

  it("names the skill it invoked rather than claiming a run finished", () => {
    expect(
      phrases(toolView({ toolName: "invoke", input: { skillname: "story-outline" } })),
    ).toEqual({
      active: "Invoking the Story Outline skill…",
      complete: "Invoked the Story Outline skill",
    });
  });

  it.each([
    ["direct" as const, "Writing…", "Wrote"],
    ["draft" as const, "Drafting…", "Drafted"],
  ])("reflects %s write mode for a create", (writeMode, active, complete) => {
    expect(phrases(toolView({ input: { command: "create" } }), writeMode)).toEqual({
      active,
      complete,
    });
  });
});

describe("announcements match the visible row", () => {
  it("announces the folder an ls call actually explored", () => {
    // The shipped divergence: the row read `Exploring characters…` while the
    // screen reader heard `Exploring folders…`.
    expect(phrases(toolView({ toolName: "ls", input: { path: "kb://characters" } }))).toEqual({
      active: "Exploring characters…",
      complete: "Explored characters",
    });
  });

  it("announces the pattern a search used", () => {
    expect(phrases(toolView({ toolName: "grep", input: { pattern: "Elara" } }))).toEqual({
      active: "Searching “Elara”…",
      complete: "Searched “Elara”",
    });
  });

  it("falls back to a bound-free phrase when the call names nothing", () => {
    expect(phrases(toolView({ toolName: "ls", input: {} }))).toEqual({
      active: "Exploring folders…",
      complete: "Explored folders",
    });
  });
});

describe("the primary chip means the document changed", () => {
  it.each(["create", "edit", "undo", "redo"] as const)("marks %s as mutating", (command) => {
    expect(isMutatingCommand(command)).toBe(true);
  });

  it.each([
    "read",
    "skim",
    "search",
    "list",
    "invoke",
    "review",
    "unknown",
  ] as const)("leaves %s neutral", (command) => {
    expect(isMutatingCommand(command)).toBe(false);
  });

  it("leaves a draft neutral — a proposal has not changed the document", () => {
    expect(isMutatingCommand("edit", { writeMode: "draft" })).toBe(false);
  });

  it("leaves a failed write neutral — nothing landed", () => {
    expect(isMutatingCommand("create", { failed: true })).toBe(false);
  });
});
