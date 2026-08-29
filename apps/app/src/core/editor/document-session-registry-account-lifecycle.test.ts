/** Account transitions, readiness, destroy, and versionchange recovery. */
import { describe, expect, it, vi } from "vitest";
import { documentSessionPersistenceKey } from "./document-session-authority-store";
import {
  admit,
  createDocumentSessionCrossContextCoordination,
  DocumentSessionRegistry,
  databaseNames,
  expectAuthorityError,
  providers,
  registryFor,
  TestLocks,
} from "./document-session-registry.test-support";

describe("DocumentSessionRegistry account lifecycle", () => {
  it("invalidates prior leases and isolates persistence on account switch", async () => {
    const registry = await registryFor("account-a");
    const firstLease = await admit(registry, "project", "doc", "1");
    const first = registry.get(firstLease);
    await first.whenLocalPersistenceSynced();

    registry.setOwnUserId("account-b");
    expect(() => registry.get(firstLease)).toThrow(expectAuthorityError("account-mismatch"));
    const secondLease = await admit(registry, "project", "doc", "1");
    expect(first.getSnapshot().status).toBe("destroyed");
    const second = registry.get(secondLease);
    await second.whenLocalPersistenceSynced();

    expect(second).not.toBe(first);
    expect(await databaseNames()).toEqual(
      expect.arrayContaining([
        documentSessionPersistenceKey("account-a", "doc", "1"),
        documentSessionPersistenceKey("account-b", "doc", "1"),
      ]),
    );
    registry.destroyAll();
  });

  it("does not enable the new account before asynchronous old-session teardown", async () => {
    let closeBarrier: Promise<void> = Promise.resolve();
    const created: string[] = [];
    const registry = new DocumentSessionRegistry((accountId, local) => {
      created.push(accountId);
      return {
        admit: async (projectId, documentId, generation) => {
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
        close: async () => {
          await closeBarrier;
          await local.invalidateAll();
        },
      };
    });
    registry.setOwnUserId("account-barrier-a");
    await admit(registry, "project", "doc-barrier", "1");
    let releaseOld!: () => void;
    const oldBarrier = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    closeBarrier = oldBarrier;

    registry.setOwnUserId("account-barrier-b");
    const next = admit(registry, "project", "doc-barrier", "1");
    await Promise.resolve();
    expect(created).toEqual(["account-barrier-a"]);
    releaseOld();
    await expect(next).resolves.toMatchObject({ accountId: "account-barrier-b" });
    expect(created).toEqual(["account-barrier-a", "account-barrier-b"]);
  });

  it("recovers on a later account after asynchronous authority readiness failure", async () => {
    const locks = new TestLocks();
    const registry = new DocumentSessionRegistry((accountId, local) =>
      createDocumentSessionCrossContextCoordination({
        accountId,
        local,
        locks,
        secureContext: true,
        createWakeChannel: null,
        idb:
          accountId === "account-failed"
            ? ({
                open: () => {
                  throw new Error("authority failed");
                },
              } as unknown as IDBFactory)
            : indexedDB,
      }),
    );
    registry.setOwnUserId("account-failed");
    await expect(admit(registry, "project", "doc", "1")).rejects.toEqual(
      expectAuthorityError("authority-unavailable"),
    );
    registry.setOwnUserId("account-recovered");
    await expect(admit(registry, "project", "doc", "1")).resolves.toMatchObject({
      accountId: "account-recovered",
    });
  });

  it.each([
    "open",
    "readwrite",
  ] as const)("owns an idle asynchronous %s readiness failure and preserves its diagnostic", async (failure) => {
    const diagnostic = new Error(`async authority ${failure} failed`);
    const request: Record<string, unknown> = { error: diagnostic };
    const database = {
      objectStoreNames: { contains: () => true },
      transaction: () => {
        const transaction: Record<string, unknown> = { error: diagnostic };
        queueMicrotask(() => {
          const handler = transaction.onabort;
          if (typeof handler === "function") handler();
        });
        return transaction;
      },
      close: vi.fn(),
    };
    const failedIdb = {
      open: () => {
        queueMicrotask(() => {
          const handler = request[failure === "open" ? "onerror" : "onsuccess"];
          if (typeof handler === "function") handler();
        });
        if (failure === "readwrite") request.result = database;
        return request;
      },
    } as unknown as IDBFactory;
    const locks = new TestLocks();
    const registry = new DocumentSessionRegistry((accountId, local) =>
      createDocumentSessionCrossContextCoordination({
        accountId,
        local,
        locks,
        secureContext: true,
        createWakeChannel: null,
        idb: accountId === "account-idle-failed" ? failedIdb : indexedDB,
      }),
    );
    const legacy = registry.temporaryGetDetached("idle-legacy");
    const unhandled: unknown[] = [];
    const observeUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", observeUnhandled);
    try {
      registry.setOwnUserId("account-idle-failed");
      await vi.waitFor(() => expect(legacy.getSnapshot().status).toBe("destroyed"));
      const retained = await admit(registry, "project", "doc", "1").catch(
        (error: unknown) => error,
      );
      expect(retained).toMatchObject({
        name: "DocumentSessionAuthorityError",
        kind: "authority-unavailable",
        message: expect.stringContaining(diagnostic.message),
      });
      registry.setOwnUserId("account-idle-recovered");
      await expect(admit(registry, "project", "doc", "1")).resolves.toMatchObject({
        accountId: "account-idle-recovered",
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", observeUnhandled);
      registry.destroyAll();
    }
  });

  it("holds later accounts behind rejected provider teardown and recovers without old holds", async () => {
    const locks = new TestLocks();
    vi.stubGlobal("navigator", { ...navigator, locks });
    const registry = await registryFor("account-poison-a");
    const lease = await admit(registry, "project", "doc-poison", "1");
    const session = registry.get(lease);
    await session.whenSynced();
    expect(locks.activeFor("account-poison-a")).toHaveLength(2);

    let rejectDestroy!: (error: Error) => void;
    const destroyBarrier = new Promise<void>((_resolve, reject) => {
      rejectDestroy = reject;
    });
    providers[0]?.destroy.mockReturnValue(destroyBarrier);
    registry.setOwnUserId("account-poison-b");
    const failedOld = admit(registry, "project", "doc-poison", "1");
    const failedOldExpectation = expect(failedOld).rejects.toThrow();
    registry.setOwnUserId("account-poison-c");
    const recovered = admit(registry, "project", "doc-poison", "1");
    const recoveryDiagnostic = expect(recovered).rejects.toThrow("provider destroy failed");
    let recoveredSettled = false;
    void recovered.then(
      () => {
        recoveredSettled = true;
      },
      () => {
        recoveredSettled = true;
      },
    );
    await vi.waitFor(() => expect(providers[0]?.destroy).toHaveBeenCalledOnce());
    expect(recoveredSettled).toBe(false);
    expect(locks.activeFor("account-poison-a")).toHaveLength(2);

    rejectDestroy(new Error("provider destroy failed"));
    await failedOldExpectation;
    await recoveryDiagnostic;
    expect(locks.activeFor("account-poison-a")).toEqual([]);
    registry.setOwnUserId("account-poison-d");
    await expect(admit(registry, "project", "doc-poison", "1")).resolves.toMatchObject({
      accountId: "account-poison-d",
    });
    registry.destroyAll();
  });

  it("owns a rejecting destroyAll transition while later joiners retain its diagnostic", async () => {
    const locks = new TestLocks();
    vi.stubGlobal("navigator", { ...navigator, locks });
    const accountId = "account-destroy-all-rejection";
    const registry = await registryFor(accountId);
    const lease = await admit(registry, "project", "doc", "1");
    const session = registry.get(lease);
    await session.whenSynced();
    const diagnostic = new Error("provider destroy failed on destroyAll");
    providers[0]?.destroy.mockRejectedValue(diagnostic);
    const unhandled: unknown[] = [];
    const observeUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", observeUnhandled);
    try {
      registry.destroyAll();
      const firstJoiner = admit(registry, "project", "doc", "2").catch((error: unknown) => error);
      const secondJoiner = admit(registry, "project", "doc", "3").catch((error: unknown) => error);
      expect(await firstJoiner).toBe(diagnostic);
      expect(await secondJoiner).toBe(diagnostic);
      expect(session.getSnapshot().status).toBe("destroyed");
      expect(providers[0]?.destroy).toHaveBeenCalledOnce();
      expect(locks.activeFor(accountId)).toEqual([]);

      const upgrade = indexedDB.open(`meridian:document-session-authority:${accountId}`, 3);
      await new Promise<void>((resolve, reject) => {
        upgrade.onsuccess = () => {
          upgrade.result.close();
          resolve();
        };
        upgrade.onerror = () => reject(upgrade.error);
      });
      registry.setOwnUserId("account-destroy-all-recovery");
      await expect(admit(registry, "project", "doc", "1")).resolves.toMatchObject({
        accountId: "account-destroy-all-recovery",
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", observeUnhandled);
      registry.destroyAll();
    }
  });

  it("owns rejecting provider teardown during versionchange while close joiners retain it", async () => {
    const locks = new TestLocks();
    vi.stubGlobal("navigator", { ...navigator, locks });
    const accountId = "account-versionchange-provider-rejection";
    let captureCoordination!: (
      value: ReturnType<typeof createDocumentSessionCrossContextCoordination>,
    ) => void;
    const capturedCoordination = new Promise<
      ReturnType<typeof createDocumentSessionCrossContextCoordination>
    >((resolve) => {
      captureCoordination = resolve;
    });
    const registry = new DocumentSessionRegistry((createdAccountId, local) => {
      const coordination = createDocumentSessionCrossContextCoordination({
        accountId: createdAccountId,
        local,
        locks,
        idb: indexedDB,
        secureContext: true,
        createWakeChannel: null,
      });
      captureCoordination(coordination);
      return coordination;
    }, 0);
    registry.setOwnUserId(accountId);
    const lease = await admit(registry, "project", "doc", "1");
    const session = registry.get(lease);
    await session.whenSynced();
    const diagnostic = new Error("provider destroy failed on versionchange");
    providers[0]?.destroy.mockRejectedValue(diagnostic);
    const unhandled: unknown[] = [];
    const observeUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", observeUnhandled);
    try {
      const upgrade = indexedDB.open(`meridian:document-session-authority:${accountId}`, 3);
      const upgraded = new Promise<void>((resolve, reject) => {
        upgrade.onsuccess = () => {
          upgrade.result.close();
          resolve();
        };
        upgrade.onerror = () => reject(upgrade.error);
      });
      await vi.waitFor(() => expect(providers[0]?.destroy).toHaveBeenCalledOnce());
      const coordination = await capturedCoordination;
      const joinedDiagnostic = await coordination.close().catch((error: unknown) => error);
      expect(joinedDiagnostic).toBe(diagnostic);
      await upgraded;
      expect(session.getSnapshot().status).toBe("destroyed");
      expect(locks.activeFor(accountId)).toEqual([]);

      registry.setOwnUserId("account-versionchange-provider-joiner");
      const registryDiagnostic = await admit(registry, "project", "doc", "1").catch(
        (error: unknown) => error,
      );
      expect(registryDiagnostic).toBe(diagnostic);
      registry.setOwnUserId("account-versionchange-provider-recovery");
      await expect(admit(registry, "project", "doc", "1")).resolves.toMatchObject({
        accountId: "account-versionchange-provider-recovery",
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", observeUnhandled);
      registry.destroyAll();
    }
  });
});
