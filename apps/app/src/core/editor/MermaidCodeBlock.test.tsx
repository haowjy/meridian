// @vitest-environment jsdom
import { Editor } from "@tiptap/core";
import { EditorContent } from "@tiptap/react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createStandaloneEditorExtensions } from "./config";
import { renderMermaid } from "./MermaidCodeBlock";

vi.mock("@lingui/core/macro", () => ({
  t: (parts: TemplateStringsArray) => parts.join(""),
}));

let editor: Editor | null = null;
let root: Root | null = null;

afterEach(() => {
  root?.unmount();
  root = null;
  editor?.destroy();
  editor = null;
  document.body.replaceChildren();
});

describe("Mermaid code blocks", () => {
  it("does not leave Mermaid's temporary error SVG in the document", async () => {
    const id = "invalid-mermaid-probe";

    await expect(renderMermaid(id, "flowchart LR\nA[")).rejects.toThrow();

    expect(document.getElementById(id)).toBeNull();
    expect(document.body.textContent).not.toContain("Syntax error in text");
  });

  it("renders a mermaid fence as a diagram and keeps its source off the page", async () => {
    const element = document.createElement("div");
    document.body.append(element);
    editor = new Editor({
      extensions: createStandaloneEditorExtensions(),
      content: {
        type: "doc",
        content: [
          {
            type: "code_block",
            attrs: { language: "mermaid" },
            content: [{ type: "text", text: "flowchart LR\nA --> B" }],
          },
          { type: "paragraph", content: [{ type: "text", text: "after" }] },
        ],
      },
    });
    root = createRoot(element);
    root.render(<EditorContent editor={editor} />);

    // The caret sitting inside the fence used to swap the diagram back to
    // source. It no longer does: source lives behind the rebuild's dialog.
    editor.commands.setTextSelection(1);

    await vi.waitFor(() => {
      expect(document.querySelector("[data-mermaid-preview]")).not.toBeNull();
      expect(document.querySelector("[data-language='mermaid'] pre")?.className).toContain(
        "hidden",
      );
    });
  });
});
