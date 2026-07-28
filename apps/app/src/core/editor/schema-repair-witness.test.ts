// @vitest-environment jsdom
/** Contract coverage for bind-time schema repair observation and evidence. */

import { Editor } from "@tiptap/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";

import { createEditorConfig } from "./config";
import { PROSEMIRROR_FRAGMENT_NAME } from "./schema";
import {
  createSchemaRepairWitness,
  extractSchemaRepairEvidence,
  type SchemaRepairEvent,
} from "./schema-repair-witness";

const editors: Editor[] = [];

beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
});

afterEach(() => {
  for (const editor of editors.splice(0)) {
    if (!editor.isDestroyed) editor.destroy();
  }
  vi.unstubAllGlobals();
});

function appendElement(doc: Y.Doc, nodeName: string, text: string): Y.XmlElement {
  const element = new Y.XmlElement(nodeName);
  const yText = new Y.XmlText();
  doc.transact(() => {
    doc
      .getXmlFragment(PROSEMIRROR_FRAGMENT_NAME)
      .insert(doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME).length, [element]);
    element.insert(0, [yText]);
    yText.insert(0, text);
  }, "seed");
  return element;
}

function constructEditor(
  doc: Y.Doc,
  events: SchemaRepairEvent[],
  evidenceDegraded = false,
): Editor {
  const witness = createSchemaRepairWitness({
    document: doc,
    onRepair: (event) => events.push(event),
    evidenceDegraded,
    now: () => "2026-07-28T12:00:00.000Z",
  });
  try {
    const editor = new Editor({
      element: document.createElement("div"),
      ...createEditorConfig({
        document: doc,
        awareness: new Awareness(doc),
        showCollaborationDecorations: false,
      }),
    });
    editors.push(editor);
    return editor;
  } finally {
    witness.enterLive();
  }
}

describe("schema repair witness", () => {
  it("reports the exact prose and node identity removed during editor construction", () => {
    const doc = new Y.Doc({ gc: false });
    appendElement(doc, "paragraph", "kept prose");
    appendElement(doc, "sidebar", "future prose");
    const events: SchemaRepairEvent[] = [];

    const editor = constructEditor(doc, events);

    expect(editor.getText()).toContain("kept prose");
    expect(events).toEqual([
      {
        phase: "open",
        detectedAt: "2026-07-28T12:00:00.000Z",
        deletedNodeTypes: ["sidebar"],
        deletedClockCount: "future prose".length + 2,
        removedText: "future prose",
      },
    ]);
  });

  it("resolves a deleted repeated sibling by Y item identity rather than position", () => {
    const doc = new Y.Doc({ gc: false });
    appendElement(doc, "paragraph", "first repeated sibling");
    appendElement(doc, "paragraph", "second repeated sibling");
    const before = Y.encodeStateAsUpdate(doc);
    let deletion: Uint8Array | null = null;
    doc.on("update", (update, origin) => {
      if (origin === "delete-second") deletion = update;
    });

    doc.transact(() => {
      doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME).delete(1, 1);
    }, "delete-second");

    expect(deletion).not.toBeNull();
    expect(extractSchemaRepairEvidence(before, deletion as unknown as Uint8Array)).toEqual({
      deletedNodeTypes: ["paragraph"],
      deletedClockCount: "second repeated sibling".length + 2,
      removedText: "second repeated sibling",
    });
  });

  it("marks a verdict when the bind horizon evidence was degraded", () => {
    const doc = new Y.Doc({ gc: false });
    appendElement(doc, "sidebar", "late evidence");
    const events: SchemaRepairEvent[] = [];

    constructEditor(doc, events, true);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      phase: "open",
      removedText: "late evidence",
      evidenceDegraded: true,
    });
  });
});
