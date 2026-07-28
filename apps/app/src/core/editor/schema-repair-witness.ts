/**
 * Schema repair witness — observes and reports binding-authored content removal.
 *
 * The witness owns one Y.Doc update listener across both construction and live
 * editing. W1 classifies synchronous construction repairs; the live phase stays
 * armed so its correlation logic can be added without another observation gap.
 */
import * as Y from "yjs";

import { PROSEMIRROR_FRAGMENT_NAME } from "./schema";

export type SchemaRepairEvent = {
  phase: "open" | "live";
  detectedAt: string;
  deletedNodeTypes: string[];
  deletedClockCount: number;
  /** Full removed prose, session-scoped (open phase always, live best-effort). */
  removedText?: string;
  /** Present only when the bind horizon expired before all evidence sources arrived. */
  evidenceDegraded?: true;
};

export type SchemaRepairEvidence = Pick<
  SchemaRepairEvent,
  "deletedNodeTypes" | "deletedClockCount" | "removedText"
>;

type DeleteRange = { clock: number; len: number };
type DeleteSet = { clients: Map<number, DeleteRange[]> };
type ItemLike = {
  id: { client: number; clock: number };
  length: number;
  right: ItemLike | null;
  content?: unknown;
};
type YTypeLike = { _start: ItemLike | null; nodeName?: string };

function decodedDeleteSet(update: Uint8Array): DeleteSet {
  return Y.decodeUpdate(update).ds as DeleteSet;
}

function deletedClockCount(deleteSet: DeleteSet): number {
  let total = 0;
  for (const ranges of deleteSet.clients.values()) {
    for (const range of ranges) total += range.len;
  }
  return total;
}

function deletedSlices(item: ItemLike, deleteSet: DeleteSet): Array<{ from: number; to: number }> {
  const ranges = deleteSet.clients.get(item.id.client);
  if (!ranges) return [];
  const itemStart = item.id.clock;
  const itemEnd = itemStart + item.length;
  const slices: Array<{ from: number; to: number }> = [];
  for (const range of ranges) {
    const from = Math.max(itemStart, range.clock);
    const to = Math.min(itemEnd, range.clock + range.len);
    if (from < to) slices.push({ from: from - itemStart, to: to - itemStart });
  }
  return slices;
}

function contentType(content: unknown): YTypeLike | null {
  if (!content || typeof content !== "object" || !("type" in content)) return null;
  return (content as { type: YTypeLike }).type;
}

/**
 * Resolve delete-set clocks against the pre-repair clone's item graph.
 *
 * Traversal follows Y item identity and logical XML order. It never compares
 * sibling positions between before and after documents, which would be
 * ambiguous when repeated or nested siblings have the same shape.
 */
export function extractSchemaRepairEvidence(
  preRepairSnapshot: Uint8Array,
  repairUpdate: Uint8Array,
): SchemaRepairEvidence {
  const deleteSet = decodedDeleteSet(repairUpdate);
  const snapshot = new Y.Doc({ gc: false });
  Y.applyUpdate(snapshot, preRepairSnapshot);

  const deletedNodeTypes: string[] = [];
  type TextToken = { kind: "text"; text: string } | { kind: "boundary" };
  const walk = (type: YTypeLike): TextToken[] => {
    const tokens: TextToken[] = [];
    for (let item = type._start; item; item = item.right) {
      const slices = deletedSlices(item, deleteSet);
      const content = item.content;
      if (content instanceof Y.ContentString) {
        const text = slices.map((slice) => content.str.slice(slice.from, slice.to)).join("");
        if (text) tokens.push({ kind: "text", text });
      }
      const child = contentType(content);
      if (!child) continue;
      if (slices.length > 0 && child.nodeName && !deletedNodeTypes.includes(child.nodeName)) {
        deletedNodeTypes.push(child.nodeName);
      }
      if (child.nodeName) tokens.push({ kind: "boundary" });
      tokens.push(...walk(child));
      if (child.nodeName) tokens.push({ kind: "boundary" });
    }
    return tokens;
  };

  let text = "";
  let boundary = false;
  for (const token of walk(
    snapshot.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME) as unknown as YTypeLike,
  )) {
    if (token.kind === "boundary") {
      if (text) boundary = true;
      continue;
    }
    if (boundary) text += "\n";
    text += token.text;
    boundary = false;
  }
  snapshot.destroy();

  return {
    deletedNodeTypes,
    deletedClockCount: deletedClockCount(deleteSet),
    ...(text ? { removedText: text } : {}),
  };
}

export type SchemaRepairWitness = {
  readonly phase: "open" | "live";
  readonly preBindSnapshot: Uint8Array;
  readonly latestPostRepairSnapshot: Uint8Array | null;
  enterLive(): void;
  destroy(): void;
};

export type CreateSchemaRepairWitnessOptions = {
  document: Y.Doc;
  onRepair: (event: SchemaRepairEvent) => void;
  evidenceDegraded?: boolean;
  now?: () => string;
};

export function createSchemaRepairWitness({
  document,
  onRepair,
  evidenceDegraded = false,
  now = () => new Date().toISOString(),
}: CreateSchemaRepairWitnessOptions): SchemaRepairWitness {
  // This snapshot and listener installation are intentionally one synchronous
  // operation. A render-time snapshot or later effect would leave remote bytes
  // outside the evidence source before Collaboration constructs.
  const preBindSnapshot = Y.encodeStateAsUpdate(document);
  let phase: "open" | "live" = "open";
  let latestPostRepairSnapshot: Uint8Array | null = null;

  const onUpdate = (
    update: Uint8Array,
    _origin: unknown,
    _doc: Y.Doc,
    transaction: Y.Transaction,
  ) => {
    const decoded = Y.decodeUpdate(update);
    const count = deletedClockCount(decoded.ds as DeleteSet);
    const deleteOnly = decoded.structs.length === 0 && count > 0;
    // W1 intentionally does not import the fork's ySyncPluginKey. During this
    // synchronous bracket the shipped extension assembly has no other
    // init-time local deleter; clean-open coverage pins that soundness bound.
    if (phase !== "open" || !transaction.local || !deleteOnly) return;

    // The update callback runs before control returns from construction, while
    // the repaired post-state and the pre-bind snapshot are both still exact.
    latestPostRepairSnapshot = Y.encodeStateAsUpdate(document);
    onRepair({
      phase,
      detectedAt: now(),
      ...extractSchemaRepairEvidence(preBindSnapshot, update),
      ...(evidenceDegraded ? { evidenceDegraded: true as const } : {}),
    });
  };

  document.on("update", onUpdate);

  return {
    get phase() {
      return phase;
    },
    preBindSnapshot,
    get latestPostRepairSnapshot() {
      return latestPostRepairSnapshot;
    },
    enterLive() {
      phase = "live";
    },
    destroy() {
      document.off("update", onUpdate);
    },
  };
}
