/** Immutable account close fencing at the registry core. */
import "fake-indexeddb/auto";

import { describe, expect, it } from "vitest";
import { createDocumentSessionCrossContextCoordination } from "./document-session-cross-context-coordination";
import { FifoWebLocks } from "./document-session-cross-context-coordination.test-support";
import { DocumentSessionRegistry } from "./document-session-registry-implementation";

describe("DocumentSessionRegistry account lifecycle", () => {
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
