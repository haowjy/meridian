// @vitest-environment jsdom
import { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { ySyncPluginKey } from "@tiptap/y-tiptap";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { createEditorConfig } from "../config";

let editor: Editor;

const marks = () => editor.view.dom.querySelectorAll("[data-passage-match]");

beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  HTMLElement.prototype.scrollIntoView = vi.fn();
  const doc = new Y.Doc({ gc: false });
  editor = new Editor({
    element: document.createElement("div"),
    ...createEditorConfig({ document: doc, awareness: new Awareness(doc) }),
  });
  editor.commands.setContent({
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text: "Elara waited." }] }],
  });
});

afterEach(() => {
  editor.destroy();
  vi.unstubAllGlobals();
});

describe("PassageHighlightExtension", () => {
  it("marks the matched words without moving the writer's cursor", () => {
    const before = editor.state.selection.from;

    expect(editor.commands.showPassageMatches([{ from: 1, to: 6 }])).toBe(true);
    expect(marks()).toHaveLength(1);
    expect(marks()[0]?.textContent).toBe("Elara");
    expect(editor.state.selection.from).toBe(before);
  });

  it("gets out of the way the moment the writer types", () => {
    editor.commands.showPassageMatches([{ from: 1, to: 6 }]);

    editor.commands.insertContentAt(14, " Then she left.");

    expect(marks()).toHaveLength(0);
  });

  it("gets out of the way when the writer moves the caret", () => {
    editor.commands.showPassageMatches([{ from: 1, to: 6 }]);

    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 10)));

    expect(marks()).toHaveLength(0);
  });

  it("survives a remote update, which is not the writer moving", () => {
    editor.commands.showPassageMatches([{ from: 1, to: 6 }]);

    const remote = editor.state.tr.insertText("Cold iron. ", 1);
    remote.setMeta(ySyncPluginKey, { isChangeOrigin: true });
    editor.view.dispatch(remote);

    expect(marks()).toHaveLength(1);
    expect(marks()[0]?.textContent).toBe("Elara");
  });
});
