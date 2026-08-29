import "fake-indexeddb/auto";

import { describe, expect, it, vi } from "vitest";
import { documentSessionPersistenceKey } from "./document-session-authority-store";
import { createDocumentSessionCrossContextCoordination } from "./document-session-cross-context-coordination";
import {
  ChromiumShapeWebLocks,
  coordinator,
  coordinators,
  FailDocumentProofOnce,
  FifoWebLocks,
  inspectAuthority,
  LocalAuthority,
  observedIdb,
  PersistenceLocalAuthority,
  persistenceKeys,
  WakeBus,
} from "./document-session-cross-context-coordination.test-support";

describe("document session cross-context coordination", () => {
  it("recovers a durable access pending drain and replays its exact outcome", async () => {
    const locks = new ChromiumShapeWebLocks(new FifoWebLocks(), true);
    const value = createDocumentSessionCrossContextCoordination({
      accountId: "account-access-recovery",
      idb: indexedDB,
      locks,
      local: new LocalAuthority(),
      secureContext: true,
      createWakeChannel: null,
    });
    coordinators.push(value);

    await value.admit("project", "doc", "2");
    await expect(value.revokeAccess("project", "doc", "2", "access-2")).rejects.toThrow(
      "injected nonblocking probe interruption",
    );
    await expect(value.revokeAccess("project", "doc", "2", "access-2")).resolves.toEqual({
      revokedThrough: "2",
      persistence: "cleared",
    });
    await expect(value.revokeAccess("project", "doc", "2", "access-2")).resolves.toEqual({
      revokedThrough: "2",
      persistence: "cleared",
    });
  });

  it("keeps terminal revoke pending until a peer destroys and releases its holds", async () => {
    const locks = new FifoWebLocks();
    const wakeBus = new WakeBus();
    const peer = new LocalAuthority();
    let releaseDestroy!: () => void;
    peer.documentDrainBarrier = new Promise<void>((resolve) => {
      releaseDestroy = resolve;
    });
    const a = coordinator("account-terminal-peer", locks, peer, wakeBus);
    const b = coordinator("account-terminal-peer", locks, new LocalAuthority(), wakeBus);
    await a.value.admit("project-a", "doc", "5");
    const revoking = b.value.revokeDocument("project-a", "doc", "5", "terminal-5");
    await peer.documentDrainEntered;
    let settled = false;
    void revoking.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(peer.destroyed).toBe(1);
    releaseDestroy();
    await expect(revoking).resolves.toEqual({ revokedThrough: "5", persistence: "cleared" });
    expect(peer.leases.size).toBe(0);
  });

  it("recovers a dropped wake through an explicit lifecycle scan", async () => {
    const locks = new FifoWebLocks();
    const droppedWake = new WakeBus(false);
    const a = coordinator("account-dropped-wake", locks, new LocalAuthority(), droppedWake);
    const b = coordinator("account-dropped-wake", locks, new LocalAuthority(), droppedWake);
    await a.value.admit("project-a", "doc", "7");
    const revoking = b.value.revokeDocument("project-a", "doc", "7", "terminal-7");
    await droppedWake.posted;
    await a.value.reconcilePending("focus");
    await expect(revoking).resolves.toEqual({ revokedThrough: "7", persistence: "cleared" });
    expect(a.local.leases.size).toBe(0);
  });

  it.each([
    "timer",
    "pageshow",
    "visible",
  ] as const)("recovers a dropped wake through the %s lifecycle trigger", async (trigger) => {
    const testWindow = new EventTarget();
    const testDocument = new EventTarget() as EventTarget & { visibilityState: string };
    testDocument.visibilityState = "visible";
    vi.stubGlobal("window", testWindow);
    vi.stubGlobal("document", testDocument);
    const locks = new FifoWebLocks();
    const droppedWake = new WakeBus(false);
    const holder = coordinator(
      `account-${trigger}-recovery`,
      locks,
      new LocalAuthority(),
      droppedWake,
      trigger === "timer" ? 10 : 60_000,
    );
    const revoker = coordinator(
      `account-${trigger}-recovery`,
      locks,
      new LocalAuthority(),
      droppedWake,
      trigger === "timer" ? 10 : 60_000,
    );
    await holder.value.admit("project", "doc", "7");
    const revoking = revoker.value.revokeDocument("project", "doc", "7", `terminal-${trigger}`);
    await droppedWake.posted;
    if (trigger !== "timer") {
      await expect(
        inspectAuthority(`account-${trigger}-recovery`, (store) => store.readRoom("doc")),
      ).resolves.toMatchObject({ pendingDrain: { generation: "7" } });
      expect(
        locks.history.some(
          ({ event, mode, name }) =>
            event === "grant" && mode === "exclusive" && name.includes("lifecycle"),
        ),
      ).toBe(false);
      if (trigger === "pageshow") testWindow.dispatchEvent(new Event("pageshow"));
      else testDocument.dispatchEvent(new Event("visibilitychange"));
    }
    await expect(revoking).resolves.toEqual({ revokedThrough: "7", persistence: "cleared" });
    expect(holder.local.leases.size).toBe(0);
    if (trigger !== "timer") {
      expect(
        locks.history.some(
          ({ event, mode, name }) =>
            event === "grant" && mode === "exclusive" && name.includes("lifecycle"),
        ),
      ).toBe(true);
      await expect(
        inspectAuthority(`account-${trigger}-recovery`, (store) => store.readRoom("doc")),
      ).resolves.toMatchObject({ pendingDrain: null });
    }
  });

  it("lets a later operation owner help a terminal revoker that crashed during proof", async () => {
    const locks = new FifoWebLocks();
    const crashed = createDocumentSessionCrossContextCoordination({
      accountId: "account-terminal-help",
      idb: indexedDB,
      locks: new FailDocumentProofOnce(locks),
      local: new LocalAuthority(),
      secureContext: true,
      createWakeChannel: null,
    });
    coordinators.push(crashed);
    await expect(crashed.revokeDocument("project", "doc", "5", "terminal-5")).rejects.toThrow(
      "injected terminal owner crash",
    );

    const helper = coordinator("account-terminal-help", locks);
    await expect(helper.value.admit("project", "doc", "5")).rejects.toMatchObject({
      kind: "generation-revoked",
    });
    expect(helper.local.destroyed).toBe(0);
    expect(
      locks.history.filter(
        ({ event, mode, name }) =>
          event === "grant" && mode === "exclusive" && name.includes("document-lifecycle"),
      ),
    ).toHaveLength(1);
  });

  it("unwinds both holds when durable admission commit acknowledgement fails", async () => {
    const accountId = "account-admit-commit-failure";
    const locks = new FifoWebLocks();
    const local = new PersistenceLocalAuthority(accountId);
    const value = createDocumentSessionCrossContextCoordination({
      accountId,
      idb: observedIdb({
        failFirstReadwriteCompletion: new Error(
          "injected durable admission acknowledgement failure",
        ),
      }),
      locks,
      local,
      secureContext: true,
      createWakeChannel: null,
    });
    coordinators.push(value);

    await expect(value.admit("project", "doc", "1")).rejects.toThrow(
      "injected durable admission acknowledgement failure",
    );
    expect(local.installs).toBe(0);
    expect(local.leases.size).toBe(0);
    await vi.waitFor(() =>
      expect(
        locks.history
          .filter(({ event, mode }) => event === "release" && mode === "shared")
          .map(({ name }) => name),
      ).toEqual([
        `meridian:f1d:v1:access-lifecycle/${accountId}/project/doc`,
        `meridian:f1d:v1:document-lifecycle/${accountId}/doc`,
      ]),
    );
    await expect(
      inspectAuthority(accountId, async (store) => ({
        room: await store.readRoom("doc"),
        access: await store.readAccessHead("doc", "project"),
      })),
    ).resolves.toMatchObject({
      room: { persistenceGeneration: "1", documentAdmittedThrough: "1", pendingDrain: null },
      access: "1",
    });
    expect(await persistenceKeys(accountId)).toEqual([]);

    await expect(value.admit("project", "doc", "2")).resolves.toMatchObject({
      generation: "2",
      persistenceGeneration: "1",
    });
    expect(local.installs).toBe(1);
    await vi.waitFor(async () =>
      expect(await persistenceKeys(accountId)).toEqual([
        documentSessionPersistenceKey(accountId, "doc", "1"),
      ]),
    );
  });
});
