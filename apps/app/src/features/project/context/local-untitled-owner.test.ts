import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { DocumentSession } from "@/core/editor/document-session";
import { LocalUntitledOwner } from "./local-untitled-owner";
import type { LocalUntitledKey, LocalUntitledRecord } from "./local-untitled-record-store";

const key = (documentId = "document-a"): LocalUntitledKey => ({
  accountId: "account-a",
  projectId: "project-a",
  documentId,
});

function fixture() {
  const records = new Map<string, LocalUntitledRecord>();
  const releases: string[] = [];
  const document = new Y.Doc();
  const session = {
    document,
    getSnapshot: () => ({ status: "detached" }),
    subscribe: vi.fn((listener) => {
      listener({ status: "detached" });
      return vi.fn();
    }),
    whenLocalPersistenceSynced: vi.fn(async () => undefined),
    flushLocalPersistence: vi.fn(async () => undefined),
    destroy: vi.fn(async () => undefined),
  } as unknown as DocumentSession;
  return {
    records,
    releases,
    session,
    owner: new LocalUntitledOwner({
      accountId: "account-a",
      records: {
        read: (input) => records.get(input.documentId) ?? null,
        write: (record) => records.set(record.key.documentId, record),
        remove: (input, revision) => {
          const record = records.get(input.documentId);
          if (!record || record.revision !== revision) return "stale";
          records.delete(input.documentId);
          return "removed";
        },
        list: () => [...records.values()],
      },
      lifetime: {
        tryAcquire: vi.fn(async (_projectId, documentId) => ({
          release: async () => void releases.push(documentId),
        })),
      },
      sessions: { createDetached: vi.fn(() => session) },
      reservations: { reserve: vi.fn(() => ({}) as never) },
      newLineageId: () => "lineage-a",
    }),
  };
}

describe("LocalUntitledOwner", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("persists before construction, qualifies the key, and restores only durable records", async () => {
    const f = fixture();
    const opened = await f.owner.create(key());
    expect(opened.kind).toBe("opened");
    expect(f.records.get("document-a")).toMatchObject({ key: key(), phase: "local-pending" });
    await expect(f.owner.restore(key("unknown"))).rejects.toThrow("durable pending record");
  });

  it("constructs nothing when HL is owned elsewhere", async () => {
    const f = fixture();
    vi.mocked(f.owner.dependencies.lifetime.tryAcquire).mockResolvedValueOnce(null);
    expect(await f.owner.create(key())).toEqual({ kind: "owned-elsewhere" });
    expect(f.owner.dependencies.sessions.createDetached).not.toHaveBeenCalled();
    expect(f.records.size).toBe(0);
  });

  it("retains, observes, refuses nonempty abandon, and preserves pending records on destroyAll", async () => {
    const f = fixture();
    await f.owner.create(key());
    f.owner.retain("view", [key()]);
    const stop = f.owner.observe(key(), vi.fn());
    f.session.document.getXmlFragment("prosemirror").insert(0, [new Y.XmlText("words")]);
    expect(
      await f.owner.abandon({ key: key(), expectedRevision: 1, evidence: "writer-empty-close" }),
    ).toBe("busy");
    stop();
    f.owner.release("view");
    await f.owner.destroyAll();
    expect(f.records.has("document-a")).toBe(true);
    expect(f.releases).toEqual(["document-a"]);
  });
});
