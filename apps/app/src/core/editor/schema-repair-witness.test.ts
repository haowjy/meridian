// @vitest-environment jsdom
/** Contract coverage for bind-time schema repair observation and evidence. */

import { Editor } from "@tiptap/core";
import { ySyncPluginKey } from "@tiptap/y-tiptap";
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
const witnesses: ReturnType<typeof createSchemaRepairWitness>[] = [];

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
  for (const witness of witnesses.splice(0)) witness.destroy();
  vi.unstubAllGlobals();
});

function appendElement(
  doc: Y.Doc,
  nodeName: string,
  text: string,
  origin: unknown = "seed",
): Y.XmlElement {
  const element = new Y.XmlElement(nodeName);
  const yText = new Y.XmlText();
  doc.transact(() => {
    doc
      .getXmlFragment(PROSEMIRROR_FRAGMENT_NAME)
      .insert(doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME).length, [element]);
    element.insert(0, [yText]);
    yText.insert(0, text);
  }, origin);
  return element;
}

function foreignElementUpdate(doc: Y.Doc, nodeName: string, text: string): Uint8Array {
  const foreign = new Y.Doc({ gc: false });
  Y.applyUpdate(foreign, Y.encodeStateAsUpdate(doc), "copy-valid-state");
  const baseline = Y.encodeStateVector(doc);
  appendElement(foreign, nodeName, text, "foreign-client-insert");
  return Y.encodeStateAsUpdate(foreign, baseline);
}

async function finishFlush(): Promise<void> {
  await Promise.resolve();
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
  witnesses.push(witness);
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
    witness.enterLive(editor);
    return editor;
  } catch (error) {
    witness.destroy();
    throw error;
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

  it("captures every disjoint clock range deleted from one text item", () => {
    const doc = new Y.Doc({ gc: false });
    const paragraph = appendElement(doc, "paragraph", "abcdef");
    const yText = paragraph.get(0) as Y.XmlText;
    const before = Y.encodeStateAsUpdate(doc);
    let deletion: Uint8Array | null = null;
    doc.on("update", (update, origin) => {
      if (origin === "delete-disjoint") deletion = update;
    });

    doc.transact(() => {
      yText.delete(1, 1);
      yText.delete(2, 1);
    }, "delete-disjoint");

    expect(extractSchemaRepairEvidence(before, deletion as unknown as Uint8Array)).toEqual({
      deletedNodeTypes: [],
      deletedClockCount: 2,
      removedText: "bd",
    });
  });

  it("preserves prose boundaries between deleted block siblings", () => {
    const doc = new Y.Doc({ gc: false });
    appendElement(doc, "paragraph", "first passage");
    appendElement(doc, "paragraph", "second passage");
    const before = Y.encodeStateAsUpdate(doc);
    let deletion: Uint8Array | null = null;
    doc.on("update", (update, origin) => {
      if (origin === "delete-blocks") deletion = update;
    });

    doc.transact(() => {
      doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME).delete(0, 2);
    }, "delete-blocks");

    expect(extractSchemaRepairEvidence(before, deletion as unknown as Uint8Array)).toEqual({
      deletedNodeTypes: ["paragraph"],
      deletedClockCount: "first passage".length + "second passage".length + 4,
      removedText: "first passage\nsecond passage",
    });
  });

  it("preserves an empty structural separator between removed text items", () => {
    const doc = new Y.Doc({ gc: false });
    const block = new Y.XmlElement("future_block");
    const beforeText = new Y.XmlText();
    const hardBreak = new Y.XmlElement("hard_break");
    const afterText = new Y.XmlText();
    doc.transact(() => {
      doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME).insert(0, [block]);
      block.insert(0, [beforeText, hardBreak, afterText]);
      beforeText.insert(0, "before");
      afterText.insert(0, "after");
    }, "seed-structural-separator");
    const before = Y.encodeStateAsUpdate(doc);
    let deletion: Uint8Array | null = null;
    doc.on("update", (update, origin) => {
      if (origin === "delete-structural-separator") deletion = update;
    });

    doc.transact(() => {
      doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME).delete(0, 1);
    }, "delete-structural-separator");

    expect(extractSchemaRepairEvidence(before, deletion as unknown as Uint8Array)).toMatchObject({
      deletedNodeTypes: ["future_block", "hard_break"],
      removedText: "before\nafter",
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

  it("reports one live repair for a post-bind foreign invalid insert and preserves convergence", async () => {
    const doc = new Y.Doc();
    appendElement(doc, "paragraph", "valid prose");
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc), "initial-peer-state");
    const events: SchemaRepairEvent[] = [];
    const editor = constructEditor(doc, events);
    const propagatedUpdates: Uint8Array[] = [];
    doc.on("update", (update) => propagatedUpdates.push(update));

    Y.applyUpdate(
      doc,
      foreignElementUpdate(doc, "sidebar", "remote future prose"),
      "remote-provider-origin",
    );
    await finishFlush();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      phase: "live",
      deletedNodeTypes: ["sidebar"],
      removedText: "remote future prose",
    });
    expect(events[0]?.evidenceDegraded).toBeUndefined();
    expect(editor.getText()).toBe("valid prose");

    for (const update of propagatedUpdates) {
      Y.applyUpdate(peer, update, "peer-provider-origin");
    }
    expect(peer.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME).toString()).toBe(
      doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME).toString(),
    );
    expect([...Y.decodeStateVector(Y.encodeStateVector(peer))]).toEqual([
      ...Y.decodeStateVector(Y.encodeStateVector(doc)),
    ]);
  });

  it("pins binding meta for repair while ordinary deleteRange typing yields no verdict", async () => {
    const repairDoc = new Y.Doc();
    appendElement(repairDoc, "paragraph", "kept prose");
    appendElement(repairDoc, "sidebar", "future prose");
    const repairEvents: SchemaRepairEvent[] = [];
    const repairMetaKeys: string[][] = [];
    const repairWitness = createSchemaRepairWitness({
      document: repairDoc,
      onRepair: (event) => repairEvents.push(event),
      now: () => "2026-07-28T12:00:00.000Z",
    });
    witnesses.push(repairWitness);
    const repairEditor = new Editor({
      element: document.createElement("div"),
      ...createEditorConfig({
        document: repairDoc,
        awareness: new Awareness(repairDoc),
        showCollaborationDecorations: false,
      }),
      // This replays the spike's construction sequence through the live
      // correlator so the fork-internal binding meta stays a loud contract.
      onBeforeCreate: ({ editor }) => repairWitness.enterLive(editor),
      onTransaction: ({ transaction }) => {
        const meta = transaction.getMeta(ySyncPluginKey);
        if (meta) repairMetaKeys.push(Object.keys(meta).sort());
      },
    });
    editors.push(repairEditor);
    await finishFlush();

    expect(repairEvents).toHaveLength(1);
    expect(repairEvents[0]).toMatchObject({
      phase: "live",
      deletedNodeTypes: ["sidebar"],
      removedText: "future prose",
    });
    expect(repairMetaKeys).toContainEqual(["binding", "isChangeOrigin"]);

    const typingDoc = new Y.Doc();
    appendElement(typingDoc, "paragraph", "delete me");
    const typingEvents: SchemaRepairEvent[] = [];
    const typingEditor = constructEditor(typingDoc, typingEvents);
    const typingMeta: unknown[] = [];
    typingEditor.on("transaction", ({ transaction }) => {
      typingMeta.push(transaction.getMeta(ySyncPluginKey));
    });

    expect(typingEditor.commands.deleteRange({ from: 1, to: 7 })).toBe(true);
    await finishFlush();

    expect(typingMeta).toEqual([undefined]);
    expect(typingEvents).toEqual([]);
  });

  it("reports a remote-interleaved y-sync deletion when no user transaction occurs", async () => {
    const doc = new Y.Doc();
    appendElement(doc, "paragraph", "valid prose");
    const events: SchemaRepairEvent[] = [];
    const editor = constructEditor(doc, events);
    editor.destroy();

    let repaired = false;
    const repairAfterRemote = (transaction: Y.Transaction) => {
      if (transaction.origin !== "remote-provider-origin" || repaired) return;
      repaired = true;
      doc.transact(() => {
        doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME).delete(1, 1);
      }, ySyncPluginKey);
    };
    doc.on("afterTransaction", repairAfterRemote);

    Y.applyUpdate(
      doc,
      foreignElementUpdate(doc, "sidebar", "interleaved future prose"),
      "remote-provider-origin",
    );
    await finishFlush();
    doc.off("afterTransaction", repairAfterRemote);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      phase: "live",
      deletedNodeTypes: ["sidebar"],
      removedText: "interleaved future prose",
    });
  });

  it("reports magnitude with degraded evidence when deleted structs are not resolvable", async () => {
    const doc = new Y.Doc();
    appendElement(doc, "paragraph", "valid prose");
    const unboundText = doc.getText("unbound");
    unboundText.insert(0, "unrecoverable");
    const events: SchemaRepairEvent[] = [];
    const editor = constructEditor(doc, events);

    doc.transact(() => unboundText.delete(0, unboundText.length), ySyncPluginKey);
    editor.view.dispatch(
      editor.state.tr.setMeta(ySyncPluginKey, {
        isChangeOrigin: true,
      }),
    );
    await finishFlush();

    expect(events).toEqual([
      expect.objectContaining({
        phase: "live",
        deletedNodeTypes: [],
        deletedClockCount: "unrecoverable".length,
        evidenceDegraded: true,
      }),
    ]);
    expect(events[0]?.removedText).toBeUndefined();
  });

  it("accumulates repeat live repairs", async () => {
    const doc = new Y.Doc();
    appendElement(doc, "paragraph", "valid prose");
    const events: SchemaRepairEvent[] = [];
    constructEditor(doc, events);

    Y.applyUpdate(
      doc,
      foreignElementUpdate(doc, "sidebar", "first future prose"),
      "remote-provider-origin",
    );
    await finishFlush();
    Y.applyUpdate(
      doc,
      foreignElementUpdate(doc, "sidebar", "second future prose"),
      "remote-provider-origin",
    );
    await finishFlush();

    expect(events).toHaveLength(2);
    expect(events.map((event) => event.phase)).toEqual(["live", "live"]);
    expect(events.map((event) => event.removedText)).toEqual([
      "first future prose",
      "second future prose",
    ]);
  });

  it("keeps clean local and collaborative editing at zero verdicts", async () => {
    const doc = new Y.Doc();
    appendElement(doc, "paragraph", "writer prose");
    const events: SchemaRepairEvent[] = [];
    const editor = constructEditor(doc, events);

    expect(editor.commands.insertContentAt(7, " new")).toBe(true);
    expect(editor.commands.deleteRange({ from: 1, to: 3 })).toBe(true);
    Y.applyUpdate(
      doc,
      foreignElementUpdate(doc, "paragraph", "remote valid prose"),
      "remote-provider-origin",
    );
    await finishFlush();

    expect(events).toEqual([]);
  });
});
