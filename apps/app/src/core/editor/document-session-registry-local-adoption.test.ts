import "fake-indexeddb/auto";

import { afterEach, describe, expect, it } from "vitest";
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
});
