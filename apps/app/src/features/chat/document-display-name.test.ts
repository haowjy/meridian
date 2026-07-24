import { describe, expect, it, vi } from "vitest";

import { documentDisplayName, folderDisplayName } from "./document-display-name";

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((copy, part, index) => copy + part + (values[index] ?? ""), ""),
}));

describe("documentDisplayName", () => {
  it.each([
    [
      "manuscript://chapters/Chapter 3 — Ashes of the Vale.md",
      "Chapter 3 — Ashes of the Vale",
      undefined,
    ],
    ["chapters/Chapter 4.md", "Chapter 4", undefined],
    ["kb://characters/Elara.mdx", "Elara", "Knowledge Base"],
    ["scratch://plans/Act 2.txt", "Act 2", "Scratch"],
    ["uploads://references/map.png", "map", "Uploads"],
    ["user://preferences/Voice.md", "Voice", "User"],
  ])("presents %s as a named story object", (uri, title, qualifier) => {
    expect(documentDisplayName(uri)).toEqual(qualifier ? { title, qualifier } : { title });
  });

  it("uses the writer-facing fallback when the basename stem is empty", () => {
    expect(documentDisplayName("manuscript://chapters/.md")).toEqual({
      title: "Untitled document",
    });
  });
});

describe("folderDisplayName", () => {
  it.each([
    ["manuscript://", "Manuscript"],
    ["kb://", "Knowledge Base"],
    ["scratch://", "Scratch"],
    ["uploads://", "Uploads"],
    ["user://", "User"],
    ["manuscript://acts/Act 1/scenes", "scenes"],
    ["acts/Act 1", "Act 1"],
  ])("presents %s as %s", (uri, expected) => {
    expect(folderDisplayName(uri)).toBe(expected);
  });
});
