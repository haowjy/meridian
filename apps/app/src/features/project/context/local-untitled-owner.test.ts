import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { DocumentSession } from "@/core/editor/document-session";
import {
  type LocalUntitledIdentityRedirect,
  LocalUntitledOwner,
  type LocalUntitledOwnerDependencies,
} from "./local-untitled-owner";
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
    reidentifyDetached: vi.fn(async () => undefined),
    prepareDetachedReidentity: vi.fn(async () => ({
      commit: () => ({ closePrevious: async () => undefined }),
      abort: async () => undefined,
    })),
    destroy: vi.fn(async () => undefined),
  } as unknown as DocumentSession;
  const dependencies: LocalUntitledOwnerDependencies = {
    accountId: "account-a",
    records: {
      read: (input: LocalUntitledKey) =>
        records.get(`${input.projectId}:${input.documentId}`) ?? null,
      write: (record: LocalUntitledRecord) =>
        records.set(`${record.key.projectId}:${record.key.documentId}`, record),
      remove: (input: LocalUntitledKey, revision: number) => {
        const storageKey = `${input.projectId}:${input.documentId}`;
        const record = records.get(storageKey);
        if (!record || record.revision !== revision) return "stale" as const;
        records.delete(storageKey);
        return "removed" as const;
      },
      list: () => [...records.values()],
    },
    lifetime: {
      tryAcquire: vi.fn(async (_projectId: string, documentId: string) => ({
        release: async () => void releases.push(documentId),
      })),
    },
    sessions: { createDetached: vi.fn(() => session) },
    reservations: { reserve: vi.fn(() => ({}) as never), abort: vi.fn() },
    newLineageId: () => "lineage-a",
  };
  return {
    records,
    releases,
    session,
    dependencies,
    owner: new LocalUntitledOwner(dependencies),
  };
}

describe("LocalUntitledOwner", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("persists before construction, qualifies the key, and restores only durable records", async () => {
    const f = fixture();
    const opened = await f.owner.create(key());
    expect(opened.kind).toBe("opened");
    expect(f.records.get("project-a:document-a")).toMatchObject({
      key: key(),
      phase: "local-pending",
    });
    await expect(f.owner.restore(key("unknown"))).rejects.toThrow("durable pending record");
  });

  it("constructs nothing when HL is owned elsewhere", async () => {
    const f = fixture();
    vi.mocked(f.dependencies.lifetime.tryAcquire).mockResolvedValueOnce(null);
    expect(await f.owner.create(key())).toEqual({ kind: "owned-elsewhere" });
    expect(f.dependencies.sessions.createDetached).not.toHaveBeenCalled();
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
    expect(f.records.has("project-a:document-a")).toBe(true);
    expect(f.releases).toEqual(["document-a"]);
  });

  it("remints the same session while the old HL remains held and records deterministic lineage", async () => {
    const f = fixture();
    const opened = await f.owner.create(key());
    expect(opened.kind).toBe("opened");
    const replacement = await f.owner.remint(key(), key("document-b"));
    expect(replacement.session).toBe(f.session);
    expect(f.releases).toEqual(["document-a"]);
    expect(f.records.get("project-a:document-a")).toMatchObject({ active: false });
    expect(f.records.get("project-a:document-b")).toMatchObject({
      active: true,
      lineageId: "lineage-a",
      lineageRevision: 2,
    });
  });

  it("preserves the old identity and words when replacement HL is unavailable", async () => {
    const f = fixture();
    await f.owner.create(key());
    vi.mocked(f.dependencies.lifetime.tryAcquire).mockResolvedValueOnce(null);
    await expect(f.owner.remint(key(), key("document-b"))).rejects.toThrow("owned elsewhere");
    expect(f.owner.getDetached(key())?.session).toBe(f.session);
    expect(f.records.has("project-a:document-b")).toBe(false);
    expect(f.releases).toEqual([]);
  });

  it("redirects a stale crash-restored identity to the highest active lineage revision", async () => {
    const f = fixture();
    await f.owner.create(key());
    await f.owner.remint(key(), key("document-b"));
    await f.owner.destroyAll();
    const restored = new LocalUntitledOwner(f.dependencies);
    await expect(restored.restore(key())).rejects.toEqual(
      expect.objectContaining<Partial<LocalUntitledIdentityRedirect>>({
        name: "LocalUntitledIdentityRedirect",
        key: key("document-b"),
      }),
    );
  });

  it("owns the same document id independently in two projects", async () => {
    const f = fixture();
    const other = { ...key(), projectId: "project-b" };
    expect((await f.owner.create(key())).kind).toBe("opened");
    expect((await f.owner.create(other)).kind).toBe("opened");
    expect(f.owner.getDetached(key())).not.toBeNull();
    expect(f.owner.getDetached(other)).not.toBeNull();
    await f.owner.destroyAll();
    expect(f.releases).toEqual(["document-a", "document-a"]);
  });

  it("settles a definite pre-row abort so the exact reservation can retry", async () => {
    const f = fixture();
    await f.owner.create(key());
    const first = await f.owner.prepareMaterialization(key(), 1);
    f.owner.abortMaterialization(key(), first);
    const second = await f.owner.prepareMaterialization(key(), 1);
    expect(second).not.toBe(first);
    expect(f.dependencies.reservations.abort).toHaveBeenCalledWith(first);
    expect(f.dependencies.reservations.reserve).toHaveBeenCalledTimes(2);
  });

  it("retains abandon cleanup until provider close succeeds before HL release", async () => {
    const f = fixture();
    await f.owner.create(key());
    vi.mocked(f.session.destroy).mockRejectedValueOnce(new Error("provider-close-failed"));

    await expect(
      f.owner.abandon({ key: key(), expectedRevision: 1, evidence: "server-row-absent" }),
    ).rejects.toThrow("provider-close-failed");
    expect(f.records.has("project-a:document-a")).toBe(true);
    expect(f.owner.getDetached(key())).not.toBeNull();
    expect(f.releases).toEqual([]);

    expect(
      await f.owner.abandon({ key: key(), expectedRevision: 1, evidence: "server-row-absent" }),
    ).toBe("abandoned");
    expect(f.records.has("project-a:document-a")).toBe(false);
    expect(f.releases).toEqual(["document-a"]);
  });

  it("reports a committed remint while retaining failed old-provider cleanup for teardown", async () => {
    const f = fixture();
    const events: string[] = [];
    vi.mocked(f.session.prepareDetachedReidentity).mockResolvedValueOnce({
      commit: () => ({
        closePrevious: vi
          .fn()
          .mockImplementationOnce(async () => {
            events.push("old-close-failed");
            throw new Error("old-provider-close-failed");
          })
          .mockImplementationOnce(async () => void events.push("old-close")),
      }),
      abort: async () => undefined,
    });
    vi.mocked(f.session.destroy).mockImplementation(async () => void events.push("new-close"));
    vi.mocked(f.dependencies.lifetime.tryAcquire).mockImplementation(async (_projectId, id) => ({
      release: async () => {
        events.push(`release:${id}`);
        f.releases.push(id);
      },
    }));
    await f.owner.create(key());

    const replacement = await f.owner.remint(key(), key("document-b"));
    expect(replacement.key).toEqual(key("document-b"));
    expect(f.records.get("project-a:document-b")?.active).toBe(true);
    expect(f.releases).toEqual([]);

    await f.owner.destroyAll();
    expect(events[0]).toBe("old-close-failed");
    expect(events).toEqual(
      expect.arrayContaining([
        "old-close",
        "release:document-a",
        "new-close",
        "release:document-b",
      ]),
    );
    expect(events.indexOf("old-close")).toBeLessThan(events.indexOf("release:document-a"));
    expect(events.indexOf("new-close")).toBeLessThan(events.indexOf("release:document-b"));
  });

  it("attempts every provider and lease and aggregates teardown failures", async () => {
    const f = fixture();
    const destroy = vi.mocked(f.session.destroy);
    destroy.mockRejectedValueOnce(new Error("provider-a"));
    await f.owner.create(key("a"));
    await f.owner.create(key("b"));
    await expect(f.owner.destroyAll()).rejects.toThrow("Local Untitled teardown failed");
    expect(destroy).toHaveBeenCalledTimes(2);
    expect(f.releases).toEqual(["a", "b"]);
  });
});
