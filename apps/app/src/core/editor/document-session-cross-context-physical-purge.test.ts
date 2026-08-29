import "fake-indexeddb/auto";

import { describe, expect, it, vi } from "vitest";
import {
  accessFenceKey,
  documentFenceKey,
  documentSessionPersistenceKey,
} from "./document-session-authority-store";
import { createDocumentSessionCrossContextCoordination } from "./document-session-cross-context-coordination";
import {
  bounded,
  coordinator,
  coordinators,
  FifoWebLocks,
  holdExclusive,
  inspectAuthority,
  LocalAuthority,
  observedIdb,
  openPersistence,
  operationName,
  PersistenceLocalAuthority,
  persistenceKeys,
  WakeBus,
} from "./document-session-cross-context-coordination.test-support";

describe("document session cross-context coordination", () => {
  it.each([
    { kind: "terminal", first: "fence" },
    { kind: "terminal", first: "admission" },
    { kind: "access", first: "fence" },
    { kind: "access", first: "admission" },
  ] as const)("linearizes $kind $first before the queued equal operation", async ({
    kind,
    first,
  }) => {
    const accountId = `account-${kind}-${first}-equal`;
    const locks = new FifoWebLocks();
    const wake = new WakeBus();
    const admissionLocal = new PersistenceLocalAuthority(accountId);
    const admission = coordinator(accountId, locks, admissionLocal, wake);
    const revoker = coordinator(accountId, locks, new LocalAuthority(), wake);
    await Promise.all([
      admission.value.reconcilePending("scan"),
      revoker.value.reconcilePending("scan"),
    ]);
    const releaseOperation = await holdExclusive(locks, operationName(accountId));
    const admit = () => admission.value.admit("project-b", "doc", "5");
    const revoke = () =>
      kind === "terminal"
        ? revoker.value.revokeDocument("project-b", "doc", "5", "terminal-5")
        : revoker.value.revokeAccess("project-b", "doc", "5", "access-b-5");
    const firstOperation = first === "fence" ? revoke() : admit();
    const secondOperation = first === "fence" ? admit() : revoke();
    void firstOperation.catch(() => undefined);
    void secondOperation.catch(() => undefined);
    releaseOperation();

    if (first === "fence") {
      await expect(firstOperation).resolves.toMatchObject({ revokedThrough: "5" });
      await expect(secondOperation).rejects.toMatchObject({ kind: "generation-revoked" });
      expect(admissionLocal.installs).toBe(0);
      expect(admissionLocal.destroyed).toBe(0);
      expect(await persistenceKeys(accountId)).toEqual([]);
    } else {
      await expect(firstOperation).resolves.toMatchObject({ generation: "5" });
      await expect(secondOperation).resolves.toMatchObject({
        revokedThrough: "5",
        persistence: "cleared",
      });
      expect(admissionLocal.installs).toBe(1);
      expect(admissionLocal.destroyed).toBe(kind === "terminal" ? 1 : 0);
      expect(admissionLocal.leases.size).toBe(0);
      await vi.waitFor(async () => expect(await persistenceKeys(accountId)).toEqual([]));
    }
    const queuedOperationGrants = locks.history.filter(
      ({ event, name }) => event === "grant" && name === operationName(accountId),
    );
    expect(queuedOperationGrants.length).toBeGreaterThanOrEqual(3);
    const firstLifecycleProof = locks.history.findIndex(
      ({ event, mode, name }) =>
        event === "request" && mode === "exclusive" && name.includes("lifecycle"),
    );
    const secondQueuedOperation = locks.history.findIndex(
      ({ event, name }, index) =>
        index >
          locks.history.findIndex(
            (entry) => entry.event === "grant" && entry.name === operationName(accountId),
          ) &&
        event === "grant" &&
        name === operationName(accountId),
    );
    expect(firstLifecycleProof).toBeGreaterThan(secondQueuedOperation);
    await expect(
      inspectAuthority(accountId, async (store) => ({
        room: await store.readRoom("doc"),
        fence: await store.readFence(
          kind === "terminal"
            ? documentFenceKey(accountId, "doc")
            : accessFenceKey(accountId, "project-b", "doc"),
        ),
        purge: await store.pendingPurges(),
      })),
    ).resolves.toMatchObject({
      room: { pendingDrain: null },
      fence: { revokedThrough: "5" },
      purge: [],
    });
  });

  it("returns retained when equal B admission precedes its queued access fence", async () => {
    const accountId = "account-access-admission-retained";
    const locks = new FifoWebLocks();
    const wake = new WakeBus();
    const a = coordinator(accountId, locks, new PersistenceLocalAuthority(accountId), wake);
    const b = coordinator(accountId, locks, new PersistenceLocalAuthority(accountId), wake);
    const revoker = coordinator(accountId, locks, new LocalAuthority(), wake);
    await a.value.admit("project-a", "doc", "5");
    const releaseOperation = await holdExclusive(locks, operationName(accountId));
    const admitted = b.value.admit("project-b", "doc", "5");
    const revoked = revoker.value.revokeAccess("project-b", "doc", "5", "access-b-5");
    releaseOperation();
    await expect(admitted).resolves.toMatchObject({ persistenceGeneration: "5" });
    await expect(revoked).resolves.toEqual({
      revokedThrough: "5",
      persistence: "retained-by-other-lease",
    });
    expect(a.local.leases.size).toBe(1);
    expect(b.local.leases.size).toBe(0);
    expect(await persistenceKeys(accountId)).toEqual([
      documentSessionPersistenceKey(accountId, "doc", "5"),
    ]);
    await expect(
      inspectAuthority(accountId, (store) =>
        store.startAccessDrain({
          documentId: "doc",
          projectId: "project-b",
          generation: "5",
          commandId: "access-b-5",
        }),
      ),
    ).resolves.toMatchObject({ kind: "replay", persistence: "retained-by-other-lease" });
  });

  it("retains A when B access fences before B's queued equal admission", async () => {
    const accountId = "account-access-fence-retained";
    const locks = new FifoWebLocks();
    const wake = new WakeBus();
    const a = coordinator(accountId, locks, new PersistenceLocalAuthority(accountId), wake);
    const bLocal = new PersistenceLocalAuthority(accountId);
    const b = coordinator(accountId, locks, bLocal, wake);
    const revoker = coordinator(accountId, locks, new LocalAuthority(), wake);
    await a.value.admit("project-a", "doc", "5");
    await Promise.all([b.value.reconcilePending("scan"), revoker.value.reconcilePending("scan")]);
    const releaseOperation = await holdExclusive(locks, operationName(accountId));
    const revoked = revoker.value.revokeAccess("project-b", "doc", "5", "access-b-5");
    const admitted = b.value.admit("project-b", "doc", "5");
    void admitted.catch(() => undefined);
    releaseOperation();

    await expect(revoked).resolves.toEqual({
      revokedThrough: "5",
      persistence: "retained-by-other-lease",
    });
    await expect(admitted).rejects.toMatchObject({ kind: "generation-revoked" });
    expect(a.local.leases.size).toBe(1);
    expect(bLocal.installs).toBe(0);
    expect(bLocal.destroyed).toBe(0);
    expect(await persistenceKeys(accountId)).toEqual([
      documentSessionPersistenceKey(accountId, "doc", "5"),
    ]);
  });

  it.each([
    { outcome: "retained-by-other-lease", later: "holder-close" },
    { outcome: "cleared", later: "later-incarnation" },
  ] as const)("replays exact $outcome after $later through a reloaded coordinator", async ({
    outcome,
  }) => {
    const accountId = `account-access-replay-${outcome}`;
    const locks = new FifoWebLocks();
    const wake = new WakeBus();
    const a = coordinator(accountId, locks, new PersistenceLocalAuthority(accountId), wake);
    const b = coordinator(accountId, locks, new PersistenceLocalAuthority(accountId), wake);
    if (outcome === "retained-by-other-lease") await a.value.admit("project-a", "doc", "4");
    await b.value.admit("project-b", "doc", "4");
    await expect(b.value.revokeAccess("project-b", "doc", "4", "access-b-4")).resolves.toEqual({
      revokedThrough: "4",
      persistence: outcome,
    });
    await Promise.allSettled([b.value.close()]);
    if (outcome === "retained-by-other-lease") {
      await Promise.allSettled([a.value.close()]);
    } else {
      const later = coordinator(accountId, locks, new PersistenceLocalAuthority(accountId), wake);
      await later.value.admit("project-a", "doc", "10");
      await later.value.close();
    }

    const replayLocal = new PersistenceLocalAuthority(accountId);
    const replay = coordinator(accountId, locks, replayLocal, wake);
    await expect(replay.value.revokeAccess("project-b", "doc", "4", "access-b-4")).resolves.toEqual(
      { revokedThrough: "4", persistence: outcome },
    );
    expect(replayLocal.installs).toBe(0);
    expect(replayLocal.destroyed).toBe(0);
    expect(replayLocal.leases.size).toBe(0);
    if (outcome === "cleared") {
      expect(await persistenceKeys(accountId)).toEqual([
        documentSessionPersistenceKey(accountId, "doc", "10"),
      ]);
      await expect(
        inspectAuthority(accountId, (store) => store.readRoom("doc")),
      ).resolves.toMatchObject({ persistenceGeneration: "10", pendingDrain: null });
    }
  });

  it("restarts a lower other-project admission after a blocked access purge", async () => {
    const accountId = "account-lower-behind-access-purge";
    const locks = new FifoWebLocks();
    const wake = new WakeBus();
    const b = coordinator(accountId, locks, new PersistenceLocalAuthority(accountId), wake);
    await b.value.admit("project-b", "doc", "5");
    const oldPersistence = await openPersistence(accountId, "doc", "5");
    await expect(
      bounded(
        "initial blocked access revoke",
        b.value.revokeAccess("project-b", "doc", "5", "access-b-5"),
      ),
    ).rejects.toMatchObject({ kind: "purge-pending" });
    const aLocal = new PersistenceLocalAuthority(accountId);
    const a = coordinator(accountId, locks, aLocal, wake);
    const lowerAdmission = a.value.admit("project-a", "doc", "4");
    let lowerSettled = false;
    void lowerAdmission.then(
      () => {
        lowerSettled = true;
      },
      () => {
        lowerSettled = true;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(lowerSettled).toBe(false);
    expect(aLocal.installs).toBe(0);
    expect(aLocal.leases.size).toBe(0);
    expect(await persistenceKeys(accountId)).toEqual([
      documentSessionPersistenceKey(accountId, "doc", "5"),
    ]);

    oldPersistence.close();
    await expect(lowerAdmission).rejects.toMatchObject({ kind: "purge-pending" });
    await vi.waitFor(async () => {
      await a.value.reconcilePending("scan");
      expect(await inspectAuthority(accountId, (store) => store.pendingPurges())).toEqual([]);
    });
    await expect(
      bounded("lower restarted admit", a.value.admit("project-a", "doc", "4")),
    ).resolves.toMatchObject({
      generation: "4",
      persistenceGeneration: "4",
    });
    expect(aLocal.installs).toBe(1);
    await vi.waitFor(async () =>
      expect(await persistenceKeys(accountId)).toEqual([
        documentSessionPersistenceKey(accountId, "doc", "4"),
      ]),
    );
    await expect(
      inspectAuthority(accountId, (store) => store.readRoom("doc")),
    ).resolves.toMatchObject({ persistenceGeneration: "4", documentAdmittedThrough: "5" });
  });

  it("does not let an old physical worker adopt a newer unproven terminal bound", async () => {
    const accountId = "account-old-worker-unproven-bound";
    const locks = new FifoWebLocks();
    const wake = new WakeBus(false);
    const owner = coordinator(accountId, locks, new PersistenceLocalAuthority(accountId), wake);
    await owner.value.admit("project", "doc", "5");
    const oldPersistence = await openPersistence(accountId, "doc", "5");
    await expect(
      bounded(
        "initial blocked terminal",
        owner.value.revokeDocument("project", "doc", "5", "terminal-5"),
      ),
    ).rejects.toMatchObject({ kind: "purge-pending" });
    await bounded("new incarnation", owner.value.admit("project", "doc", "10"));
    await Promise.allSettled([owner.value.close()]);
    const worker = coordinator(accountId, locks, new LocalAuthority(), wake);
    const operationGrantsBeforeWorker = locks.history.filter(
      ({ event, name }) => event === "grant" && name === operationName(accountId),
    ).length;
    const oldWorker = worker.value.reconcilePending("scan");
    await vi.waitFor(() =>
      expect(
        locks.history.filter(
          ({ event, name }) => event === "grant" && name === operationName(accountId),
        ).length,
      ).toBeGreaterThan(operationGrantsBeforeWorker),
    );
    const newerLocal = new LocalAuthority();
    let releaseProof!: () => void;
    newerLocal.documentDrainBarrier = new Promise<void>((resolve) => {
      releaseProof = resolve;
    });
    const newer = coordinator(accountId, locks, newerLocal, wake);
    await bounded("newer holder", newer.value.admit("project", "doc", "10"));
    const terminal12 = newer.value.revokeDocument("project", "doc", "12", "terminal-12");
    await newerLocal.documentDrainEntered;
    oldPersistence.close();
    await oldWorker;
    await expect(
      inspectAuthority(accountId, async (store) => ({
        room: await store.readRoom("doc"),
        purges: await store.pendingPurges(),
      })),
    ).resolves.toMatchObject({
      room: { pendingDrain: { generation: "12" } },
      purges: [],
    });
    expect(await persistenceKeys(accountId)).toEqual([
      documentSessionPersistenceKey(accountId, "doc", "10"),
    ]);
    releaseProof();
    await expect(terminal12).resolves.toEqual({ revokedThrough: "12", persistence: "cleared" });
  });

  it("lets one independent compare/delete worker win without deleting newer persistence", async () => {
    const accountId = "account-independent-purge-workers";
    const locks = new FifoWebLocks();
    const wake = new WakeBus(false);
    const owner = coordinator(accountId, locks, new PersistenceLocalAuthority(accountId), wake);
    await owner.value.admit("project", "doc", "5");
    const oldPersistence = await openPersistence(accountId, "doc", "5");
    await expect(
      owner.value.revokeDocument("project", "doc", "5", "terminal-5"),
    ).rejects.toMatchObject({ kind: "purge-pending" });
    await owner.value.admit("project", "doc", "10");
    await Promise.allSettled([owner.value.close()]);
    let casWinners = 0;
    const idb = observedIdb({
      onDelete: (store) => {
        if (store === "purges") casWinners += 1;
      },
    });
    const createWorker = () => {
      const local = new LocalAuthority();
      const value = createDocumentSessionCrossContextCoordination({
        accountId,
        idb,
        locks,
        local,
        secureContext: true,
        createWakeChannel: wake.create,
      });
      coordinators.push(value);
      return { value, local };
    };
    const first = createWorker();
    const second = createWorker();
    const firstWorker = first.value.reconcilePending("scan");
    const secondWorker = second.value.reconcilePending("scan");
    await vi.waitFor(() =>
      expect(
        locks.history.filter(
          ({ event, name }) => event === "grant" && name === operationName(accountId),
        ).length,
      ).toBeGreaterThanOrEqual(6),
    );
    oldPersistence.close();
    await Promise.all([firstWorker, secondWorker]);
    await expect(inspectAuthority(accountId, (store) => store.pendingPurges())).resolves.toEqual(
      [],
    );
    expect(casWinners).toBe(1);
    expect(await persistenceKeys(accountId)).toEqual([
      documentSessionPersistenceKey(accountId, "doc", "10"),
    ]);
    expect(first.local.installs + second.local.installs).toBe(0);
    expect(first.local.destroyed + second.local.destroyed).toBe(0);
  });
});
