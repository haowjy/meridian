/**
 * Untitled reconciler — drains the crash-safe list of locally-authored documents.
 *
 * The persisted registry is the only work source. Input only appends an id;
 * network, IndexedDB, and home resolution happen in scheduled sweeps. A pending
 * entry is removed only after an explicit no-row check or a durable server ack.
 */

import type {
  AvailabilityGeneration,
  CreateUntitledContextDocumentResponse,
  CreateUntitledContextDocumentResult,
  MoveContextEntryResult,
  MoveContextEntrySuccess,
  ProjectContextTreeScheme,
} from "@meridian/contracts/protocol";
import * as Y from "yjs";
import type { DocumentSession, DocumentSessionSnapshot } from "@/core/editor/document-session";
import type { LocalDocumentSessionHandoff } from "@/core/editor/local-document-session-adoption";
import type { DesiredIdentity } from "./identity-location";
import type { LocalUntitledRecord } from "./local-untitled-record-store";
import type { LiveDocumentBinding, ProjectDocumentLiveOpenResult } from "./open-project-document";

const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 30_000;
const MAX_MATERIALIZATION_RECEIPTS = 16;

export type UntitledHome = {
  scheme: "scratch";
  workId: string;
  folderPath?: string;
};

export type PendingUntitled = {
  documentId: string;
  projectId: string;
  /** Resolved by a sweep; input can be captured before the works query settles. */
  home?: UntitledHome;
};

export type QueuedIdentityReceipt = MoveContextEntrySuccess & {
  workId?: string;
  routeWorkId: string;
};

type Candidate = {
  onReminted: (documentId: string) => void;
  /** One settled receipt; queued identity is the final tab and route location. */
  onMaterialized: (receipt: MaterializationReceipt) => void;
};

type MaterializationReceipt = {
  result: CreateUntitledContextDocumentResponse;
  identity?: QueuedIdentityReceipt;
  binding?: LiveDocumentBinding;
};

/**
 * Receipt for a queued desired identity that could not be applied when its
 * document materialized. Held in reconciler state (not a promise) so the
 * identity bar can surface recovery even though the writer's edit session
 * ended when the intent was queued. `conflict` carries the canonical
 * colliding locator (leading-slash path) for Open-existing.
 */
export type QueuedIdentityFailure =
  | {
      kind: "conflict";
      name: string;
      scheme: ProjectContextTreeScheme;
      path: string;
      workId?: string;
    }
  | { kind: "error"; name: string };

type ReconcilerSession = Pick<
  DocumentSession,
  | "document"
  | "fragmentName"
  | "whenLocalPersistenceSynced"
  | "flushLocalPersistence"
  | "waitForDurableSync"
  | "getSnapshot"
>;

type SchedulerPort = {
  queue(task: () => void): void;
  setTimer(task: () => void, delayMs: number): unknown;
  clearTimer(timer: unknown): void;
  onOnline(task: () => void): () => void;
};

type ApiPort = {
  resolveHome(projectId: string): Promise<UntitledHome | null>;
  create(
    entry: PendingUntitled & { home: UntitledHome },
  ): Promise<CreateUntitledContextDocumentResult>;
  serverDocumentExists(entry: PendingUntitled & { home: UntitledHome }): Promise<boolean>;
  move(
    entry: PendingUntitled & { home: UntitledHome },
    source: CreateUntitledContextDocumentResponse,
    desired: DesiredIdentity,
  ): Promise<MoveContextEntryResult>;
  lookupGeneration(projectId: string, documentId: string): Promise<AvailabilityGeneration>;
};

export type UntitledReconcilerDeps = {
  scheduler: SchedulerPort;
  api: ApiPort;
  newDocumentId: () => string;
  localOwner: {
    list(): readonly LocalUntitledRecord[];
    read(projectId: string, documentId: string): LocalUntitledRecord | null;
    write(record: LocalUntitledRecord): void;
    remove(projectId: string, documentId: string, expectedRevision: number): void;
    get(projectId: string, documentId: string): ReconcilerSession | null;
    restore(
      projectId: string,
      documentId: string,
    ): Promise<{ session: ReconcilerSession; documentId: string }>;
    retain(ownerId: string, projectId: string, documentId: string): void;
    release(ownerId: string): void;
    revision(projectId: string, documentId: string): number | null;
    prepare(
      projectId: string,
      documentId: string,
      revision: number,
    ): Promise<LocalDocumentSessionHandoff>;
    abort(projectId: string, documentId: string, handoff: LocalDocumentSessionHandoff): void;
    open(input: {
      source: "server" | "local-untitled";
      projectId: string;
      documentId: string;
      handoff?: import("@/core/editor/local-document-session-adoption").LocalDocumentSessionHandoff;
    }): Promise<ProjectDocumentLiveOpenResult>;
    remint(projectId: string, from: string, to: string): Promise<ReconcilerSession>;
    abandon(projectId: string, documentId: string, revision: number): Promise<void>;
    phase(projectId: string, documentId: string): "local-pending" | "adopted-live" | null;
  };
};

export function resolveUntitledHome(activeWorkId: string | null): UntitledHome | null {
  return activeWorkId ? { scheme: "scratch", workId: activeWorkId } : null;
}

export type ReconciliationRecord = {
  documentId: string;
  /** Monotonic guard for work captured across asynchronous boundaries. */
  revision: number;
  materialization: { phase: "pending"; entry: PendingUntitled } | { phase: "synced" };
  desiredIdentity?: DesiredIdentity;
  materializedResult?: CreateUntitledContextDocumentResponse;
  failure?: QueuedIdentityFailure;
  /** Epoch ms for device-only grace; meaningful only while pending. */
  pendingSinceMs: number | null;
};

export class UntitledReconciler {
  private readonly records = new Map<string, ReconciliationRecord>();
  private readonly candidates = new Map<string, Candidate>();
  private readonly materializationReceipts = new Map<string, MaterializationReceipt>();
  private materializationReceiptOwners = new Set<string>();
  private running = false;
  private scheduled = false;
  private started = false;
  private retryMs = RETRY_BASE_MS;
  private retryTimer: unknown = null;
  private removeOnlineListener: (() => void) | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly deps: UntitledReconcilerDeps) {}

  /** Loads durable records before the tab desk filters provisional tabs. */
  rehydrate(): void {
    for (const durable of this.deps.localOwner.list()) {
      if (durable.active === false) continue;
      const record = fromDurableRecord(durable);
      if (!this.records.has(record.documentId)) this.records.set(record.documentId, record);
    }
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.rehydrate();
    this.removeOnlineListener = this.deps.scheduler.onOnline(this.schedule);
    this.emit();
    this.schedule();
  }

  dispose(): void {
    if (!this.started) return;
    this.started = false;
    this.removeOnlineListener?.();
    this.removeOnlineListener = null;
    if (this.retryTimer !== null) this.deps.scheduler.clearTimer(this.retryTimer);
    this.retryTimer = null;
    this.scheduled = false;
  }

  registerCandidate(documentId: string, candidate: Candidate): () => void {
    this.candidates.set(documentId, candidate);
    const receipt = this.materializationReceipts.get(documentId);
    if (receipt) {
      this.materializationReceipts.delete(documentId);
      this.publishMaterialization(candidate, receipt);
    }
    return () => {
      if (this.candidates.get(documentId) === candidate) this.candidates.delete(documentId);
    };
  }

  setMaterializationReceiptOwners(documentIds: ReadonlySet<string>): void {
    this.materializationReceiptOwners = new Set(documentIds);
    this.evictUnreferencedMaterializationReceipts();
  }

  append(entry: PendingUntitled): void {
    if (!this.deps.localOwner.read(entry.projectId, entry.documentId)) {
      throw new Error("Local Untitled must be owned before materialization work is appended");
    }
    const current = this.records.get(entry.documentId);
    if (current?.materialization.phase === "pending") return;
    this.records.set(entry.documentId, {
      documentId: entry.documentId,
      revision: (current?.revision ?? 0) + 1,
      materialization: { phase: "pending", entry },
      desiredIdentity: current?.desiredIdentity,
      failure: current?.failure,
      pendingSinceMs: current?.pendingSinceMs ?? Date.now(),
    });
    this.persistAndEmit();
    this.schedule();
  }

  has(documentId: string): boolean {
    return this.records.get(documentId)?.materialization.phase === "pending";
  }

  pendingSince(documentId: string): number | null {
    const record = this.records.get(documentId);
    return record?.materialization.phase === "pending" ? record.pendingSinceMs : null;
  }

  queuedIdentityFailure(documentId: string): QueuedIdentityFailure | null {
    return this.records.get(documentId)?.failure ?? null;
  }

  clearQueuedIdentityFailure(documentId: string): void {
    const record = this.records.get(documentId);
    if (!record?.failure) return;
    const next = { ...record, failure: undefined };
    if (next.materialization.phase === "synced" && !next.desiredIdentity) {
      const projectId = this.projectIdFor(documentId);
      const durable = this.deps.localOwner.read(projectId, documentId);
      this.records.delete(documentId);
      if (durable) this.deps.localOwner.remove(projectId, documentId, durable.revision);
    } else {
      this.records.set(documentId, { ...next, revision: record.revision + 1 });
    }
    this.persistAndEmit();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Last explicit writer identity wins and is durable before this returns. */
  queueIdentity(entry: PendingUntitled, desiredIdentity: DesiredIdentity): void {
    const current = this.records.get(entry.documentId);
    const materialization =
      current?.materialization.phase === "pending"
        ? current.materialization
        : { phase: "pending" as const, entry };
    this.records.set(entry.documentId, {
      ...current,
      documentId: entry.documentId,
      revision: (current?.revision ?? 0) + 1,
      materialization,
      desiredIdentity,
      failure: undefined,
      pendingSinceMs: current?.pendingSinceMs ?? Date.now(),
    });
    this.persistAndEmit();
    this.schedule();
  }

  readonly schedule = (): void => {
    if (!this.started || !this.hasPendingWork() || this.scheduled) return;
    this.scheduled = true;
    this.deps.scheduler.queue(() => {
      this.scheduled = false;
      void this.sweep();
    });
  };

  private hasPendingWork(): boolean {
    return [...this.records.values()].some((record) => record.materialization.phase === "pending");
  }

  private async sweep(): Promise<void> {
    if (!this.started || this.running || !this.hasPendingWork()) return;
    this.running = true;
    let failed = false;
    try {
      const pendingDocumentIds = [...this.records.values()]
        .filter((record) => record.materialization.phase === "pending")
        .map((record) => record.documentId);
      for (const documentId of pendingDocumentIds) {
        if (!this.started) break;
        try {
          await this.reconcile(documentId);
        } catch {
          failed = true;
        }
      }
    } finally {
      this.running = false;
    }
    if (!this.started) return;
    if (failed && this.hasPendingWork()) this.armRetry();
    else {
      this.retryMs = RETRY_BASE_MS;
      if (this.hasPendingWork()) this.schedule();
    }
  }

  private async reconcile(documentId: string): Promise<void> {
    let record = this.pendingRecord(documentId);
    if (!record) return;
    const entry = record.materialization.entry;
    const home = entry.home ?? (await this.deps.api.resolveHome(entry.projectId));
    if (!home) throw new Error("Untitled home is not available yet");
    record = this.pendingRecord(documentId);
    if (!record) return;
    if (!record.materialization.entry.home) {
      record = {
        ...record,
        revision: record.revision + 1,
        materialization: {
          phase: "pending",
          entry: { ...record.materialization.entry, home },
        },
      };
      this.records.set(documentId, record);
      this.persist();
    }
    const resolvedEntry = record.materialization.entry as PendingUntitled & {
      home: UntitledHome;
    };

    await this.reconcileOwned(resolvedEntry);
  }

  private async reconcileOwned(entry: PendingUntitled & { home: UntitledHome }): Promise<void> {
    const local = this.deps.localOwner;
    const documentId = entry.documentId;
    const ownerId = `untitled-reconciler:${documentId}`;
    const phase = local.phase(entry.projectId, documentId);
    if (phase === "adopted-live") {
      const current = this.pendingRecord(documentId);
      if (current?.desiredIdentity && current.materializedResult) {
        const identity = await this.applyDesiredIdentity(entry, current.materializedResult);
        const receipt = { result: identity.result, identity: identity.identity };
        const candidate = this.candidates.get(documentId);
        if (candidate) this.publishMaterialization(candidate, receipt);
        else this.rememberMaterializationReceipt(documentId, receipt);
      }
      const opened = await local.open({ source: "server", ...entry });
      if (opened.kind !== "opened") throw new Error("Adopted Untitled could not reopen live");
      const binding = await opened.admission.bind(ownerId);
      try {
        await binding.session.waitForDurableSync();
        if (binding.session.getSnapshot().status !== "synced")
          throw syncFailure(binding.session.getSnapshot());
        const record = this.pendingRecord(documentId);
        if (record) this.drain(documentId, record.revision);
      } finally {
        binding.release();
      }
      return;
    }
    let session = local.get(entry.projectId, documentId);
    if (!session) {
      const restored = await local.restore(entry.projectId, documentId);
      if (restored.documentId !== documentId) {
        this.redirectOwnedRecord(entry, restored.documentId);
        return;
      }
      session = restored.session;
    }
    local.retain(ownerId, entry.projectId, documentId);
    try {
      await session.whenLocalPersistenceSynced();
      let record = this.pendingRecord(documentId);
      if (!record) return;
      const empty = untitledDocumentIsEmpty(session.document.getXmlFragment(session.fragmentName));
      if (empty && !record.desiredIdentity && !this.candidates.has(documentId)) {
        const checkedRevision = record.revision;
        if (!(await this.deps.api.serverDocumentExists(entry))) {
          local.release(ownerId);
          await local.abandon(
            entry.projectId,
            documentId,
            local.revision(entry.projectId, documentId) ?? -1,
          );
          this.drain(documentId, checkedRevision);
          return;
        }
      }

      const ownerRevision = local.revision(entry.projectId, documentId);
      if (ownerRevision === null) throw new Error("Local Untitled owner record disappeared");
      const handoff = await local.prepare(entry.projectId, documentId, ownerRevision);
      let result: CreateUntitledContextDocumentResult;
      try {
        result = await this.deps.api.create(entry);
      } catch (error) {
        local.abort(entry.projectId, documentId, handoff);
        throw error;
      }
      if (result.status === "conflict") {
        await this.remintOwned(entry);
        return;
      }
      record = this.pendingRecord(documentId);
      if (!record) return;
      record = { ...record, materializedResult: result };
      this.records.set(documentId, record);
      this.persist();
      const identity = await this.applyDesiredIdentity(entry, result);
      const latestAfterIdentity = this.records.get(documentId);
      if (latestAfterIdentity) {
        this.records.set(documentId, {
          ...latestAfterIdentity,
          materializedResult: identity.result,
        });
        this.persist();
      }
      const opened = await local.open({
        source: "local-untitled",
        projectId: entry.projectId,
        documentId,
        handoff,
      });
      if (opened.kind !== "opened") throw new Error("Materialized Untitled was not admitted");
      const binding = await opened.admission.bind(ownerId);
      const receipt = { result: identity.result, identity: identity.identity, binding };
      const candidate = this.candidates.get(documentId);
      if (candidate) this.publishMaterialization(candidate, receipt);
      else this.rememberMaterializationReceipt(documentId, receipt);
      try {
        await binding.session.waitForDurableSync();
        const snapshot = binding.session.getSnapshot();
        if (snapshot.status !== "synced") throw syncFailure(snapshot);
        this.drain(documentId, identity.revision);
      } finally {
        if (!candidate) binding.release();
      }
    } finally {
      local.release(ownerId);
    }
  }

  private async remintOwned(entry: PendingUntitled & { home: UntitledHome }): Promise<void> {
    const local = this.deps.localOwner;
    let replacementId = this.deps.newDocumentId();
    let replacement: ReconcilerSession;
    for (;;) {
      try {
        replacement = await local.remint(entry.projectId, entry.documentId, replacementId);
        break;
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes("owned elsewhere")) throw error;
        replacementId = this.deps.newDocumentId();
      }
    }
    await replacement.flushLocalPersistence();
    this.redirectOwnedRecord(entry, replacementId);
  }

  private redirectOwnedRecord(
    entry: PendingUntitled & { home: UntitledHome },
    replacementId: string,
  ): void {
    const record = this.records.get(entry.documentId);
    if (!record) return;
    const candidate = this.candidates.get(entry.documentId);
    this.records.delete(entry.documentId);
    this.records.set(replacementId, {
      ...record,
      documentId: replacementId,
      revision: record.revision + 1,
      materialization: {
        phase: "pending",
        entry: { ...entry, documentId: replacementId },
      },
    });
    this.candidates.delete(entry.documentId);
    if (candidate) this.candidates.set(replacementId, candidate);
    this.persistAndEmit();
    candidate?.onReminted(replacementId);
  }

  private async applyDesiredIdentity(
    entry: PendingUntitled & { home: UntitledHome },
    result: CreateUntitledContextDocumentResponse,
  ): Promise<{
    revision: number;
    result: CreateUntitledContextDocumentResponse;
    identity?: QueuedIdentityReceipt;
  }> {
    const record = this.records.get(entry.documentId);
    const desired = record?.desiredIdentity;
    if (!record) return { revision: -1, result };
    if (!desired) return { revision: record.revision, result };
    const attemptRevision = record.revision;
    try {
      const moved = await this.deps.api.move(entry, result, desired);
      if (moved.status === "retry") throw new Error(`Context move needs retry: ${moved.reason}`);
      if (moved.status === "conflict") {
        const finished = this.finishIdentityAttempt(entry.documentId, attemptRevision, {
          kind: "conflict",
          name: desired.name,
          scheme: moved.collision.scheme,
          path: `/${moved.collision.path}`,
          ...(moved.collision.authority.kind === "work"
            ? { workId: moved.collision.authority.workId }
            : {}),
        });
        return { revision: finished ? attemptRevision + 1 : attemptRevision, result };
      }
      const finished = this.finishIdentityAttempt(entry.documentId, attemptRevision);
      const identity: QueuedIdentityReceipt = {
        ...moved,
        path: `/${moved.path}`,
        ...(desired.destination.workId ? { workId: desired.destination.workId } : {}),
        routeWorkId: desired.destination.workId ?? entry.home.workId,
      };
      return {
        revision: finished ? attemptRevision + 1 : attemptRevision,
        result: {
          status: "already-materialized",
          documentId: entry.documentId,
          scheme: moved.scheme,
          path: `/${moved.path}`,
          name: moved.name,
          ...(desired.destination.workId ? { workId: desired.destination.workId } : {}),
        },
        ...(finished ? { identity } : {}),
      };
    } catch (error) {
      if (!isTerminalIdentityError(error)) throw error;
      const finished = this.finishIdentityAttempt(entry.documentId, attemptRevision, {
        kind: "error",
        name: desired.name,
      });
      return { revision: finished ? attemptRevision + 1 : attemptRevision, result };
    }
  }

  private finishIdentityAttempt(
    documentId: string,
    attemptRevision: number,
    failure?: QueuedIdentityFailure,
  ): boolean {
    const record = this.records.get(documentId);
    if (!record || record.revision !== attemptRevision) return false;
    this.records.set(documentId, {
      ...record,
      revision: record.revision + 1,
      desiredIdentity: undefined,
      failure,
    });
    this.persistAndEmit();
    return true;
  }

  private publishMaterialization(candidate: Candidate, receipt: MaterializationReceipt): void {
    candidate.onMaterialized(receipt);
  }

  private rememberMaterializationReceipt(
    documentId: string,
    receipt: MaterializationReceipt,
  ): void {
    this.materializationReceipts.delete(documentId);
    this.materializationReceipts.set(documentId, receipt);
    this.evictUnreferencedMaterializationReceipts();
  }

  private evictUnreferencedMaterializationReceipts(): void {
    let unreferencedCount = 0;
    for (const documentId of this.materializationReceipts.keys()) {
      if (!this.materializationReceiptOwners.has(documentId)) unreferencedCount += 1;
    }
    if (unreferencedCount <= MAX_MATERIALIZATION_RECEIPTS) return;

    for (const documentId of this.materializationReceipts.keys()) {
      if (this.materializationReceiptOwners.has(documentId)) continue;
      this.materializationReceipts.delete(documentId);
      unreferencedCount -= 1;
      if (unreferencedCount === MAX_MATERIALIZATION_RECEIPTS) return;
    }
  }

  private drain(documentId: string, processedRevision: number): void {
    const record = this.records.get(documentId);
    if (!record || record.revision !== processedRevision) return;
    if (record?.failure) {
      this.records.set(documentId, {
        ...record,
        revision: record.revision + 1,
        desiredIdentity: undefined,
        materialization: { phase: "synced" },
        pendingSinceMs: null,
      });
    } else {
      const projectId = this.projectIdFor(documentId);
      const durable = this.deps.localOwner.read(projectId, documentId);
      this.records.delete(documentId);
      if (durable) this.deps.localOwner.remove(projectId, documentId, durable.revision);
    }
    this.persistAndEmit();
  }

  private pendingRecord(documentId: string):
    | (ReconciliationRecord & {
        materialization: { phase: "pending"; entry: PendingUntitled };
      })
    | null {
    const record = this.records.get(documentId);
    return record?.materialization.phase === "pending"
      ? (record as ReconciliationRecord & {
          materialization: { phase: "pending"; entry: PendingUntitled };
        })
      : null;
  }

  private persist(): void {
    for (const record of this.records.values()) {
      const entry =
        record.materialization.phase === "pending" ? record.materialization.entry : null;
      const base = this.deps.localOwner.read(
        entry?.projectId ?? this.projectIdFor(record.documentId),
        record.documentId,
      );
      if (!base) continue;
      this.deps.localOwner.write({
        ...base,
        workRevision: record.revision,
        home: entry?.home ?? base.home,
        desiredIdentity: record.desiredIdentity,
        materializedResult: record.materializedResult,
        failure: record.failure,
        pendingSinceMs: record.pendingSinceMs,
      });
    }
  }

  private projectIdFor(documentId: string): string {
    const durable = this.deps.localOwner
      .list()
      .find((record) => record.active !== false && record.key.documentId === documentId);
    if (!durable) throw new Error("Local Untitled durable work disappeared");
    return durable.key.projectId;
  }

  private persistAndEmit(): void {
    this.persist();
    this.emit();
  }

  private armRetry(): void {
    if (this.retryTimer !== null) return;
    this.retryTimer = this.deps.scheduler.setTimer(() => {
      this.retryTimer = null;
      this.schedule();
    }, this.retryMs);
    this.retryMs = Math.min(this.retryMs * 2, RETRY_MAX_MS);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

function isTerminalIdentityError(error: unknown): error is { retryable: false } {
  if (typeof error !== "object" || error === null) return false;
  if ("status" in error && typeof error.status === "number") {
    return error.status >= 400 && error.status < 500;
  }
  return "retryable" in error && error.retryable === false;
}

function syncFailure(snapshot: DocumentSessionSnapshot): Error {
  if (snapshot.status === "access-lost") {
    return new Error("Untitled document access is temporarily unavailable");
  }
  return new Error("Untitled document not durably synced");
}

function fromDurableRecord(record: LocalUntitledRecord): ReconciliationRecord {
  return {
    documentId: record.key.documentId,
    revision: record.workRevision ?? record.revision,
    materialization:
      record.phase === "local-pending"
        ? {
            phase: "pending",
            entry: {
              documentId: record.key.documentId,
              projectId: record.key.projectId,
              ...(record.home ? { home: record.home } : {}),
            },
          }
        : { phase: "synced" },
    desiredIdentity: record.desiredIdentity,
    materializedResult: record.materializedResult,
    failure: record.failure,
    pendingSinceMs: record.pendingSinceMs ?? null,
  };
}

export function untitledDocumentIsEmpty(fragment: Y.XmlFragment): boolean {
  return !fragment.toArray().some(nodeHasContent);
}

function nodeHasContent(value: unknown): boolean {
  if (value instanceof Y.XmlText) return value.toString().length > 0;
  if (value instanceof Y.XmlElement) {
    if (!["doc", "paragraph", "heading"].includes(value.nodeName)) return true;
    return value.toArray().some(nodeHasContent);
  }
  return typeof value === "string" && value.length > 0;
}
