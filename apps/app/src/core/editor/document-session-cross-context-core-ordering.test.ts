import "fake-indexeddb/auto";

import { describe, expect, it, vi } from "vitest";
import { createDocumentSessionCrossContextCoordination } from "./document-session-cross-context-coordination";
import {
  ChromiumShapeWebLocks,
  coordinator,
  coordinators,
  FailAccessLockOnce,
  FifoWebLocks,
  LocalAuthority,
  WakeBus,
} from "./document-session-cross-context-coordination.test-support";

describe("document session cross-context coordination", () => {
  it("fails closed before authority storage or local admission when capabilities are absent", async () => {
    const local = new LocalAuthority();
    expect(() =>
      createDocumentSessionCrossContextCoordination({
        accountId: "account-insecure",
        idb: indexedDB,
        locks: new FifoWebLocks(),
        local,
        secureContext: false,
      }),
    ).toThrow(expect.objectContaining({ kind: "authority-unavailable" }));
    expect(() =>
      createDocumentSessionCrossContextCoordination({
        accountId: "account-no-locks",
        idb: indexedDB,
        locks: null,
        local,
        secureContext: true,
      }),
    ).toThrow(expect.objectContaining({ kind: "authority-unavailable" }));
    expect(() =>
      createDocumentSessionCrossContextCoordination({
        accountId: "account-no-idb",
        idb: null,
        locks: new FifoWebLocks(),
        local,
        secureContext: true,
      }),
    ).toThrow(expect.objectContaining({ kind: "authority-unavailable" }));
    expect(local.leases.size).toBe(0);
    expect((await indexedDB.databases()).map(({ name }) => name)).not.toContain(
      "meridian:document-session-authority:account-insecure",
    );
  });

  it("normalizes a synchronous authority open failure and tears down once", async () => {
    const local = new LocalAuthority();
    const idb = {
      open: () => {
        throw new Error("open exploded");
      },
    } as unknown as IDBFactory;
    const value = createDocumentSessionCrossContextCoordination({
      accountId: "account-open-failure",
      idb,
      locks: new FifoWebLocks(),
      local,
      secureContext: true,
      createWakeChannel: null,
    });
    coordinators.push(value);

    await expect(value.admit("project", "doc", "1")).rejects.toMatchObject({
      kind: "authority-unavailable",
    });
    expect(local.invalidated).toBe(1);
    expect(local.leases.size).toBe(0);
  });

  it.each([
    "error",
    "blocked",
  ] as const)("normalizes an asynchronous authority open %s", async (failure) => {
    const local = new LocalAuthority();
    const request: Record<string, unknown> = {
      error: new Error(`open ${failure}`),
    };
    const idb = {
      open: () => {
        queueMicrotask(() => {
          const handler = request[failure === "error" ? "onerror" : "onblocked"];
          if (typeof handler === "function") handler();
        });
        return request;
      },
    } as unknown as IDBFactory;
    const value = createDocumentSessionCrossContextCoordination({
      accountId: `account-open-${failure}`,
      idb,
      locks: new FifoWebLocks(),
      local,
      secureContext: true,
      createWakeChannel: null,
    });
    coordinators.push(value);
    await expect(value.admit("project", "doc", "1")).rejects.toMatchObject({
      kind: "authority-unavailable",
    });
    expect(local.invalidated).toBe(1);
  });

  it("normalizes a failed read/write authority transaction", async () => {
    const local = new LocalAuthority();
    const database = {
      close: () => undefined,
      transaction: () => {
        throw new Error("readwrite denied");
      },
    };
    const request: Record<string, unknown> = { result: database, error: null };
    const idb = {
      open: () => {
        queueMicrotask(() => {
          const handler = request.onsuccess;
          if (typeof handler === "function") handler();
        });
        return request;
      },
    } as unknown as IDBFactory;
    const value = createDocumentSessionCrossContextCoordination({
      accountId: "account-transaction-failure",
      idb,
      locks: new FifoWebLocks(),
      local,
      secureContext: true,
      createWakeChannel: null,
    });
    coordinators.push(value);
    await expect(value.admit("project", "doc", "1")).rejects.toMatchObject({
      kind: "authority-unavailable",
    });
    expect(local.leases.size).toBe(0);
  });

  it("ignores an optional wake-channel construction failure", async () => {
    const { value } = coordinator("account-channel-failure", new FifoWebLocks());
    const isolated = createDocumentSessionCrossContextCoordination({
      accountId: "account-channel-failure-2",
      idb: indexedDB,
      locks: new FifoWebLocks(),
      local: new LocalAuthority(),
      secureContext: true,
      createWakeChannel: () => {
        throw new Error("channel denied");
      },
    });
    coordinators.push(isolated);
    await expect(value.admit("project", "doc", "1")).resolves.toMatchObject({ generation: "1" });
    await expect(isolated.admit("project", "doc", "1")).resolves.toMatchObject({
      generation: "1",
    });
  });

  it("keeps an authority upgrade blocked until local teardown releases lifecycle holds", async () => {
    const locks = new FifoWebLocks();
    const local = new LocalAuthority();
    let releaseInvalidation!: () => void;
    local.invalidationBarrier = new Promise<void>((resolve) => {
      releaseInvalidation = resolve;
    });
    const accountId = "account-versionchange-order";
    const { value } = coordinator(accountId, locks, local);
    await value.admit("project", "doc", "1");

    const upgrade = indexedDB.open(`meridian:document-session-authority:${accountId}`, 3);
    let upgraded = false;
    upgrade.onsuccess = () => {
      upgraded = true;
      upgrade.result.close();
    };
    await vi.waitFor(() => expect(local.invalidated).toBe(1));
    await Promise.resolve();
    expect(upgraded).toBe(false);
    releaseInvalidation();
    await vi.waitFor(() => expect(upgraded).toBe(true));
  });

  it("owns a rejecting versionchange close while joiners retain its diagnostic", async () => {
    const accountId = "account-versionchange-rejection";
    const locks = new FifoWebLocks();
    const diagnostic = new Error("provider destroy failed on versionchange");
    class RejectingLocalAuthority extends LocalAuthority {
      override async invalidateAll(): Promise<void> {
        await super.invalidateAll();
        throw diagnostic;
      }
    }
    const local = new RejectingLocalAuthority();
    const { value } = coordinator(accountId, locks, local);
    await value.admit("project", "doc", "1");
    expect(locks.activeNames()).toHaveLength(2);
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
      await vi.waitFor(() => expect(local.invalidated).toBe(1));
      const joiningClose = value.close();
      const joinedDiagnostic = await joiningClose.catch((error: unknown) => error);
      expect(joinedDiagnostic).toBe(diagnostic);
      await upgraded;
      expect(local.leases.size).toBe(0);
      expect(locks.activeNames()).toEqual([]);

      const recovery = coordinator("account-versionchange-recovery", locks, new LocalAuthority());
      await expect(recovery.value.admit("project", "doc", "1")).resolves.toMatchObject({
        accountId: "account-versionchange-recovery",
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", observeUnhandled);
    }
  });

  it("returns admission while shared lifecycle requests remain held", async () => {
    const locks = new FifoWebLocks();
    const { value } = coordinator("account-lifetime", locks);
    await expect(value.admit("project", "doc", "1")).resolves.toMatchObject({ generation: "1" });
    await expect(value.revokeDocument("project", "doc", "1", "terminal-1")).resolves.toEqual({
      revokedThrough: "1",
      persistence: "cleared",
    });
  });

  it("queues operation authority before any lifecycle-exclusive proof", async () => {
    const locks = new FifoWebLocks();
    const { value } = coordinator("account-lock-order", locks);
    await value.admit("project", "doc", "1");
    await value.revokeDocument("project", "doc", "1", "terminal-1");
    const exclusiveRequests = locks.history.filter(
      ({ event, mode }) => event === "request" && mode === "exclusive",
    );
    expect(exclusiveRequests.map(({ name }) => name)).toEqual([
      "meridian:f1d:v1:operation/account-lock-order/doc",
      "meridian:f1d:v1:operation/account-lock-order/doc",
      "meridian:f1d:v1:document-lifecycle/account-lock-order/doc",
      "meridian:f1d:v1:operation/account-lock-order/doc",
    ]);
  });

  it.each([
    "document",
    "access",
  ] as const)("rejects an old %s command without drain, wake, or lifecycle exclusion", async (kind) => {
    const locks = new FifoWebLocks();
    const wake = new WakeBus(false);
    const { value, local } = coordinator(`account-old-${kind}`, locks, new LocalAuthority(), wake);
    await value.admit("project", "doc", "10");
    const operation =
      kind === "document"
        ? value.revokeDocument("project", "doc", "9", "terminal-9")
        : value.revokeAccess("project", "doc", "9", "access-9");
    await expect(operation).rejects.toMatchObject({ kind: "older-command" });
    expect(local.destroyed).toBe(0);
    expect(wake.posts).toBe(0);
    expect(
      locks.history.some(
        ({ event, mode, name }) =>
          event === "request" && mode === "exclusive" && name.includes("lifecycle"),
      ),
    ).toBe(false);
  });

  it("releases a sole project's document hold before its access hold", async () => {
    const locks = new FifoWebLocks();
    const { value } = coordinator("account-sole-access", locks);
    await value.admit("project-b", "doc", "5");
    await expect(value.revokeAccess("project-b", "doc", "5", "access-b-5")).resolves.toEqual({
      revokedThrough: "5",
      persistence: "cleared",
    });
    const releases = locks.history
      .filter(({ event, mode }) => event === "release" && mode === "shared")
      .map(({ name }) => name);
    expect(releases).toEqual([
      "meridian:f1d:v1:document-lifecycle/account-sole-access/doc",
      "meridian:f1d:v1:access-lifecycle/account-sole-access/project-b/doc",
    ]);
  });

  it("unwinds a partial HD acquisition so later lifecycle exclusion grants", async () => {
    const locks = new FifoWebLocks();
    const local = new LocalAuthority();
    const value = createDocumentSessionCrossContextCoordination({
      accountId: "account-partial-acquire",
      idb: indexedDB,
      locks: new FailAccessLockOnce(locks),
      local,
      secureContext: true,
      createWakeChannel: null,
    });
    coordinators.push(value);
    await expect(value.admit("project", "doc", "1")).rejects.toThrow(
      "injected access acquisition failure",
    );
    expect(local.leases.size).toBe(0);
    await expect(
      locks.request(
        "meridian:f1d:v1:document-lifecycle/account-partial-acquire/doc",
        { mode: "exclusive" },
        async (lock) => Boolean(lock),
      ),
    ).resolves.toBe(true);
  });

  it("shares one durable incarnation across independently constructed coordinators", async () => {
    const locks = new FifoWebLocks();
    const first = coordinator("account-shared-incarnation", locks);
    const second = coordinator("account-shared-incarnation", locks);
    const [a, b] = await Promise.all([
      first.value.admit("project-a", "doc", "3"),
      second.value.admit("project-b", "doc", "4"),
    ]);
    expect(a.persistenceGeneration).toBe("3");
    expect(b.persistenceGeneration).toBe("3");
  });

  it("retains A when B access is revoked in another coordinator", async () => {
    const locks = new FifoWebLocks();
    const a = coordinator("account-access", locks);
    const b = coordinator("account-access", locks);
    await a.value.admit("project-a", "doc", "3");
    await b.value.admit("project-b", "doc", "4");
    const revoking = b.value.revokeAccess("project-b", "doc", "4", "access-b-4");
    await a.value.reconcilePending("scan");
    await expect(revoking).resolves.toEqual({
      revokedThrough: "4",
      persistence: "retained-by-other-lease",
    });
    expect(a.local.leases.size).toBe(1);
    expect(b.local.leases.size).toBe(0);
  });

  it("uses Chromium-compatible options for nonblocking probes and aborts queued requests", async () => {
    const locks = new ChromiumShapeWebLocks(new FifoWebLocks());
    const value = createDocumentSessionCrossContextCoordination({
      accountId: "account-native-options",
      idb: indexedDB,
      locks,
      local: new LocalAuthority(),
      secureContext: true,
      createWakeChannel: null,
    });
    coordinators.push(value);

    await value.admit("project", "doc", "1");
    await expect(value.revokeAccess("project", "doc", "1", "access-1")).resolves.toEqual({
      revokedThrough: "1",
      persistence: "cleared",
    });

    const nonblocking = locks.requests.filter(({ options }) => options.ifAvailable);
    expect(nonblocking).toHaveLength(1);
    expect(nonblocking[0]?.options).toEqual({ mode: "exclusive", ifAvailable: true });
    expect(
      locks.requests
        .filter(({ options }) => !options.ifAvailable)
        .every(({ options }) => options.signal instanceof AbortSignal),
    ).toBe(true);
  });
});
