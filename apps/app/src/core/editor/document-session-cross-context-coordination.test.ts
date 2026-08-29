import "fake-indexeddb/auto";

import type { AccountId } from "@meridian/contracts/protocol";
import type { DocumentId, ProjectId } from "@meridian/contracts/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  accessFenceKey,
  DocumentSessionAuthorityStore,
  documentFenceKey,
  documentSessionPersistenceKey,
} from "./document-session-authority-store";
import {
  type CrossContextLockManager,
  createDocumentSessionCrossContextCoordination,
  type LocalSessionAuthority,
} from "./document-session-cross-context-coordination";

class FifoWebLocks implements CrossContextLockManager {
  readonly history: Array<{ event: "request" | "grant" | "release"; name: string; mode: string }> =
    [];
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
    this.history.push({ event: "request", name, mode });
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
        this.history.push({ event: "grant", name, mode });
        const state = this.active.get(name) ?? { shared: 0, exclusive: false };
        if (mode === "shared") state.shared += 1;
        else state.exclusive = true;
        this.active.set(name, state);
        void Promise.resolve(callback({ name, mode }))
          .then(resolve, reject)
          .finally(() => {
            this.history.push({ event: "release", name, mode });
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
  installs = 0;
  invalidated = 0;
  invalidationBarrier: Promise<void> | null = null;
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
    this.installs += 1;
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
  async invalidateAll(): Promise<void> {
    this.invalidated += 1;
    this.leases.clear();
    await this.invalidationBarrier;
  }
}

class PersistenceLocalAuthority extends LocalAuthority {
  constructor(private readonly accountId: AccountId) {
    super();
  }

  override installSynchronously(input: {
    documentId: DocumentId;
    projectId: ProjectId;
    generation: string;
    persistenceGeneration: string;
  }): void {
    super.installSynchronously(input);
    const request = indexedDB.open(
      documentSessionPersistenceKey(this.accountId, input.documentId, input.persistenceGeneration),
    );
    request.onsuccess = () => request.result.close();
  }
}

class WakeBus {
  private readonly listeners = new Set<() => void>();
  readonly posted: Promise<void>;
  private markPosted!: () => void;
  posts = 0;

  constructor(private readonly deliver = true) {
    this.posted = new Promise<void>((resolve) => {
      this.markPosted = resolve;
    });
  }

  create = (_accountId: AccountId, wake: () => void) => {
    this.listeners.add(wake);
    return {
      post: () => {
        this.posts += 1;
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

class FailDocumentProofOnce implements CrossContextLockManager {
  private failed = false;
  constructor(private readonly delegate: FifoWebLocks) {}
  request<T>(
    name: string,
    options: { mode?: "shared" | "exclusive"; ifAvailable?: boolean; signal?: AbortSignal },
    callback: (lock: unknown | null) => T | PromiseLike<T>,
  ): Promise<T> {
    if (!this.failed && options.mode === "exclusive" && name.includes("document-lifecycle")) {
      this.failed = true;
      return Promise.reject(new Error("injected terminal owner crash"));
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
const databases: IDBDatabase[] = [];

function operationName(accountId: AccountId, documentId = "doc"): string {
  return `meridian:f1d:v1:operation/${accountId}/${documentId}`;
}

async function holdExclusive(locks: FifoWebLocks, name: string): Promise<() => void> {
  let release!: () => void;
  let entered!: () => void;
  const granted = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  void locks.request(name, { mode: "exclusive" }, async () => {
    entered();
    await barrier;
  });
  await granted;
  return release;
}

async function inspectAuthority<T>(
  accountId: AccountId,
  inspect: (store: DocumentSessionAuthorityStore) => Promise<T>,
): Promise<T> {
  const store = new DocumentSessionAuthorityStore(accountId, indexedDB);
  try {
    await store.ensureAvailable();
    return await inspect(store);
  } finally {
    await store.close();
  }
}

async function openPersistence(accountId: AccountId, documentId: DocumentId, generation: string) {
  const request = indexedDB.open(documentSessionPersistenceKey(accountId, documentId, generation));
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  databases.push(database);
  return database;
}

async function persistenceKeys(accountId: AccountId, documentId = "doc"): Promise<string[]> {
  return (await indexedDB.databases())
    .flatMap(({ name }) => (name?.includes(`:live/${accountId}/${documentId}/`) ? [name] : []))
    .sort();
}

async function bounded<T>(label: string, promise: Promise<T>): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`timed out: ${label}`)), 1_000),
    ),
  ]);
}

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
  for (const database of databases.splice(0)) database.close();
  await Promise.allSettled(coordinators.splice(0).map((coordinator) => coordinator.close()));
  vi.useRealTimers();
  vi.unstubAllGlobals();
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
    );
    const revoker = coordinator(
      `account-${trigger}-recovery`,
      locks,
      new LocalAuthority(),
      droppedWake,
    );
    await holder.value.admit("project", "doc", "7");
    const revoking = revoker.value.revokeDocument("project", "doc", "7", `terminal-${trigger}`);
    await droppedWake.posted;
    if (trigger === "pageshow") testWindow.dispatchEvent(new Event("pageshow"));
    else if (trigger === "visible") testDocument.dispatchEvent(new Event("visibilitychange"));
    await expect(revoking).resolves.toEqual({ revokedThrough: "7", persistence: "cleared" });
    expect(holder.local.leases.size).toBe(0);
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
    let fail = true;
    const value = createDocumentSessionCrossContextCoordination({
      accountId,
      idb: indexedDB,
      locks,
      local,
      secureContext: true,
      createWakeChannel: null,
      acknowledgeAuthorityCommit: (operation) => {
        if (operation === "admit" && fail) {
          fail = false;
          throw new Error("injected durable admission acknowledgement failure");
        }
      },
    });
    coordinators.push(value);

    await expect(value.admit("project", "doc", "1")).rejects.toThrow(
      "injected durable admission acknowledgement failure",
    );
    expect(local.installs).toBe(0);
    expect(local.leases.size).toBe(0);
    expect(
      locks.history
        .filter(({ event, mode }) => event === "release" && mode === "shared")
        .map(({ name }) => name),
    ).toEqual([
      `meridian:f1d:v1:access-lifecycle/${accountId}/project/doc`,
      `meridian:f1d:v1:document-lifecycle/${accountId}/doc`,
    ]);
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
    const createWorker = () => {
      const local = new LocalAuthority();
      const value = createDocumentSessionCrossContextCoordination({
        accountId,
        idb: indexedDB,
        locks,
        local,
        secureContext: true,
        createWakeChannel: wake.create,
        acknowledgeAuthorityCommit: (operation) => {
          if (operation === "compare-clear-purge") casWinners += 1;
        },
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
