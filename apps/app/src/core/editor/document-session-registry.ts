/**
 * Account-scoped owner of live document sessions and generation-fenced branch rooms.
 * Live acquisition is lease-required; the temporary private-lane facade only keeps
 * pre-F1 callers compiling until F1-I deletes it.
 */
import type {
  AccountId,
  AvailabilityCommandId,
  AvailabilityGeneration,
  LiveDocumentSessionAuthority,
  LiveDocumentSessionLease,
} from "@meridian/contracts/protocol";
import { parseYjsRoomName } from "@meridian/contracts/protocol";
import type { DocumentId, ProjectId, UserId } from "@meridian/contracts/runtime";

import { createHocuspocusDocumentTransport } from "@/core/transport/hocuspocus-document-transport";
import { DocumentSession, type DocumentSessionSnapshot } from "./document-session";
import {
  accessFenceKey,
  compareAvailabilityGeneration,
  DocumentSessionAuthorityStore,
  documentFenceKey,
  documentSessionPersistenceKey,
} from "./document-session-authority-store";
import { readSchemaFenceQuarantine, writeSchemaFenceQuarantine } from "./schema-fence";

const LIVE_DOC_SOFT_CAP = 50;
const SESSION_TEARDOWN_GRACE_MS = 3_000;

type LiveRoomState = {
  session: DocumentSession | null;
  persistenceGeneration: AvailabilityGeneration | null;
  leases: Map<ProjectId, LiveDocumentSessionLease>;
};

type RetainedLiveDocument = { lease: LiveDocumentSessionLease; detached: boolean };

export class DocumentSessionAuthorityError extends Error {
  constructor(
    readonly kind:
      | "account-unconfigured"
      | "account-mismatch"
      | "generation-revoked"
      | "stale-lease"
      | "older-command"
      | "command-collision"
      | "purge-pending",
    message: string,
  ) {
    super(message);
    this.name = "DocumentSessionAuthorityError";
  }
}

export class DocumentSessionRegistry implements LiveDocumentSessionAuthority {
  private accountId: AccountId | null = null;
  private authorityStore: DocumentSessionAuthorityStore | null = null;
  private readonly liveRooms = new Map<DocumentId, LiveRoomState>();
  private readonly branchSessions = new Map<string, DocumentSession>();
  private readonly retainedByOwner = new Map<string, Map<DocumentId, RetainedLiveDocument>>();
  private readonly temporaryRetainedByOwner = new Map<
    string,
    { roomKeys: Set<string>; detachedRoomKeys: Set<string> }
  >();
  private readonly pendingTeardownTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private liveDocCapWarningEmitted = false;
  private readonly sessionObservers = new Map<
    string,
    Map<(snapshot: DocumentSessionSnapshot) => void, (() => void) | undefined>
  >();

  constructor(
    private readonly createAuthorityStore: (
      accountId: AccountId,
    ) => DocumentSessionAuthorityStore = (accountId) =>
      new DocumentSessionAuthorityStore(accountId),
    private readonly teardownGraceMs = SESSION_TEARDOWN_GRACE_MS,
  ) {}

  async admit(
    projectId: ProjectId,
    documentId: DocumentId,
    generation: AvailabilityGeneration,
  ): Promise<LiveDocumentSessionLease> {
    const { accountId, store } = this.configuredAuthority();
    compareAvailabilityGeneration(generation, generation);
    await store.retryPendingPurges();
    for (const fence of [
      await store.readFence(documentFenceKey(accountId, documentId)),
      await store.readFence(accessFenceKey(accountId, projectId, documentId)),
    ]) {
      if (fence && compareAvailabilityGeneration(generation, fence.revokedThrough) <= 0) {
        throw new DocumentSessionAuthorityError(
          "generation-revoked",
          `Generation ${generation} is revoked for ${documentId}`,
        );
      }
    }

    const lease = { accountId, projectId, documentId, generation };
    const state = this.liveRooms.get(documentId) ?? {
      session: null,
      persistenceGeneration: null,
      leases: new Map(),
    };
    const existing = state.leases.get(projectId);
    if (existing && compareAvailabilityGeneration(generation, existing.generation) < 0) {
      throw new DocumentSessionAuthorityError(
        "stale-lease",
        `A newer lease already exists for ${documentId}`,
      );
    }
    state.leases.set(projectId, lease);
    this.liveRooms.set(documentId, state);
    return lease;
  }

  async revokeDocument(
    _projectId: ProjectId,
    documentId: DocumentId,
    generation: AvailabilityGeneration,
    commandId: AvailabilityCommandId,
  ): Promise<{ revokedThrough: AvailabilityGeneration; persistence: "cleared" }> {
    const { accountId, store } = this.configuredAuthority();
    const currentFence = await store.readFence(documentFenceKey(accountId, documentId));
    if (
      !currentFence ||
      compareAvailabilityGeneration(generation, currentFence.revokedThrough) > 0
    ) {
      this.rejectCommandBehindActiveLease(documentId, generation);
    }
    const advance = await store.advanceFence({
      key: documentFenceKey(accountId, documentId),
      documentId,
      revokedThrough: generation,
      commandId,
      purge: true,
    });
    this.assertCommandAccepted(advance.kind, documentId, generation);
    if (advance.kind === "advanced") await this.removeLiveDocument(documentId);
    if (!(await store.retryPendingPurges())) {
      throw new DocumentSessionAuthorityError(
        "purge-pending",
        `Persistence purge is pending for ${documentId}`,
      );
    }
    return { revokedThrough: advance.fence.revokedThrough, persistence: "cleared" };
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
    const { accountId, store } = this.configuredAuthority();
    const state = this.liveRooms.get(documentId);
    const projectLease = state?.leases.get(projectId);
    const currentFence = await store.readFence(accessFenceKey(accountId, projectId, documentId));
    if (
      projectLease &&
      (!currentFence ||
        compareAvailabilityGeneration(generation, currentFence.revokedThrough) > 0) &&
      compareAvailabilityGeneration(generation, projectLease.generation) < 0
    ) {
      throw new DocumentSessionAuthorityError(
        "older-command",
        `A newer lease retains ${documentId}`,
      );
    }
    const retainedByOtherLease = [...(state?.leases.keys() ?? [])].some((id) => id !== projectId);
    const advance = await store.advanceFence({
      key: accessFenceKey(accountId, projectId, documentId),
      documentId,
      revokedThrough: generation,
      commandId,
      purge: !retainedByOtherLease,
    });
    this.assertCommandAccepted(advance.kind, documentId, generation);
    if (advance.kind === "advanced") {
      state?.leases.delete(projectId);
      this.removeRetainedProjectLease(projectId, documentId);
      if (!retainedByOtherLease) await this.removeLiveDocument(documentId);
    }
    if (retainedByOtherLease) {
      return {
        revokedThrough: advance.fence.revokedThrough,
        persistence: "retained-by-other-lease",
      };
    }
    if (!(await store.retryPendingPurges())) {
      throw new DocumentSessionAuthorityError(
        "purge-pending",
        `Persistence purge is pending for ${documentId}`,
      );
    }
    return { revokedThrough: advance.fence.revokedThrough, persistence: "cleared" };
  }

  get(lease: LiveDocumentSessionLease): DocumentSession {
    const state = this.requireLease(lease);
    return this.getOrCreateLiveSession(lease, state, true);
  }

  getDetached(lease: LiveDocumentSessionLease): DocumentSession {
    const state = this.requireLease(lease);
    return this.getOrCreateLiveSession(lease, state, false);
  }

  attachDetached(lease: LiveDocumentSessionLease): DocumentSession {
    const session = this.getDetached(lease);
    if (session.getSnapshot().status === "detached") this.attachSessionTransport(session);
    return session;
  }

  async restartUnavailableRoom(lease: LiveDocumentSessionLease): Promise<boolean> {
    const state = this.requireLease(lease);
    const session = state.session;
    if (!session) return false;
    const snapshot = session.getSnapshot();
    if (snapshot.schemaFence || snapshot.status === "detached") return false;
    if (
      snapshot.status !== "access-lost" &&
      snapshot.connectionState?.kind !== "unauthorized" &&
      snapshot.connectionState?.kind !== "terminal"
    ) {
      return false;
    }
    this.cancelPendingTeardown(lease.documentId);
    await session.restartTransport(({ roomKey, document, awareness }) =>
      createHocuspocusDocumentTransport({ roomName: roomKey, document, awareness }),
    );
    return true;
  }

  retain(
    ownerId: string,
    leases: Iterable<LiveDocumentSessionLease>,
    options: { detachedDocumentIds?: Iterable<DocumentId> } = {},
  ): void {
    const detached = new Set(options.detachedDocumentIds);
    const retained = new Map<DocumentId, RetainedLiveDocument>();
    for (const lease of leases) {
      this.requireLease(lease);
      retained.set(lease.documentId, { lease, detached: detached.has(lease.documentId) });
    }
    this.retainedByOwner.set(ownerId, retained);
    this.reconcileRetainedSessions();
  }

  release(ownerId: string): void {
    this.retainedByOwner.delete(ownerId);
    this.temporaryRetainedByOwner.delete(ownerId);
    this.reconcileRetainedSessions();
  }

  getBranchRoom(roomKey: string): DocumentSession {
    const room = parseYjsRoomName(roomKey);
    if (room?.kind !== "branch")
      throw new Error(`Branch session requires a branch room: ${roomKey}`);
    this.cancelPendingTeardown(roomKey);
    const existing = this.branchSessions.get(roomKey);
    if (existing) return existing;
    const session = this.createSession(roomKey, false);
    this.attachSessionTransport(session);
    session.subscribe((snapshot) => {
      if (snapshot.connectionState?.kind !== "reset") return;
      void session.destroy().finally(() => {
        if (this.branchSessions.get(roomKey) === session) this.branchSessions.delete(roomKey);
      });
    });
    this.branchSessions.set(roomKey, session);
    return session;
  }

  peekLive(lease: LiveDocumentSessionLease): DocumentSession | undefined {
    return this.requireLease(lease).session ?? undefined;
  }

  hasLive(lease: LiveDocumentSessionLease): boolean {
    return this.peekLive(lease) !== undefined;
  }

  observeLive(
    lease: LiveDocumentSessionLease,
    observer: (snapshot: DocumentSessionSnapshot) => void,
  ): () => void {
    this.requireLease(lease);
    return this.observeRoom(lease.documentId, observer);
  }

  setOwnUserId(userId: UserId): void {
    if (this.accountId === userId) return;
    const previous = this.authorityStore;
    this.destroyAll();
    this.accountId = userId;
    this.authorityStore = this.createAuthorityStore(userId);
    void previous?.close();
    void this.authorityStore.retryPendingPurges();
  }

  destroyAll(): void {
    this.retainedByOwner.clear();
    this.temporaryRetainedByOwner.clear();
    this.liveDocCapWarningEmitted = false;
    for (const timer of this.pendingTeardownTimers.values()) clearTimeout(timer);
    this.pendingTeardownTimers.clear();
    for (const state of this.liveRooms.values()) void state.session?.destroy();
    for (const session of this.branchSessions.values()) void session.destroy();
    this.liveRooms.clear();
    this.branchSessions.clear();
  }

  private configuredAuthority(): { accountId: AccountId; store: DocumentSessionAuthorityStore } {
    if (!this.accountId || !this.authorityStore) {
      throw new DocumentSessionAuthorityError(
        "account-unconfigured",
        "Session account is not configured",
      );
    }
    return { accountId: this.accountId, store: this.authorityStore };
  }

  private requireLease(lease: LiveDocumentSessionLease): LiveRoomState {
    if (lease.accountId !== this.accountId) {
      throw new DocumentSessionAuthorityError(
        "account-mismatch",
        "Lease belongs to another account",
      );
    }
    const state = this.liveRooms.get(lease.documentId);
    const current = state?.leases.get(lease.projectId);
    if (!state || !current || current.generation !== lease.generation) {
      throw new DocumentSessionAuthorityError(
        "stale-lease",
        `Lease is stale for ${lease.documentId}`,
      );
    }
    return state;
  }

  private getOrCreateLiveSession(
    lease: LiveDocumentSessionLease,
    state: LiveRoomState,
    attach: boolean,
  ): DocumentSession {
    this.cancelPendingTeardown(lease.documentId);
    if (state.session) return state.session;
    state.persistenceGeneration ??= lease.generation;
    const session = this.createSession(
      lease.documentId,
      true,
      documentSessionPersistenceKey(lease.accountId, lease.documentId, state.persistenceGeneration),
    );
    state.session = session;
    if (attach) this.attachSessionTransport(session);
    this.maybeWarnLiveDocCap();
    return session;
  }

  private createSession(
    roomKey: string,
    enableIndexedDb: boolean,
    persistenceKey?: string,
  ): DocumentSession {
    const session = new DocumentSession({
      roomKey,
      enableIndexedDb,
      persistenceKey,
      ownUserId: this.accountId,
      persistSchemaFence: (fence) => writeSchemaFenceQuarantine(roomKey, fence),
    });
    const quarantine = readSchemaFenceQuarantine(roomKey);
    if (quarantine) session.raiseSchemaFence(quarantine);
    this.publishSession(roomKey, session);
    return session;
  }

  private attachSessionTransport(session: DocumentSession): void {
    if (session.getSnapshot().schemaFence) return;
    session.attachTransport(({ roomKey, document, awareness }) =>
      createHocuspocusDocumentTransport({ roomName: roomKey, document, awareness }),
    );
  }

  private async removeLiveDocument(documentId: DocumentId): Promise<void> {
    this.cancelPendingTeardown(documentId);
    for (const retained of this.retainedByOwner.values()) retained.delete(documentId);
    for (const retained of this.temporaryRetainedByOwner.values()) {
      retained.roomKeys.delete(documentId);
      retained.detachedRoomKeys.delete(documentId);
    }
    const state = this.liveRooms.get(documentId);
    this.liveRooms.delete(documentId);
    await state?.session?.destroy();
  }

  private removeRetainedProjectLease(projectId: ProjectId, documentId: DocumentId): void {
    for (const retained of this.retainedByOwner.values()) {
      if (retained.get(documentId)?.lease.projectId === projectId) retained.delete(documentId);
    }
  }

  private rejectCommandBehindActiveLease(
    documentId: DocumentId,
    generation: AvailabilityGeneration,
  ): void {
    for (const lease of this.liveRooms.get(documentId)?.leases.values() ?? []) {
      if (compareAvailabilityGeneration(generation, lease.generation) < 0) {
        throw new DocumentSessionAuthorityError(
          "older-command",
          `A newer lease retains ${documentId}`,
        );
      }
    }
  }

  private assertCommandAccepted(kind: string, documentId: DocumentId, generation: string): void {
    if (kind === "older") {
      throw new DocumentSessionAuthorityError(
        "older-command",
        `Command ${generation} is older for ${documentId}`,
      );
    }
    if (kind === "collision") {
      throw new DocumentSessionAuthorityError(
        "command-collision",
        `A different command already owns generation ${generation} for ${documentId}`,
      );
    }
  }

  private reconcileRetainedSessions(): void {
    const keep = new Map<DocumentId, RetainedLiveDocument>();
    for (const retained of this.retainedByOwner.values()) {
      for (const [documentId, owner] of retained) keep.set(documentId, owner);
    }
    for (const retained of this.temporaryRetainedByOwner.values()) {
      for (const documentId of retained.roomKeys) {
        if (!keep.has(documentId))
          this.temporaryGetLive(documentId, retained.detachedRoomKeys.has(documentId));
      }
    }
    for (const owner of keep.values()) {
      const state = this.requireLease(owner.lease);
      this.getOrCreateLiveSession(owner.lease, state, !owner.detached);
    }
    for (const [documentId, state] of this.liveRooms) {
      if (state.session && !keep.has(documentId) && !this.isTemporarilyRetained(documentId)) {
        this.scheduleTeardown(documentId);
      }
    }
  }

  private scheduleTeardown(roomKey: string): void {
    if (this.pendingTeardownTimers.has(roomKey)) return;
    const timer = setTimeout(() => {
      this.pendingTeardownTimers.delete(roomKey);
      const state = this.liveRooms.get(roomKey);
      if (!state?.session || this.isRetained(roomKey)) return;
      const session = state.session;
      state.session = null;
      void session.destroy();
    }, this.teardownGraceMs);
    this.pendingTeardownTimers.set(roomKey, timer);
  }

  private cancelPendingTeardown(roomKey: string): void {
    const timer = this.pendingTeardownTimers.get(roomKey);
    if (!timer) return;
    clearTimeout(timer);
    this.pendingTeardownTimers.delete(roomKey);
  }

  private isRetained(documentId: DocumentId): boolean {
    for (const retained of this.retainedByOwner.values()) if (retained.has(documentId)) return true;
    return this.isTemporarilyRetained(documentId);
  }

  private isTemporarilyRetained(documentId: DocumentId): boolean {
    for (const retained of this.temporaryRetainedByOwner.values()) {
      if (retained.roomKeys.has(documentId)) return true;
    }
    return false;
  }

  private publishSession(roomKey: string, session: DocumentSession): void {
    for (const [observer] of this.sessionObservers.get(roomKey) ?? []) {
      this.sessionObservers.get(roomKey)?.set(observer, session.subscribe(observer));
    }
  }

  private observeRoom(
    roomKey: string,
    observer: (snapshot: DocumentSessionSnapshot) => void,
  ): () => void {
    let observers = this.sessionObservers.get(roomKey);
    if (!observers) {
      observers = new Map();
      this.sessionObservers.set(roomKey, observers);
    }
    observers.set(observer, this.temporaryPeek(roomKey)?.subscribe(observer));
    return () => {
      observers?.get(observer)?.();
      observers?.delete(observer);
      if (observers?.size === 0) this.sessionObservers.delete(roomKey);
    };
  }

  private maybeWarnLiveDocCap(): void {
    const liveCount = [...this.liveRooms.values()].filter(({ session }) => session).length;
    if (this.liveDocCapWarningEmitted || liveCount <= LIVE_DOC_SOFT_CAP) return;
    this.liveDocCapWarningEmitted = true;
    console.warn(
      `[document-session-registry] live document session count (${liveCount}) exceeds soft cap (${LIVE_DOC_SOFT_CAP})`,
    );
  }

  // F1-I deletion target: every temporary* member below and the exported facade.
  temporaryGet(roomKey: string): DocumentSession {
    const room = parseYjsRoomName(roomKey);
    return room?.kind === "branch"
      ? this.getBranchRoom(roomKey)
      : this.temporaryGetLive(roomKey, false);
  }

  temporaryGetDetached(documentId: string): DocumentSession {
    return this.temporaryGetLive(documentId, true);
  }

  temporaryAttachDetached(documentId: string): DocumentSession {
    const session = this.temporaryGetDetached(documentId);
    if (session.getSnapshot().status === "detached") this.attachSessionTransport(session);
    return session;
  }

  async temporaryRestartUnavailableRoom(documentId: string): Promise<boolean> {
    const session = this.temporaryPeek(documentId);
    if (!session) return false;
    const snapshot = session.getSnapshot();
    if (snapshot.schemaFence || snapshot.status === "detached") return false;
    if (
      snapshot.status !== "access-lost" &&
      snapshot.connectionState?.kind !== "unauthorized" &&
      snapshot.connectionState?.kind !== "terminal"
    )
      return false;
    await session.restartTransport(({ roomKey, document, awareness }) =>
      createHocuspocusDocumentTransport({ roomName: roomKey, document, awareness }),
    );
    return true;
  }

  temporaryRetain(
    ownerId: string,
    openRoomKeys: Iterable<string>,
    options: { detachedRoomKeys?: Iterable<string> } = {},
  ): void {
    this.temporaryRetainedByOwner.set(ownerId, {
      roomKeys: new Set(openRoomKeys),
      detachedRoomKeys: new Set(options.detachedRoomKeys),
    });
    this.reconcileRetainedSessions();
  }

  temporaryPeek(roomKey: string): DocumentSession | undefined {
    const room = parseYjsRoomName(roomKey);
    return room?.kind === "branch"
      ? this.branchSessions.get(roomKey)
      : (this.liveRooms.get(roomKey)?.session ?? undefined);
  }

  async temporaryRevokeRoom(roomKey: string): Promise<void> {
    await this.removeLiveDocument(roomKey);
  }

  temporaryObserve(
    roomKey: string,
    observer: (snapshot: DocumentSessionSnapshot) => void,
  ): () => void {
    return this.observeRoom(roomKey, observer);
  }

  private temporaryGetLive(documentId: string, detached: boolean): DocumentSession {
    const room = parseYjsRoomName(documentId);
    if (room?.kind !== "live")
      throw new Error(`Live session requires a document id: ${documentId}`);
    const state = this.liveRooms.get(documentId) ?? {
      session: null,
      persistenceGeneration: null,
      leases: new Map(),
    };
    this.liveRooms.set(documentId, state);
    if (!state.session) state.session = this.createSession(documentId, false);
    if (!detached && state.session.getSnapshot().status === "detached")
      this.attachSessionTransport(state.session);
    return state.session;
  }
}

export type TemporaryUnfencedDocumentSessionRegistry = {
  get: (documentId: string) => DocumentSession;
  getRoom: (roomKey: string) => DocumentSession;
  getDetached: (documentId: string) => DocumentSession;
  attachDetached: (documentId: string) => DocumentSession;
  restartUnavailableRoom: (documentId: string) => Promise<boolean>;
  retain: (
    ownerId: string,
    roomKeys: Iterable<string>,
    options?: { detachedRoomKeys?: Iterable<string> },
  ) => void;
  release: (ownerId: string) => void;
  peek: (roomKey: string) => DocumentSession | undefined;
  has: (roomKey: string) => boolean;
  observe: (roomKey: string, observer: (snapshot: DocumentSessionSnapshot) => void) => () => void;
  revokeRoom: (roomKey: string, options?: { clearPersistence?: boolean }) => Promise<void>;
  destroyRoom: (roomKey: string, options?: { clearPersistence?: boolean }) => Promise<void>;
  destroyAll: () => void;
  setOwnUserId: (userId: UserId) => void;
};

let sharedRegistry: DocumentSessionRegistry | null = null;
let temporaryFacade: TemporaryUnfencedDocumentSessionRegistry | null = null;

export function getLiveDocumentSessionRegistry(): DocumentSessionRegistry {
  sharedRegistry ??= new DocumentSessionRegistry();
  return sharedRegistry;
}

/** F1-I deletion target: private bridge for callers awaiting availability/admission wiring. */
export function getDocumentSessionRegistry(): TemporaryUnfencedDocumentSessionRegistry {
  if (temporaryFacade) return temporaryFacade;
  const registry = getLiveDocumentSessionRegistry();
  temporaryFacade = {
    get: (id) => registry.temporaryGet(id),
    getRoom: (id) => registry.temporaryGet(id),
    getDetached: (id) => registry.temporaryGetDetached(id),
    attachDetached: (id) => registry.temporaryAttachDetached(id),
    restartUnavailableRoom: (id) => registry.temporaryRestartUnavailableRoom(id),
    retain: (owner, ids, options) => registry.temporaryRetain(owner, ids, options),
    release: (owner) => registry.release(owner),
    peek: (id) => registry.temporaryPeek(id),
    has: (id) => registry.temporaryPeek(id) !== undefined,
    observe: (id, observer) => registry.temporaryObserve(id, observer),
    revokeRoom: (id) => registry.temporaryRevokeRoom(id),
    destroyRoom: (id) => registry.temporaryRevokeRoom(id),
    destroyAll: () => registry.destroyAll(),
    setOwnUserId: (id) => registry.setOwnUserId(id),
  };
  return temporaryFacade;
}

export function configureDocumentSessionUser(userId: UserId): void {
  getLiveDocumentSessionRegistry().setOwnUserId(userId);
}
