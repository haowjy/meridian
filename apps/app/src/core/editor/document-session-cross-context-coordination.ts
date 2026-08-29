/** Cross-context live-document authority: durable ordering plus Web Locks lifecycle proof. */
import type {
  AccountId,
  AvailabilityCommandId,
  AvailabilityGeneration,
  LiveDocumentSessionLease,
} from "@meridian/contracts/protocol";
import type { DocumentId, ProjectId } from "@meridian/contracts/runtime";

import {
  compareAvailabilityGeneration,
  DocumentSessionAuthorityStore,
  type PendingDrain,
} from "./document-session-authority-store";

const LOCK_PREFIX = "meridian:f1d:v1:";
const PENDING_DRAIN_RECONCILE_MS = 5_000;

type LockMode = "shared" | "exclusive";
type LockRequestOptions =
  | { mode?: LockMode; signal?: AbortSignal; ifAvailable?: never }
  | { mode?: LockMode; ifAvailable: true; signal?: never };

export interface CrossContextLockManager {
  request<T>(
    name: string,
    options: LockRequestOptions,
    callback: (lock: unknown | null) => T | PromiseLike<T>,
  ): Promise<T>;
}

export interface LocalSessionAuthority {
  validateAdmission(input: {
    documentId: DocumentId;
    projectId: ProjectId;
    generation: AvailabilityGeneration;
  }): void;
  retireLegacy(documentId: DocumentId): Promise<void>;
  installSynchronously(input: {
    documentId: DocumentId;
    projectId: ProjectId;
    generation: AvailabilityGeneration;
    persistenceGeneration: AvailabilityGeneration;
  }): void;
  drainDocument(input: {
    documentId: DocumentId;
    generation: AvailabilityGeneration;
    incarnation: AvailabilityGeneration | null;
  }): Promise<void>;
  drainAccess(input: {
    documentId: DocumentId;
    projectId: ProjectId;
    generation: AvailabilityGeneration;
    incarnation: AvailabilityGeneration | null;
  }): Promise<"other-local-project-remains" | "locally-empty">;
  invalidateAll(): Promise<void>;
}

type WakeChannel = { post(): void; close(): void };
type LifetimeHold = {
  release(): Promise<void>;
};
type DocumentHolds = {
  document: LifetimeHold;
  projects: Map<ProjectId, LifetimeHold>;
};
type LocalAdmission = {
  generation: AvailabilityGeneration;
  incarnation: AvailabilityGeneration;
};

export class DocumentSessionCoordinationError extends Error {
  constructor(
    readonly kind:
      | "authority-unavailable"
      | "generation-revoked"
      | "older-command"
      | "command-collision"
      | "purge-pending"
      | "account-mismatch",
    message: string,
  ) {
    super(message);
    this.name = "DocumentSessionCoordinationError";
  }
}

export interface DocumentSessionCrossContextCoordination {
  admit(
    projectId: ProjectId,
    documentId: DocumentId,
    generation: AvailabilityGeneration,
  ): Promise<LiveDocumentSessionLease & { persistenceGeneration: AvailabilityGeneration }>;
  revokeDocument(
    projectId: ProjectId,
    documentId: DocumentId,
    generation: AvailabilityGeneration,
    commandId: AvailabilityCommandId,
  ): Promise<{ revokedThrough: AvailabilityGeneration; persistence: "cleared" }>;
  revokeAccess(
    projectId: ProjectId,
    documentId: DocumentId,
    generation: AvailabilityGeneration,
    commandId: AvailabilityCommandId,
  ): Promise<{
    revokedThrough: AvailabilityGeneration;
    persistence: "cleared" | "retained-by-other-lease";
  }>;
  reconcilePending(
    reason: "scan" | "broadcast" | "focus" | "pageshow" | "visible" | "operation" | "account-close",
  ): Promise<void>;
  close(): Promise<void>;
}

function encoded(value: string): string {
  return encodeURIComponent(value);
}

function operationLock(accountId: AccountId, documentId: DocumentId): string {
  return `${LOCK_PREFIX}operation/${encoded(accountId)}/${encoded(documentId)}`;
}

function documentLifecycleLock(accountId: AccountId, documentId: DocumentId): string {
  return `${LOCK_PREFIX}document-lifecycle/${encoded(accountId)}/${encoded(documentId)}`;
}

function accessLifecycleLock(
  accountId: AccountId,
  projectId: ProjectId,
  documentId: DocumentId,
): string {
  return `${LOCK_PREFIX}access-lifecycle/${encoded(accountId)}/${encoded(projectId)}/${encoded(documentId)}`;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function nativeLocks(): CrossContextLockManager | null {
  if (typeof navigator === "undefined") return null;
  const manager = navigator.locks;
  if (!manager || typeof manager.request !== "function") return null;
  return {
    request: (name, options, callback) =>
      manager.request(
        name,
        options as LockOptions,
        callback as (lock: Lock | null) => unknown,
      ) as Promise<never>,
  };
}

function nativeWakeChannel(accountId: AccountId, wake: () => void): WakeChannel | null {
  if (typeof BroadcastChannel !== "function") return null;
  let channel: BroadcastChannel;
  try {
    channel = new BroadcastChannel(`${LOCK_PREFIX}wake/${encoded(accountId)}`);
  } catch {
    return null;
  }
  channel.onmessage = wake;
  return {
    post: () => channel.postMessage({ wake: true }),
    close: () => channel.close(),
  };
}

class Coordination implements DocumentSessionCrossContextCoordination {
  private readonly store: DocumentSessionAuthorityStore;
  private readonly abort = new AbortController();
  private readonly holds = new Map<DocumentId, DocumentHolds>();
  private readonly admissions = new Map<DocumentId, Map<ProjectId, LocalAdmission>>();
  private readonly wakeChannel: WakeChannel | null;
  private reconcilePromise: Promise<void> | null = null;
  private readonly readiness: Promise<void>;
  private closePromise: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private versionChanged = false;
  private readonly removeLifecycleListeners: () => void;

  constructor(
    private readonly accountId: AccountId,
    idb: IDBFactory,
    private readonly locks: CrossContextLockManager,
    private readonly local: LocalSessionAuthority,
    private readonly intervalMs: number,
    createWakeChannel: ((accountId: AccountId, wake: () => void) => WakeChannel | null) | null,
  ) {
    this.store = new DocumentSessionAuthorityStore(
      accountId,
      idb,
      () => {
        this.versionChanged = true;
        void this.close();
      },
      () => {
        void this.reconcilePending("operation").catch(() => undefined);
      },
    );
    this.readiness = this.store.ensureAvailable().catch((error) => {
      throw new DocumentSessionCoordinationError(
        "authority-unavailable",
        error instanceof Error
          ? `Live document authority is unavailable: ${error.message}`
          : "Live document authority is unavailable",
      );
    });
    let wakeChannel: WakeChannel | null = null;
    try {
      wakeChannel =
        createWakeChannel?.(accountId, () => {
          void this.reconcilePending("broadcast").catch(() => undefined);
        }) ?? null;
    } catch {
      // Wake delivery is advisory; durable reconciliation remains authoritative.
    }
    this.wakeChannel = wakeChannel;
    this.removeLifecycleListeners = this.installLifecycleListeners();
  }

  async admit(
    projectId: ProjectId,
    documentId: DocumentId,
    generation: AvailabilityGeneration,
  ): Promise<LiveDocumentSessionLease & { persistenceGeneration: AvailabilityGeneration }> {
    await this.requireReady();
    this.assertOpen();
    for (;;) {
      let barrier: AvailabilityGeneration | null = null;
      let installed:
        | (LiveDocumentSessionLease & { persistenceGeneration: AvailabilityGeneration })
        | null = null;
      await this.withOperation(documentId, async () => {
        await this.helpPendingUnderOperation(documentId);
        this.assertOpen();
        await this.local.retireLegacy(documentId);
        this.assertOpen();
        this.local.validateAdmission({ documentId, projectId, generation });
        const acquired = await this.ensureSharedHolds(documentId, projectId);
        try {
          const decision = await this.store.admit({ documentId, projectId, generation });
          if (decision.kind === "generation-revoked") {
            throw new DocumentSessionCoordinationError(
              "generation-revoked",
              `Generation ${generation} is revoked for ${documentId}`,
            );
          }
          if (decision.kind === "pending") {
            throw new Error("Pending drain survived operation help");
          }
          if (decision.kind === "purge-barrier") {
            barrier = decision.purgeThrough;
            await this.releaseNewHolds(documentId, projectId, acquired);
            return;
          }
          this.assertOpen();
          const lease = { accountId: this.accountId, projectId, documentId, generation };
          this.local.installSynchronously({
            documentId,
            projectId,
            generation,
            persistenceGeneration: decision.persistenceGeneration,
          });
          let projects = this.admissions.get(documentId);
          if (!projects) {
            projects = new Map();
            this.admissions.set(documentId, projects);
          }
          projects.set(projectId, {
            generation,
            incarnation: decision.persistenceGeneration,
          });
          installed = { ...lease, persistenceGeneration: decision.persistenceGeneration };
        } catch (error) {
          await this.releaseNewHolds(documentId, projectId, acquired);
          throw error;
        }
      });
      if (installed) {
        this.scheduleScan();
        return installed;
      }
      if (!barrier || !(await this.runPurgeWorker(documentId))) {
        throw new DocumentSessionCoordinationError(
          "purge-pending",
          `Persistence purge is pending for ${documentId}`,
        );
      }
    }
  }

  async revokeDocument(
    _projectId: ProjectId,
    documentId: DocumentId,
    generation: AvailabilityGeneration,
    commandId: AvailabilityCommandId,
  ): Promise<{ revokedThrough: AvailabilityGeneration; persistence: "cleared" }> {
    await this.requireReady();
    this.assertOpen();
    await this.withOperation(documentId, async () => {
      await this.helpPendingUnderOperation(documentId);
      const start = await this.store.startDocumentDrain({ documentId, generation, commandId });
      this.assertStartAccepted(start, documentId, generation);
      if (start.kind === "started") {
        this.signalWake();
        await this.drainLocal(documentId, start.pending);
        await this.withExclusiveLifecycle(
          documentLifecycleLock(this.accountId, documentId),
          async () => {
            await this.store.finishDocumentDrain({ documentId, generation, commandId });
          },
        );
      }
    });
    if (!(await this.runPurgeWorker(documentId))) {
      throw new DocumentSessionCoordinationError(
        "purge-pending",
        `Persistence purge is pending for ${documentId}`,
      );
    }
    return { revokedThrough: generation, persistence: "cleared" };
  }

  async revokeAccess(
    projectId: ProjectId,
    documentId: DocumentId,
    generation: AvailabilityGeneration,
    commandId: AvailabilityCommandId,
  ): Promise<{
    revokedThrough: AvailabilityGeneration;
    persistence: "cleared" | "retained-by-other-lease";
  }> {
    await this.requireReady();
    this.assertOpen();
    let persistence: "cleared" | "retained-by-other-lease" = "cleared";
    await this.withOperation(documentId, async () => {
      await this.helpPendingUnderOperation(documentId);
      const start = await this.store.startAccessDrain({
        documentId,
        projectId,
        generation,
        commandId,
      });
      this.assertStartAccepted(start, documentId, generation);
      if (start.kind === "replay") {
        if (!start.persistence) throw new Error("Access replay has no stored outcome");
        persistence = start.persistence;
        return;
      }
      if (start.kind !== "started") return;
      this.signalWake();
      await this.drainLocal(documentId, start.pending);
      await this.withExclusiveLifecycle(
        accessLifecycleLock(this.accountId, projectId, documentId),
        async () => {
          const noDocumentHolder = await this.tryExclusiveLifecycle(
            documentLifecycleLock(this.accountId, documentId),
            async () => {
              persistence = "cleared";
              await this.store.finishAccessDrain({
                documentId,
                projectId,
                generation,
                commandId,
                persistence,
              });
            },
          );
          if (!noDocumentHolder) {
            persistence = "retained-by-other-lease";
            await this.store.finishAccessDrain({
              documentId,
              projectId,
              generation,
              commandId,
              persistence,
            });
          }
        },
      );
    });
    if (persistence === "cleared" && !(await this.runPurgeWorker(documentId))) {
      throw new DocumentSessionCoordinationError(
        "purge-pending",
        `Persistence purge is pending for ${documentId}`,
      );
    }
    return { revokedThrough: generation, persistence };
  }

  async reconcilePending(
    _reason:
      | "scan"
      | "broadcast"
      | "focus"
      | "pageshow"
      | "visible"
      | "operation"
      | "account-close",
  ): Promise<void> {
    if (_reason !== "account-close") await this.requireReady();
    if (this.closed && _reason !== "account-close") return;
    if (this.reconcilePromise) return this.reconcilePromise;
    const reconciliation = this.runReconciliation();
    this.reconcilePromise = reconciliation;
    try {
      await reconciliation;
    } finally {
      if (this.reconcilePromise === reconciliation) this.reconcilePromise = null;
      this.scheduleScan();
    }
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.abort.abort(new Error("Document authority closed"));
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.removeLifecycleListeners();
    this.wakeChannel?.close();
    const close = this.finishClose();
    this.closePromise = close;
    return close;
  }

  private async finishClose(): Promise<void> {
    let available = false;
    try {
      await this.readiness;
      available = true;
    } catch {
      // Failed readiness still owns the same local teardown barrier.
    }
    if (available && !this.versionChanged) {
      try {
        await this.reconcilePending("account-close");
      } catch {
        // Account teardown still invalidates every local room and releases its proof holds.
      }
    }
    await this.local.invalidateAll();
    await this.releaseAllHolds();
    await this.store.close();
  }

  private async requireReady(): Promise<void> {
    try {
      await this.readiness;
    } catch (error) {
      await this.close();
      throw error;
    }
    this.assertOpen();
  }

  private async runReconciliation(): Promise<void> {
    const rooms = await this.store.listPendingDrains();
    for (const room of rooms) {
      if (room.pendingDrain) await this.drainLocal(room.documentId, room.pendingDrain);
    }
    for (const room of rooms) {
      if (!room.pendingDrain) continue;
      await this.withOperation(room.documentId, async () => {
        await this.helpPendingUnderOperation(room.documentId);
      });
      await this.runPurgeWorker(room.documentId);
    }
    for (const purge of await this.store.pendingPurges()) {
      await this.runPurgeWorker(purge.documentId);
    }
  }

  private async helpPendingUnderOperation(documentId: DocumentId): Promise<void> {
    const pending = (await this.store.readRoom(documentId)).pendingDrain;
    if (!pending) return;
    this.signalWake();
    await this.drainLocal(documentId, pending);
    if (pending.kind === "document") {
      await this.withExclusiveLifecycle(
        documentLifecycleLock(this.accountId, documentId),
        async () => {
          await this.store.finishDocumentDrain({
            documentId,
            generation: pending.generation,
            commandId: pending.commandId,
          });
        },
      );
      return;
    }
    await this.withExclusiveLifecycle(
      accessLifecycleLock(this.accountId, pending.projectId, documentId),
      async () => {
        const cleared = await this.tryExclusiveLifecycle(
          documentLifecycleLock(this.accountId, documentId),
          async () => {
            await this.store.finishAccessDrain({
              documentId,
              projectId: pending.projectId,
              generation: pending.generation,
              commandId: pending.commandId,
              persistence: "cleared",
            });
          },
        );
        if (!cleared) {
          await this.store.finishAccessDrain({
            documentId,
            projectId: pending.projectId,
            generation: pending.generation,
            commandId: pending.commandId,
            persistence: "retained-by-other-lease",
          });
        }
      },
    );
  }

  private async drainLocal(documentId: DocumentId, pending: PendingDrain): Promise<void> {
    const projects = this.admissions.get(documentId);
    if (!projects) return;
    if (pending.kind === "document") {
      const matching = [...projects.entries()].filter(([, admission]) => {
        if (admission.incarnation !== pending.incarnation) return false;
        if (compareAvailabilityGeneration(admission.generation, pending.generation) > 0) {
          throw new Error("A newer local admission conflicts with a pending document drain");
        }
        return true;
      });
      if (!matching.length) return;
      await this.local.drainDocument({
        documentId,
        generation: pending.generation,
        incarnation: pending.incarnation,
      });
      const holds = this.holds.get(documentId);
      for (const [projectId] of matching) {
        projects.delete(projectId);
        const hold = holds?.projects.get(projectId);
        holds?.projects.delete(projectId);
        await hold?.release();
      }
      if (projects.size === 0) {
        this.admissions.delete(documentId);
        this.holds.delete(documentId);
        await holds?.document.release();
      }
      return;
    }
    const admission = projects.get(pending.projectId);
    if (!admission || admission.incarnation !== pending.incarnation) return;
    if (compareAvailabilityGeneration(admission.generation, pending.generation) > 0) {
      throw new Error("A newer local admission conflicts with a pending access drain");
    }
    const disposition = await this.local.drainAccess({
      documentId,
      projectId: pending.projectId,
      generation: pending.generation,
      incarnation: pending.incarnation,
    });
    projects.delete(pending.projectId);
    const holds = this.holds.get(documentId);
    const accessHold = holds?.projects.get(pending.projectId);
    holds?.projects.delete(pending.projectId);
    if (disposition === "locally-empty") {
      this.admissions.delete(documentId);
      this.holds.delete(documentId);
      await holds?.document.release();
      await accessHold?.release();
    } else {
      await accessHold?.release();
    }
  }

  private async ensureSharedHolds(
    documentId: DocumentId,
    projectId: ProjectId,
  ): Promise<{ document: boolean; access: boolean }> {
    let holds = this.holds.get(documentId);
    let documentAcquired = false;
    if (!holds) {
      const document = await this.acquireLifetime(
        documentLifecycleLock(this.accountId, documentId),
      );
      holds = { document, projects: new Map() };
      this.holds.set(documentId, holds);
      documentAcquired = true;
    }
    if (holds.projects.has(projectId)) return { document: documentAcquired, access: false };
    try {
      holds.projects.set(
        projectId,
        await this.acquireLifetime(accessLifecycleLock(this.accountId, projectId, documentId)),
      );
      return { document: documentAcquired, access: true };
    } catch (error) {
      if (documentAcquired) {
        this.holds.delete(documentId);
        await holds.document.release();
      }
      throw error;
    }
  }

  private async releaseNewHolds(
    documentId: DocumentId,
    projectId: ProjectId,
    acquired: { document: boolean; access: boolean },
  ): Promise<void> {
    const holds = this.holds.get(documentId);
    if (!holds) return;
    if (acquired.access) {
      const access = holds.projects.get(projectId);
      holds.projects.delete(projectId);
      await access?.release();
    }
    if (acquired.document) {
      this.holds.delete(documentId);
      await holds.document.release();
    }
  }

  private async acquireLifetime(name: string): Promise<LifetimeHold> {
    const acquired = deferred<void>();
    const released = deferred<void>();
    let callbackEntered = false;
    const lifetime = this.locks.request(
      name,
      { mode: "shared", signal: this.abort.signal },
      async (lock) => {
        if (!lock) throw new Error(`Shared lifecycle lock unavailable: ${name}`);
        callbackEntered = true;
        acquired.resolve();
        await released.promise;
      },
    );
    void lifetime.catch((error) => {
      if (!callbackEntered) acquired.reject(error);
    });
    await acquired.promise;
    let releasePromise: Promise<void> | null = null;
    return {
      release: () => {
        if (!releasePromise) {
          released.resolve();
          releasePromise = lifetime;
        }
        return releasePromise;
      },
    };
  }

  private withOperation<T>(documentId: DocumentId, callback: () => Promise<T>): Promise<T> {
    return this.locks.request(
      operationLock(this.accountId, documentId),
      { mode: "exclusive", signal: this.abort.signal },
      async (lock) => {
        if (!lock) throw new Error("Operation lock unexpectedly unavailable");
        this.assertOpen();
        return callback();
      },
    );
  }

  private withExclusiveLifecycle<T>(name: string, callback: () => Promise<T>): Promise<T> {
    return this.locks.request(
      name,
      { mode: "exclusive", signal: this.abort.signal },
      async (lock) => {
        if (!lock) throw new Error("Lifecycle lock unexpectedly unavailable");
        return callback();
      },
    );
  }

  private async tryExclusiveLifecycle(
    name: string,
    callback: () => Promise<void>,
  ): Promise<boolean> {
    return this.locks.request(name, { mode: "exclusive", ifAvailable: true }, async (lock) => {
      if (!lock) return false;
      await callback();
      return true;
    });
  }

  private async runPurgeWorker(documentId: DocumentId): Promise<boolean> {
    const snapshot = await this.withOperation(documentId, () =>
      this.store.snapshotPurge(documentId),
    );
    if (!snapshot) return true;
    if (!(await this.store.deletePersistenceThrough(snapshot))) return false;
    return this.store.compareClearPurge(snapshot);
  }

  private assertStartAccepted(
    start: Awaited<ReturnType<DocumentSessionAuthorityStore["startDocumentDrain"]>>,
    documentId: DocumentId,
    generation: AvailabilityGeneration,
  ): void {
    if (start.kind === "older") {
      throw new DocumentSessionCoordinationError(
        "older-command",
        `Command ${generation} is older for ${documentId}`,
      );
    }
    if (start.kind === "collision") {
      throw new DocumentSessionCoordinationError(
        "command-collision",
        `A different command already owns generation ${generation} for ${documentId}`,
      );
    }
    if (start.kind === "pending") throw new Error("Pending drain survived operation help");
  }

  private signalWake(): void {
    try {
      this.wakeChannel?.post();
    } catch {
      // The channel is advisory; durable scans own recovery.
    }
  }

  private scheduleScan(): void {
    if (this.closed || this.holds.size === 0 || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.reconcilePending("scan").catch(() => undefined);
    }, this.intervalMs);
  }

  private installLifecycleListeners(): () => void {
    if (typeof window === "undefined" || typeof document === "undefined") return () => undefined;
    const focus = () => void this.reconcilePending("focus").catch(() => undefined);
    const pageshow = () => void this.reconcilePending("pageshow").catch(() => undefined);
    const visibility = () => {
      if (document.visibilityState === "visible")
        void this.reconcilePending("visible").catch(() => undefined);
    };
    window.addEventListener("focus", focus);
    window.addEventListener("pageshow", pageshow);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      window.removeEventListener("focus", focus);
      window.removeEventListener("pageshow", pageshow);
      document.removeEventListener("visibilitychange", visibility);
    };
  }

  private async releaseAllHolds(): Promise<void> {
    const holds = [...this.holds.values()];
    this.holds.clear();
    this.admissions.clear();
    for (const document of holds) {
      for (const access of document.projects.values()) await access.release();
      await document.document.release();
    }
  }

  private assertOpen(): void {
    if (this.closed || this.versionChanged) {
      throw new DocumentSessionCoordinationError(
        "account-mismatch",
        "Document authority is closed or changed",
      );
    }
  }
}

export function createDocumentSessionCrossContextCoordination(input: {
  accountId: AccountId;
  local: LocalSessionAuthority;
  idb?: IDBFactory | null;
  locks?: CrossContextLockManager | null;
  secureContext?: boolean;
  createWakeChannel?: ((accountId: AccountId, wake: () => void) => WakeChannel | null) | null;
  reconcileIntervalMs?: number;
}): DocumentSessionCrossContextCoordination {
  const secure = input.secureContext ?? globalThis.isSecureContext === true;
  const locks = input.locks === undefined ? nativeLocks() : input.locks;
  const idb = input.idb === undefined ? globalThis.indexedDB : input.idb;
  if (!secure || !locks || !idb) {
    throw new DocumentSessionCoordinationError(
      "authority-unavailable",
      "Secure Web Locks and IndexedDB are required for live document authority",
    );
  }
  return new Coordination(
    input.accountId,
    idb,
    locks,
    input.local,
    input.reconcileIntervalMs ?? PENDING_DRAIN_RECONCILE_MS,
    input.createWakeChannel === undefined ? nativeWakeChannel : input.createWakeChannel,
  );
}
