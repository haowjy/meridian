/** Immutable account close fencing at the registry core. */
import "fake-indexeddb/auto";

import { describe, expect, it } from "vitest";
import { DocumentSessionAuthorityStore } from "./document-session-authority-store";
import type { DocumentSessionCrossContextCoordination } from "./document-session-cross-context-coordination";
import { createDocumentSessionCrossContextCoordination } from "./document-session-cross-context-coordination";
import { FifoWebLocks } from "./document-session-cross-context-coordination.test-support";
import { DocumentSessionRegistry } from "./document-session-registry-implementation";

describe("DocumentSessionRegistry account lifecycle", () => {
  it("does not advance lifecycle exclusion while ordinary and close drains share teardown", async () => {
    let rejectFirstDestroy!: (error: Error) => void;
    const firstDestroy = new Promise<void>((_resolve, reject) => {
      rejectFirstDestroy = reject;
    });
    let enterDestroy!: () => void;
    const destroyEntered = new Promise<void>((resolve) => {
      enterDestroy = resolve;
    });
    let destroyCalls = 0;
    const locks = new FifoWebLocks();
    let coordination!: DocumentSessionCrossContextCoordination;
    const accountId = "account-overlapping-drains";
    const registry = new DocumentSessionRegistry(
      (id, local) => {
        coordination = createDocumentSessionCrossContextCoordination({
          accountId: id,
          local,
          idb: indexedDB,
          locks,
          secureContext: true,
          createWakeChannel: null,
          reconcileIntervalMs: 60_000,
        });
        return coordination;
      },
      0,
      accountId,
      () => ({
        synced: true,
        subscribeStatus: () => () => undefined,
        destroy: async () => {
          destroyCalls += 1;
          if (destroyCalls === 1) {
            enterDestroy();
            await firstDestroy;
          }
        },
      }),
    );
    const lease = await registry.admit("project", "document", "1");
    registry.retain("editor", [lease]);
    const session = registry.get(lease);
    await session.whenLocalPersistenceSynced();
    const store = new DocumentSessionAuthorityStore(accountId, indexedDB);
    await store.ensureAvailable();
    await store.startDocumentDrain({
      documentId: lease.documentId,
      generation: lease.generation,
      commandId: "terminal-overlap",
    });

    const ordinary = coordination.reconcilePending("focus");
    await destroyEntered;
    const close = registry.closeAccountRuntime();
    for (let turn = 0; turn < 10; turn += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const lifecycle = locks.history.filter(({ name }) => name.includes("document-lifecycle"));
    expect(lifecycle).not.toContainEqual(
      expect.objectContaining({ event: "release", mode: "shared" }),
    );
    expect(lifecycle).not.toContainEqual(
      expect.objectContaining({ event: "grant", mode: "exclusive" }),
    );

    const failure = new Error("one-shot overlapping teardown failure");
    rejectFirstDestroy(failure);
    await expect(ordinary).rejects.toBe(failure);
    await close.catch((error: unknown) => {
      expect(error).toBe(failure);
    });
    await expect(registry.closeAccountRuntime()).resolves.toBeUndefined();
    expect(destroyCalls).toBe(2);
    await store.close();
  });

  it("joins a missing-map document drain through retry-only retained teardown", async () => {
    let enterDestroy!: () => void;
    const destroyEntered = new Promise<void>((resolve) => {
      enterDestroy = resolve;
    });
    let rejectDestroy!: (error: Error) => void;
    const firstDestroy = new Promise<void>((_resolve, reject) => {
      rejectDestroy = reject;
    });
    let destroyCalls = 0;
    const registry = new DocumentSessionRegistry(
      (accountId, local) =>
        createDocumentSessionCrossContextCoordination({
          accountId,
          local,
          idb: indexedDB,
          locks: new FifoWebLocks(),
          secureContext: true,
          createWakeChannel: null,
        }),
      0,
      "account-document-join",
      () => ({
        synced: true,
        subscribeStatus: () => () => undefined,
        destroy: async () => {
          destroyCalls += 1;
          if (destroyCalls === 1) {
            enterDestroy();
            await firstDestroy;
          }
        },
      }),
    );
    const lease = await registry.admit("project", "document", "1");
    registry.retain("editor", [lease]);
    const session = registry.get(lease);
    await session.whenLocalPersistenceSynced();

    const input = {
      documentId: lease.documentId,
      generation: lease.generation,
      incarnation: lease.generation,
    };
    const first = registry.drainDocument(input);
    await destroyEntered;
    let secondSettled = false;
    const second = registry.drainDocument(input).finally(() => {
      secondSettled = true;
    });
    await Promise.resolve();
    expect(secondSettled).toBe(false);

    const failure = new Error("one-shot document teardown failure");
    rejectDestroy(failure);
    await expect(first).rejects.toBe(failure);
    await expect(second).rejects.toBe(failure);
    await expect(registry.drainDocument(input)).resolves.toBeUndefined();
    expect(destroyCalls).toBe(2);
    await expect(registry.drainDocument(input)).resolves.toBeUndefined();
    expect(destroyCalls).toBe(2);
  });

  it("joins a missing-map terminal access drain until retained teardown settles", async () => {
    let finishDestroy!: () => void;
    const destroy = new Promise<void>((resolve) => {
      finishDestroy = resolve;
    });
    let enterDestroy!: () => void;
    const destroyEntered = new Promise<void>((resolve) => {
      enterDestroy = resolve;
    });
    const registry = new DocumentSessionRegistry(
      (accountId, local) =>
        createDocumentSessionCrossContextCoordination({
          accountId,
          local,
          idb: indexedDB,
          locks: new FifoWebLocks(),
          secureContext: true,
          createWakeChannel: null,
        }),
      0,
      "account-access-join",
      () => ({
        synced: true,
        subscribeStatus: () => () => undefined,
        destroy: async () => {
          enterDestroy();
          await destroy;
        },
      }),
    );
    const lease = await registry.admit("project", "document", "1");
    registry.retain("editor", [lease]);
    const session = registry.get(lease);
    await session.whenLocalPersistenceSynced();
    const input = {
      documentId: lease.documentId,
      projectId: lease.projectId,
      generation: lease.generation,
      incarnation: lease.generation,
    };

    const first = registry.drainAccess(input);
    await destroyEntered;
    let secondSettled = false;
    const second = registry.drainAccess(input).finally(() => {
      secondSettled = true;
    });
    await Promise.resolve();
    expect(secondSettled).toBe(false);
    finishDestroy();
    await expect(first).resolves.toBe("locally-empty");
    await expect(second).resolves.toBe("locally-empty");
  });

  it("refuses an admission commit that resumes after the account close fence", async () => {
    let continueAdmission!: () => void;
    const admissionBarrier = new Promise<void>((resolve) => {
      continueAdmission = resolve;
    });
    let admissionStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      admissionStarted = resolve;
    });
    const registry = new DocumentSessionRegistry(
      (accountId, local) => ({
        admit: async (projectId, documentId, generation) => {
          admissionStarted();
          await admissionBarrier;
          local.installSynchronously({
            documentId,
            projectId,
            generation,
            persistenceGeneration: generation,
          });
          return {
            accountId,
            projectId,
            documentId,
            generation,
            persistenceGeneration: generation,
          };
        },
        revokeDocument: async (_projectId, _documentId, generation) => ({
          revokedThrough: generation,
          persistence: "cleared" as const,
        }),
        revokeAccess: async (_projectId, _documentId, generation) => ({
          revokedThrough: generation,
          persistence: "cleared" as const,
        }),
        reconcilePending: async () => undefined,
        beginClose: () => undefined,
        close: async () => undefined,
      }),
      0,
      "account-commit-fence",
    );

    const opening = registry.admit("project", "doc-commit-fence", "1");
    await started;
    registry.beginCloseAccountRuntime();
    continueAdmission();

    await expect(opening).rejects.toThrow(/closing/);
    await registry.closeAccountRuntime();
  });

  it("retries a production-composed session close after one provider destroy failure", async () => {
    let enterFirstDestroy!: () => void;
    const firstDestroyEntered = new Promise<void>((resolve) => {
      enterFirstDestroy = resolve;
    });
    let rejectFirstDestroy!: (error: Error) => void;
    const firstDestroyBarrier = new Promise<void>((_resolve, reject) => {
      rejectFirstDestroy = reject;
    });
    let destroyCalls = 0;
    let markTransportCreated!: () => void;
    const transportCreated = new Promise<void>((resolve) => {
      markTransportCreated = resolve;
    });
    const registry = new DocumentSessionRegistry(
      (accountId, local) =>
        createDocumentSessionCrossContextCoordination({
          accountId,
          local,
          idb: indexedDB,
          locks: new FifoWebLocks(),
          secureContext: true,
          createWakeChannel: null,
        }),
      0,
      "account-production-close-retry",
      () => {
        markTransportCreated();
        return {
          synced: true,
          subscribeStatus: () => () => undefined,
          destroy: async () => {
            destroyCalls += 1;
            if (destroyCalls !== 1) return;
            enterFirstDestroy();
            await firstDestroyBarrier;
          },
        };
      },
    );
    const lease = await registry.admit("project", "document", "1");
    registry.retain("editor", [lease]);
    const session = registry.get(lease);
    await session.whenLocalPersistenceSynced();
    await transportCreated;

    const closeA = registry.closeAccountRuntime();
    const closeB = registry.closeAccountRuntime();
    expect(closeA).toBe(closeB);
    await firstDestroyEntered;
    const failure = new Error("one-shot provider destroy failure");
    rejectFirstDestroy(failure);
    await expect(closeA).rejects.toBe(failure);
    await expect(closeB).rejects.toBe(failure);

    await expect(registry.closeAccountRuntime()).resolves.toBeUndefined();
    expect(destroyCalls).toBe(2);
    await expect(registry.closeAccountRuntime()).resolves.toBeUndefined();
    expect(destroyCalls).toBe(2);
  });
});
