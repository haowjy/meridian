import "fake-indexeddb/auto";

import type { AccountId } from "@meridian/contracts/protocol";
import type { DocumentId, ProjectId } from "@meridian/contracts/runtime";
import { afterEach, vi } from "vitest";
import {
  DocumentSessionAuthorityStore,
  documentSessionPersistenceKey,
} from "./document-session-authority-store";
import {
  type CrossContextLockManager,
  createDocumentSessionCrossContextCoordination,
  type LocalSessionAuthority,
} from "./document-session-cross-context-coordination";

export class FifoWebLocks implements CrossContextLockManager {
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

  activeNames(): string[] {
    return [...this.active.keys()];
  }

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

export class LocalAuthority implements LocalSessionAuthority {
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

export class PersistenceLocalAuthority extends LocalAuthority {
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

export class WakeBus {
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

export class FailAccessLockOnce implements CrossContextLockManager {
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

export class FailDocumentProofOnce implements CrossContextLockManager {
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

export class ChromiumShapeWebLocks implements CrossContextLockManager {
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

export function observedIdb(input: {
  failFirstReadwriteCompletion?: Error;
  onDelete?: (store: string) => void;
}): IDBFactory {
  let failNextReadwrite = input.failFirstReadwriteCompletion;
  const wrapTransaction = (
    transaction: IDBTransaction,
    storeNames: string | Iterable<string>,
  ): IDBTransaction => {
    const names = typeof storeNames === "string" ? [storeNames] : [...storeNames];
    const failure =
      transaction.mode === "readwrite" && names.includes("access-heads")
        ? failNextReadwrite
        : undefined;
    if (failure) failNextReadwrite = undefined;
    let errorHandler: ((event: Event) => unknown) | null = null;
    return new Proxy(transaction, {
      get(target, property) {
        if (property === "error" && failure) return failure;
        if (property === "objectStore") {
          return (name: string) => {
            const store = target.objectStore(name);
            return new Proxy(store, {
              get(storeTarget, storeProperty) {
                if (storeProperty === "delete") {
                  return (key: IDBValidKey | IDBKeyRange) => {
                    input.onDelete?.(name);
                    return storeTarget.delete(key);
                  };
                }
                const value = Reflect.get(storeTarget, storeProperty, storeTarget);
                return typeof value === "function" ? value.bind(storeTarget) : value;
              },
            });
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
      set(target, property, value) {
        if (property === "onerror") {
          errorHandler = value;
          target.onerror = value;
          return true;
        }
        if (property === "oncomplete" && failure) {
          target.oncomplete = (event) => {
            queueMicrotask(() => errorHandler?.call(transaction, event));
          };
          return true;
        }
        return Reflect.set(target, property, value, target);
      },
    });
  };
  const wrapDatabase = (database: IDBDatabase): IDBDatabase =>
    new Proxy(database, {
      get(target, property) {
        if (property === "transaction") {
          return (...args: Parameters<IDBDatabase["transaction"]>) =>
            wrapTransaction(target.transaction(...args), args[0]);
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
      set(target, property, value) {
        return Reflect.set(target, property, value, target);
      },
    });
  return new Proxy(indexedDB, {
    get(target, property) {
      if (property === "open") {
        return (...args: Parameters<IDBFactory["open"]>) => {
          const request = target.open(...args);
          return new Proxy(request, {
            get(requestTarget, requestProperty) {
              if (requestProperty === "result") return wrapDatabase(requestTarget.result);
              const value = Reflect.get(requestTarget, requestProperty, requestTarget);
              return typeof value === "function" ? value.bind(requestTarget) : value;
            },
            set(requestTarget, requestProperty, value) {
              return Reflect.set(requestTarget, requestProperty, value, requestTarget);
            },
          });
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export const coordinators: Array<{ close(): Promise<void> }> = [];
const databases: IDBDatabase[] = [];

export function operationName(accountId: AccountId, documentId = "doc"): string {
  return `meridian:f1d:v1:operation/${accountId}/${documentId}`;
}

export async function holdExclusive(locks: FifoWebLocks, name: string): Promise<() => void> {
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

export async function inspectAuthority<T>(
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

export async function openPersistence(
  accountId: AccountId,
  documentId: DocumentId,
  generation: string,
) {
  const request = indexedDB.open(documentSessionPersistenceKey(accountId, documentId, generation));
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  databases.push(database);
  return database;
}

export async function persistenceKeys(accountId: AccountId, documentId = "doc"): Promise<string[]> {
  return (await indexedDB.databases())
    .flatMap(({ name }) => (name?.includes(`:live/${accountId}/${documentId}/`) ? [name] : []))
    .sort();
}

export async function bounded<T>(label: string, promise: Promise<T>): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`timed out: ${label}`)), 1_000),
    ),
  ]);
}

export function coordinator(
  accountId: AccountId,
  locks: FifoWebLocks,
  local = new LocalAuthority(),
  wakeBus: WakeBus | null = null,
  reconcileIntervalMs = 10,
) {
  const value = createDocumentSessionCrossContextCoordination({
    accountId,
    idb: indexedDB,
    locks,
    local,
    secureContext: true,
    createWakeChannel: wakeBus?.create ?? null,
    reconcileIntervalMs,
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
