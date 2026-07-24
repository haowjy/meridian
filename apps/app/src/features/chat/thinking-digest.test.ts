import { describe, expect, it, vi } from "vitest";
import type { ToolView } from "./group-delivery-segments";

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((copy, part, index) => copy + part + (values[index] ?? ""), ""),
  plural: (count: number, forms: { one: string; other: string }) =>
    (count === 1 ? forms.one : forms.other).replace("#", String(count)),
}));

vi.mock("@/features/project/context/context-schemes", () => ({
  schemeLabel: (scheme: string) =>
    ({ kb: "Knowledge Base", scratch: "Scratch", uploads: "Uploads", user: "User" })[scheme] ??
    "Manuscript",
}));

import { thinkingDigest } from "./thinking-digest";

function tool(
  toolName: string,
  input: ToolView["input"] = {},
  overrides: Partial<ToolView> = {},
): ToolView {
  return {
    toolCallId: `call-${toolName}`,
    toolName,
    input,
    output: null,
    status: "complete",
    isError: false,
    message: null,
    streamedOutput: null,
    keyBlock: {} as ToolView["keyBlock"],
    ...overrides,
  };
}

describe("thinkingDigest", () => {
  it("returns null for a reasoning-only fold", () => {
    expect(thinkingDigest([], "direct")).toBeNull();
  });

  it("routes reads, grep, and ls into explore without counting nameless ops", () => {
    expect(
      thinkingDigest(
        [
          tool("write", { command: "read", path: "Chapter 1.md" }),
          tool("grep", { pattern: "dragon" }),
          tool("ls", { path: "manuscript://" }),
        ],
        "direct",
      ),
    ).toBe("Explored 1 document");
  });

  it("normalizes bare paths and deduplicates repeated document targets", () => {
    expect(
      thinkingDigest(
        [
          tool("write", { command: "read", path: "chapters/Chapter 1.md" }),
          tool("write", { command: "read", path: "manuscript://chapters/Chapter 1.md" }),
          tool("write", JSON.stringify({ command: "read", path: "Chapter 2.md" })),
        ],
        "direct",
      ),
    ).toBe("Explored 2 documents");
  });

  it.each([
    ["read", "Explored 1 document"],
    ["replace", "Edited Chapter 1"],
  ])("counts canonical %s targets once across path spellings", (command, expected) => {
    expect(
      thinkingDigest(
        [
          tool("write", { command, path: "/chapters/Chapter 1.md" }),
          tool("write", { command, path: "chapters//Chapter 1.md" }),
          tool("write", { command, path: "manuscript://chapters/./Chapter 1.md" }),
        ],
        "direct",
      ),
    ).toBe(expected);
  });

  it("routes every non-read write command to edit and names one unique document", () => {
    for (const command of ["create", "insert", "replace", "undo", "redo"]) {
      expect(
        thinkingDigest(
          [tool("write", { command, path: "manuscript://chapters/Chapter 3.md" })],
          "direct",
        ),
      ).toBe("Edited Chapter 3");
    }
    expect(
      thinkingDigest([tool("write", { path: "manuscript://chapters/Chapter 3.md" })], "direct"),
    ).toBe("Edited Chapter 3");
  });

  it("counts several edited targets rather than listing titles", () => {
    expect(
      thinkingDigest(
        [
          tool("write", { command: "insert", path: "Chapter 1.md" }),
          tool("write", { command: "replace", path: "Chapter 2.md" }),
          tool("write", { command: "redo", path: "Chapter 2.md" }),
        ],
        "direct",
      ),
    ).toBe("Edited 2 documents");
  });

  it("uses the display-name qualifier without exposing the URI", () => {
    expect(
      thinkingDigest([tool("write", { command: "replace", path: "kb://Elara.md" })], "direct"),
    ).toBe("Edited Elara (Knowledge Base)");
  });

  it("uses drafted vocabulary in draft mode", () => {
    expect(
      thinkingDigest([tool("write", { command: "create", path: "Chapter 4.md" })], "draft"),
    ).toBe("Drafted Chapter 4");
  });

  it("counts invoke, unknown, targetless writes, and targetless exploration as steps", () => {
    expect(
      thinkingDigest(
        [tool("invoke"), tool("bash"), tool("write", { command: "create" }), tool("grep")],
        "direct",
      ),
    ).toBe("+4 steps");
  });

  it("counts errored explore and edit operations only as steps", () => {
    expect(
      thinkingDigest(
        [
          tool("write", { command: "read", path: "Chapter 1.md" }, { isError: true }),
          tool("write", { command: "replace", path: "Chapter 2.md" }, { isError: true }),
          tool("grep", {}, { isError: true }),
        ],
        "direct",
      ),
    ).toBe("+3 steps");
  });

  it("uses singular step copy", () => {
    expect(thinkingDigest([tool("invoke")], "direct")).toBe("+1 step");
  });

  it("orders and joins explore, edit, then steps", () => {
    expect(
      thinkingDigest(
        [
          tool("invoke"),
          tool("write", { command: "replace", path: "Chapter 3.md" }),
          tool("write", { command: "read", path: "Chapter 1.md" }),
          tool("write", { command: "read", path: "Chapter 2.md" }),
        ],
        "direct",
      ),
    ).toBe("Explored 2 documents, edited Chapter 3, +1 step");
  });

  it("excludes frontier-visible operations when the caller supplies fold tools only", () => {
    const folded = [tool("write", { command: "read", path: "Chapter 1.md" })];
    const visibleFrontier = tool("write", { command: "replace", path: "Chapter 3.md" });

    expect(thinkingDigest(folded, "direct")).toBe("Explored 1 document");
    expect(thinkingDigest([...folded, visibleFrontier], "direct")).not.toBe(
      thinkingDigest(folded, "direct"),
    );
  });
});
