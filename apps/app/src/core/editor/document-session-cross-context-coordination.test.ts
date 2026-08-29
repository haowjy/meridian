import "fake-indexeddb/auto";

import type { AccountId } from "@meridian/contracts/protocol";
import type { DocumentId, ProjectId } from "@meridian/contracts/runtime";
import { afterEach, describe, expect, it } from "vitest";
import {
  type CrossContextLockManager,
  createDocumentSessionCrossContextCoordination,
  type LocalSessionAuthority,
} from "./document-session-cross-context-coordination";

class FifoWebLocks implements CrossContextLockManager {
  private readonly active = new Map<string, { shared: number; exclusive: boolean }>();
  private readonly queues = new Map<
    string,
    Array<{
      mode: "shared" | "exclusive";
      run: () => void;
    }>
  >();

  request<T>(
    name: string,
    options: { mode?: "shared" | "exclusive"; ifAvailable?: boolean; signal?: AbortSignal },
    callback: (lock: unknown | null) => T | PromiseLike<T>,
  ): Promise<T> {
    const mode = options.mode ?? "exclusive";
    return new Promise<T>((resolve, reject) => {
      if (options.signal?.aborted) {
        reject(options.signal.reason);
        return;
      }
      const queue = this.queues.get(name) ?? [];
      const availableNow = queue.length === 0 && this.available(name, mode);
      if (options.ifAvailable && !availableNow) {
        void Promise.resolve(callback(null)).then(resolve, reject);
        return;
      }
      const run = () => {
        const state = this.active.get(name) ?? { shared: 0, exclusive: false };
        if (mode === "shared") state.shared += 1;
        else state.exclusive = true;
        this.active.set(name, state);
        void Promise.resolve(callback({ name, mode }))
          .then(resolve, reject)
          .finally(() => {
            const current = this.active.get(name);
            if (current) {
              if (mode === "shared") current.shared -= 1;
              else current.exclusive = false;
              if (current.shared === 0 && !current.exclusive) this.active.delete(name);
            }
            this.pump(name);
          });
      };
      queue.push({ mode, run });
      this.queues.set(name, queue);
      this.pump(name);
    });
  }

  private available(name: string, mode: "shared" | "exclusive"): boolean {
    const state = this.active.get(name) ?? { shared: 0, exclusive: false };
    return mode === "shared" ? !state.exclusive : !state.exclusive && state.shared === 0;
  }

  private pump(name: string): void {
    const queue = this.queues.get(name);
    if (!queue?.length) return;
    while (queue.length > 0 && this.available(name, queue[0]?.mode ?? "exclusive")) {
      const next = queue.shift();
      next?.run();
      if (next?.mode === "exclusive") break;
    }
    if (!queue.length) this.queues.delete(name);
  }
}

class LocalAuthority implements LocalSessionAuthority {
  readonly leases = new Map<
    string,
    { projectId: ProjectId; generation: string; incarnation: string }
  >();
  destroyed = 0;
  documentDrainBarrier: Promise<void> | null = null;
  readonly documentDrainEntered: Promise<void>;
  private enterDocumentDrain!: () => void;

  constructor() {
    this.documentDrainEntered = new Promise<void>((resolve) => {
      this.enterDocumentDrain = resolve;
    });
  }

  validateAdmission() {}
  async retireLegacy(_documentId: DocumentId): Promise<void> {}
  installSynchronously(input: {
    documentId: DocumentId;
    projectId: ProjectId;
    generation: string;
    persistenceGeneration: string;
  }): void {
    this.leases.set(`${input.projectId}/${input.documentId}`, {
      projectId: input.projectId,
      generation: input.generation,
      incarnation: input.persistenceGeneration,
    });
  }
  async drainDocument(input: {
    documentId: DocumentId;
    generation: string;
    incarnation: string | null;
  }) {
    this.enterDocumentDrain();
    for (const [key, lease] of this.leases) {
      if (key.endsWith(`/${input.documentId}`) && lease.incarnation === input.incarnation)
        this.leases.delete(key);
    }
    this.destroyed += 1;
    await this.documentDrainBarrier;
  }
  async drainAccess(input: {
    documentId: DocumentId;
    projectId: ProjectId;
    generation: string;
    incarnation: string | null;
  }) {
    this.leases.delete(`${input.projectId}/${input.documentId}`);
    return [...this.leases.keys()].some((key) => key.endsWith(`/${input.documentId}`))
      ? ("other-local-project-remains" as const)
      : ("locally-empty" as const);
  }
  invalidateAll(): Promise<void> {
    this.leases.clear();
    return Promise.resolve();
  }
}

class WakeBus {
  private readonly listeners = new Set<() => void>();
  readonly posted: Promise<void>;
  private markPosted!: () => void;

  constructor(private readonly deliver = true) {
    this.posted = new Promise<void>((resolve) => {
      this.markPosted = resolve;
    });
  }

  create = (_accountId: AccountId, wake: () => void) => {
    this.listeners.add(wake);
    return {
      post: () => {
        this.markPosted();
        if (this.deliver) for (const listener of this.listeners) queueMicrotask(listener);
      },
      close: () => this.listeners.delete(wake),
    };
  };
}

class FailAccessLockOnce implements CrossContextLockManager {
  private failed = false;
  constructor(private readonly delegate: FifoWebLocks) {}
  request<T>(
    name: string,
    options: { mode?: "shared" | "exclusive"; ifAvailable?: boolean; signal?: AbortSignal },
    callback: (lock: unknown | null) => T | PromiseLike<T>,
  ): Promise<T> {
    if (!this.failed && options.mode === "shared" && name.includes("access-lifecycle")) {
      this.failed = true;
      return Promise.reject(new Error("injected access acquisition failure"));
    }
    return this.delegate.request(name, options, callback);
  }
}

class ChromiumShapeWebLocks implements CrossContextLockManager {
  readonly requests: Array<{
    name: string;
    options: { mode?: "shared" | "exclusive"; ifAvailable?: boolean; signal?: AbortSignal };
  }> = [];

  constructor(
    private readonly delegate: FifoWebLocks,
    private failProbeOnce = false,
  ) {}

  request<T>(
    name: string,
    options: { mode?: "shared" | "exclusive"; ifAvailable?: boolean; signal?: AbortSignal },
    callback: (lock: unknown | null) => T | PromiseLike<T>,
  ): Promise<T> {
    this.requests.push({ name, options });
    if (options.ifAvailable && options.signal) {
      return Promise.reject(
        new DOMException(
          "The 'signal' and 'ifAvailable' options cannot be used together.",
          "NotSupportedError",
        ),
      );
    }
    if (options.ifAvailable && this.failProbeOnce) {
      this.failProbeOnce = false;
      return Promise.reject(new Error("injected nonblocking probe interruption"));
    }
    return this.delegate.request(name, options, callback);
  }
}

const coordinators: Array<{ close(): Promise<void> }> = [];

function coordinator(
  accountId: AccountId,
  locks: FifoWebLocks,
  local = new LocalAuthority(),
  wakeBus: WakeBus | null = null,
) {
  const value = createDocumentSessionCrossContextCoordination({
    accountId,
    idb: indexedDB,
    locks,
    local,
    secureContext: true,
    createWakeChannel: wakeBus?.create ?? null,
    reconcileIntervalMs: 10,
  });
  coordinators.push(value);
  return { value, local };
}

afterEach(async () => {
  await Promise.all(coordinators.splice(0).map((coordinator) => coordinator.close()));
});

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

  it("returns admission while shared lifecycle requests remain held", async () => {
    const locks = new FifoWebLocks();
    const { value } = coordinator("account-lifetime", locks);
    await expect(value.admit("project", "doc", "1")).resolves.toMatchObject({ generation: "1" });
    await expect(value.revokeDocument("project", "doc", "1", "terminal-1")).resolves.toEqual({
      revokedThrough: "1",
      persistence: "cleared",
    });
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
});
