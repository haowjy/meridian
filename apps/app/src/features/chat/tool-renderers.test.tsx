import type { Block } from "@meridian/contracts/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { ToolView } from "./group-delivery-segments";
import { rendererFor } from "./tool-renderers";

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((copy, part, index) => copy + part + (values[index] ?? ""), ""),
}));

function writeToolView(overrides: Partial<ToolView> = {}): ToolView {
  return {
    toolCallId: "call_write_1",
    toolName: "write",
    input: { path: "manuscript://chapter-1.md", command: "create" },
    output: null,
    status: "complete",
    isError: false,
    message: null,
    streamedOutput: null,
    keyBlock: { id: "b1", type: "tool_result", sequence: 1 } as unknown as Block,
    ...overrides,
  };
}

describe("write tool renderer", () => {
  const renderer = rendererFor("write");

  it("renders a completed draft with the document display name", () => {
    const html = renderToStaticMarkup(renderer.title?.(writeToolView(), { writeMode: "draft" }));
    expect(html).toContain("Drafted");
    expect(html).toContain("chapter-1");
    expect(html).not.toContain("manuscript://");
    expect(html).not.toContain(".md");
    expect(renderer.expand?.(writeToolView())).toBeNull();
  });

  it("labels read calls as reads rather than writes", () => {
    const html = renderToStaticMarkup(
      renderer.title?.(
        writeToolView({
          input: { path: "manuscript://chapter-1.md", command: "read" },
        }),
      ),
    );
    expect(html).toContain("Read");
    expect(html).not.toContain("Wrote");
  });

  it("maps rejected writes to curated document copy", () => {
    const structuredOutput = {
      code: "tool_error",
      source: "tool",
      message:
        "status: invalid_write\n\nFile already exists: manuscript://chapter-1.md. Use overwrite=true to overwrite.",
      retryable: false,
    };
    const tool = writeToolView({
      isError: true,
      output: structuredOutput,
    });
    const html = renderToStaticMarkup(renderer.title?.(tool, { writeMode: "draft" }));
    expect(html).toContain("Couldn&#x27;t draft");
    expect(html).toContain("chapter-1");
    expect(html).not.toContain("Drafted");
    const expand = renderToStaticMarkup(renderer.expand?.(tool));
    expect(expand).toContain("That change couldn&#x27;t be made in chapter-1.");
    expect(expand).not.toMatch(/:\/\/|\.md|command=|overwrite=true/);
  });

  it("uses the edits-card verb for edit commands", () => {
    const tool = writeToolView({
      input: { path: "manuscript://chapters/Chapter 3 — Ashes.md", command: "replace" },
    });

    const html = renderToStaticMarkup(renderer.title(tool, { writeMode: "direct" }));

    expect(html).toContain("Edited");
    expect(html).toContain("Chapter 3 — Ashes");
    expect(html).not.toContain("manuscript://");
  });

  it("qualifies documents outside the manuscript", () => {
    const tool = writeToolView({
      input: { path: "kb://characters/Elara.md", command: "read" },
    });

    const html = renderToStaticMarkup(renderer.title(tool));

    expect(html).toContain("Read");
    expect(html).toContain("Elara");
    expect(html).toContain("(Knowledge Base)");
    expect(html).not.toContain("kb://");
  });

  it("names direct edit failures without exposing the address", () => {
    const tool = writeToolView({
      input: { path: "manuscript://chapters/Chapter 3.md", command: "undo" },
      isError: true,
      output: "Could not undo",
    });

    const html = renderToStaticMarkup(renderer.title(tool, { writeMode: "direct" }));

    expect(html).toContain("Couldn&#x27;t edit");
    expect(html).toContain("Chapter 3");
    expect(html).not.toContain("manuscript://");
  });

  it("names direct create failures as writes", () => {
    const tool = writeToolView({ isError: true, output: "File already exists" });

    const html = renderToStaticMarkup(renderer.title(tool, { writeMode: "direct" }));

    expect(html).toContain("Couldn&#x27;t write");
    expect(html).toContain("chapter-1");
  });

  it("sanitizes legacy string-shaped tool errors", () => {
    const tool = writeToolView({
      isError: true,
      output:
        "status: invalid_write\nFile already exists: manuscript://chapter-1.md. Use overwrite=true to overwrite.",
    });
    const expand = renderToStaticMarkup(renderer.expand?.(tool));
    expect(expand).toContain("That change couldn&#x27;t be made in chapter-1.");
    expect(expand).not.toMatch(/:\/\/|\.md|command=|overwrite=true/);
  });

  it("never renders unknown machine detail", () => {
    const tool = writeToolView({
      isError: true,
      output: 'Run write(command="read", file="manuscript://chapters/Chapter 1.md") to re-sync.',
    });

    const expand = renderToStaticMarkup(renderer.expand?.(tool));

    expect(expand).toContain("Something went wrong while changing chapter-1.");
    expect(expand).not.toMatch(/:\/\/|\.md|command=|file=/);
  });
});

describe("unknown tool renderer", () => {
  it("humanizes the tool name without exposing arguments", () => {
    const tool = writeToolView({
      toolName: "return_result",
      input: {
        path: "manuscript://chapter-1.md",
        query: "a long developer-facing argument",
      },
    });
    const html = renderToStaticMarkup(rendererFor(tool.toolName).title(tool));

    expect(html).toContain("Return result");
    expect(html).not.toContain("manuscript://chapter-1.md");
    expect(html).not.toContain("query");
    expect(html).not.toContain("developer-facing");
  });

  it("shows only the humanized tool name when no path is present", () => {
    const tool = writeToolView({
      toolName: "return_result",
      input: { query: "a long developer-facing argument" },
    });

    expect(rendererFor(tool.toolName).title(tool)).toBe("Return result");
  });
});

describe("streaming tool labels", () => {
  it.each([
    ["ls", { path: "manuscript://" }, "Exploring Manuscript…"],
    ["grep", { pattern: "dragon" }, "Searching"],
  ])("uses present tense for a partial %s call", (toolName, input, expected) => {
    const tool = writeToolView({ toolName, input, status: "partial" });
    const html = renderToStaticMarkup(rendererFor(toolName).title(tool));

    expect(html).toContain(expected);
  });

  it.each([
    ["direct" as const, "Writing"],
    ["draft" as const, "Drafting"],
  ])("reflects %s write mode while a write streams", (writeMode, expected) => {
    const tool = writeToolView({ status: "partial" });
    const html = renderToStaticMarkup(rendererFor("write").title(tool, { writeMode }));

    expect(html).toContain(expected);
    expect(html).not.toContain("manuscript://");
    expect(html).not.toContain("chapter-1");
  });
});

describe("runtime tool registry", () => {
  it.each(["ls", "grep"])("registers the %s runtime tool", (toolName) => {
    expect(rendererFor(toolName)).not.toBe(rendererFor("unknown_tool"));
  });

  it("uses writer-friendly copy when ls has no path", () => {
    const tool = writeToolView({ toolName: "ls", input: {} });

    expect(rendererFor("ls").title(tool)).toBe("Explored folders");
  });

  it("shows only the leaf folder name for ls", () => {
    const tool = writeToolView({
      toolName: "ls",
      input: { path: "kb://characters/supporting" },
    });

    const html = renderToStaticMarkup(rendererFor("ls").title(tool));

    expect(html).toContain("Explored");
    expect(html).toContain("supporting");
    expect(html).not.toContain("kb://");
    expect(html).not.toContain("characters/");
  });

  it("reads grep's pattern input", () => {
    const tool = writeToolView({
      toolName: "grep",
      input: { pattern: "dragon", query: "wrong field" },
    });
    const html = renderToStaticMarkup(rendererFor("grep").title(tool));

    expect(html).toContain("dragon");
    expect(html).not.toContain("wrong field");
  });

  it("renders the server grep result array as curated rows", () => {
    const tool = writeToolView({
      toolName: "grep",
      output: [
        {
          uri: "manuscript://chapter-12.md",
          excerpt: "The dragon stirred beneath the mountain.",
          line: 42,
          score: 0.91,
        },
      ],
    });

    const html = renderToStaticMarkup(rendererFor("grep").expand?.(tool));

    expect(html).toContain("chapter-12");
    expect(html).not.toContain("manuscript://");
    expect(html).not.toContain(".md");
    expect(html).toContain("Line 42");
    expect(html).toContain("The dragon stirred beneath the mountain.");
    expect(html).not.toContain("0.91");
  });

  it("qualifies context result rows outside the manuscript", () => {
    const tool = writeToolView({
      toolName: "grep",
      output: [{ uri: "kb://characters/Elara.md", excerpt: "A crown of ash.", line: 7 }],
    });

    const html = renderToStaticMarkup(rendererFor("grep").expand?.(tool));

    expect(html).toContain("Elara");
    expect(html).toContain("(Knowledge Base)");
    expect(html).toContain("Line 7");
    expect(html).not.toContain("kb://");
  });

  it("does not expand an empty server grep result array", () => {
    const tool = writeToolView({ toolName: "grep", output: [] });

    expect(rendererFor("grep").expand?.(tool)).toBeNull();
  });
});

describe("invoke tool renderer", () => {
  it("humanizes spinal-case skill slugs", () => {
    const tool = writeToolView({
      toolName: "invoke",
      input: { skillname: "story-outline" },
    });

    expect(renderToStaticMarkup(rendererFor("invoke").title(tool))).toContain(
      "Ran the Story Outline skill",
    );
  });

  it("humanizes the slug in unavailable-skill messages", () => {
    const tool = writeToolView({
      toolName: "invoke",
      input: { skillname: "story-outline" },
      isError: true,
      output: 'Skill "story-outline" is no longer available.',
    });

    expect(renderToStaticMarkup(rendererFor("invoke").expand?.(tool))).toContain(
      "The Story Outline skill is no longer available",
    );
  });

  it("humanizes the slug in unknown-skill messages", () => {
    const tool = writeToolView({
      toolName: "invoke",
      input: { skillname: "story-outline" },
      isError: true,
      output: 'Unknown skill "story-outline".',
    });

    expect(renderToStaticMarkup(rendererFor("invoke").expand?.(tool))).toContain(
      "The Story Outline skill isn&#x27;t available",
    );
  });
});
