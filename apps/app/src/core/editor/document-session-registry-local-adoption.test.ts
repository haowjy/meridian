import "fake-indexeddb/auto";

import { afterEach, describe, expect, it, vi } from "vitest";
import { createDocumentSessionCrossContextCoordination } from "./document-session-cross-context-coordination";
import { FifoWebLocks } from "./document-session-cross-context-coordination.test-support";
import { DocumentSessionRegistry } from "./document-session-registry-implementation";

describe("DocumentSessionRegistry local adoption", () => {
  const registries: DocumentSessionRegistry[] = [];
  afterEach(async () => {
    await Promise.allSettled(
      registries.splice(0).map((registry) => registry.closeAccountRuntime()),
    );
  });

  it("reserves before visibility and installs the exact Y.Doc under one operation", async () => {
    const locks = new FifoWebLocks();
    const registry = new DocumentSessionRegistry(
      (accountId, local) =>
        createDocumentSessionCrossContextCoordination({
          accountId,
          local,
          locks,
          idb: indexedDB,
          secureContext: true,
          createWakeChannel: null,
        }),
      0,
      "account-adoption",
    );
    registries.push(registry);
    const session = registry.createDetached({
      accountId: "account-adoption",
      projectId: "project",
      documentId: "doc",
      persistenceKey: "local-adoption-test",
    });
    await session.whenLocalPersistenceSynced();
    session.raiseSchemaFence({ reason: "client-superseded" });
    let phase: "local-pending" | "adopted-live" = "local-pending";
    let committed = false;
    const handoff = registry.reserve({
      projectId: "project",
      documentId: "doc",
      session,
      ownerRevision: 1,
      prepareCommit: () => {
        expect(phase).toBe("local-pending");
        phase = "adopted-live";
      },
      commit: () => {
        committed = true;
      },
      finalize: async () => undefined,
    });
    let ordinarySettled = false;
    const ordinary = registry.admit("project", "doc", "2").then(() => {
      ordinarySettled = true;
    });
    await Promise.resolve();
    expect(ordinarySettled).toBe(false);

    const adopted = await registry.admitAndAdopt({
      projectId: "project",
      documentId: "doc",
      generation: "2",
      handoff,
    });
    expect(adopted.session).toBe(session);
    expect(adopted.session.document).toBe(session.document);
    expect(registry.get(adopted.lease)).toBe(session);
    expect(phase).toBe("adopted-live");
    expect(committed).toBe(true);
    await ordinary;

    const operationGrants = locks.history.filter(
      ({ event, name }) =>
        event === "grant" && name === "meridian:f1d:v1:operation/account-adoption/doc",
    );
    expect(operationGrants).toHaveLength(2);
  });

  it("settles an aborted handoff so ordinary admission cannot wait forever", async () => {
    const locks = new FifoWebLocks();
    const registry = new DocumentSessionRegistry(
      (accountId, local) =>
        createDocumentSessionCrossContextCoordination({
          accountId,
          local,
          locks,
          idb: indexedDB,
          secureContext: true,
          createWakeChannel: null,
        }),
      0,
      "account-abort",
    );
    registries.push(registry);
    const session = registry.createDetached({
      accountId: "account-abort",
      projectId: "project",
      documentId: "doc",
      persistenceKey: "local-abort-test",
    });
    const handoff = registry.reserve({
      projectId: "project",
      documentId: "doc",
      session,
      ownerRevision: 1,
      prepareCommit: () => undefined,
      commit: () => undefined,
      finalize: async () => undefined,
    });
    const ordinary = registry.admit("project", "doc", "1");
    registry.abort(handoff);
    await expect(ordinary).resolves.toMatchObject({ projectId: "project", documentId: "doc" });
  });

  it("withholds account close while an adoption finalizer is still pending", async () => {
    const registry = createRegistry("account-pending-finalizer");
    const session = registry.createDetached({
      accountId: "account-pending-finalizer",
      projectId: "project",
      documentId: "doc",
      persistenceKey: "local-pending-finalizer-test",
    });
    let releaseProvider!: () => void;
    const providerBarrier = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    let providerStarted!: () => void;
    const providerStart = new Promise<void>((resolve) => {
      providerStarted = resolve;
    });
    vi.spyOn(session, "stageIndexedDbPersistence").mockResolvedValue({
      commit: () => ({
        closePrevious: async () => {
          providerStarted();
          await providerBarrier;
        },
      }),
      abort: vi.fn(async () => undefined),
    });
    const handoff = registry.reserve({
      projectId: "project",
      documentId: "doc",
      session,
      ownerRevision: 1,
      prepareCommit: () => undefined,
      commit: () => undefined,
      finalize: vi.fn(async () => undefined),
    });
    const adoption = registry.admitAndAdopt({
      projectId: "project",
      documentId: "doc",
      generation: "1",
      handoff,
    });
    await providerStart;

    let closeSettled = false;
    const close = registry.closeAccountRuntime().finally(() => {
      closeSettled = true;
    });
    await Promise.resolve();
    expect(closeSettled).toBe(false);
    releaseProvider();
    await expect(adoption).resolves.toMatchObject({ session });
    await expect(close).resolves.toBeUndefined();
  });

  it("withholds account close until a failed provider-close stage is retried", async () => {
    const registry = createRegistry("account-provider-finalizer");
    const session = registry.createDetached({
      accountId: "account-provider-finalizer",
      projectId: "project",
      documentId: "doc",
      persistenceKey: "local-provider-finalizer-test",
    });
    let providerFault = true;
    const closePrevious = vi.fn(async () => {
      if (providerFault) throw new Error("provider close failed");
    });
    vi.spyOn(session, "stageIndexedDbPersistence").mockResolvedValue({
      commit: () => ({ closePrevious }),
      abort: vi.fn(async () => undefined),
    });
    const finalize = vi.fn(async () => undefined);
    const handoff = registry.reserve({
      projectId: "project",
      documentId: "doc",
      session,
      ownerRevision: 1,
      prepareCommit: () => undefined,
      commit: () => undefined,
      finalize,
    });
    await registry.admitAndAdopt({
      projectId: "project",
      documentId: "doc",
      generation: "1",
      handoff,
    });

    await expect(registry.closeAccountRuntime()).rejects.toThrow("provider close failed");
    expect(finalize).not.toHaveBeenCalled();
    providerFault = false;
    await expect(registry.closeAccountRuntime()).resolves.toBeUndefined();
    expect(closePrevious).toHaveBeenCalledTimes(3);
    expect(finalize).toHaveBeenCalledOnce();
  });

  it("retries only lease release after the provider-close stage settles", async () => {
    const registry = createRegistry("account-lease-finalizer");
    const session = registry.createDetached({
      accountId: "account-lease-finalizer",
      projectId: "project",
      documentId: "doc",
      persistenceKey: "local-lease-finalizer-test",
    });
    const closePrevious = vi.fn(async () => undefined);
    vi.spyOn(session, "stageIndexedDbPersistence").mockResolvedValue({
      commit: () => ({ closePrevious }),
      abort: vi.fn(async () => undefined),
    });
    const finalize = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("lease release failed"))
      .mockResolvedValueOnce(undefined);
    const handoff = registry.reserve({
      projectId: "project",
      documentId: "doc",
      session,
      ownerRevision: 1,
      prepareCommit: () => undefined,
      commit: () => undefined,
      finalize,
    });
    await registry.admitAndAdopt({
      projectId: "project",
      documentId: "doc",
      generation: "1",
      handoff,
    });

    await expect(registry.closeAccountRuntime()).resolves.toBeUndefined();
    expect(closePrevious).toHaveBeenCalledOnce();
    expect(finalize).toHaveBeenCalledTimes(2);
  });

  function createRegistry(accountId: string): DocumentSessionRegistry {
    const registry = new DocumentSessionRegistry(
      (configuredAccountId, local) =>
        createDocumentSessionCrossContextCoordination({
          accountId: configuredAccountId,
          local,
          locks: new FifoWebLocks(),
          idb: indexedDB,
          secureContext: true,
          createWakeChannel: null,
        }),
      0,
      accountId,
    );
    registries.push(registry);
    return registry;
  }
});
