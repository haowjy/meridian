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

type AuthorityStore = Pick<
  DocumentSessionAuthorityStore,
  "close" | "readFence" | "readAdmissionFences" | "advanceFence" | "retryPendingPurges"
>;

type UnleasedRoomState = { session: DocumentSession; detached: boolean };

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
  private accountEpoch = 0;
  private authorityStore: AuthorityStore | null = null;
  private readonly liveRooms = new Map<DocumentId, LiveRoomState>();
  private readonly unleasedRooms = new Map<string, UnleasedRoomState>();
  private readonly retainedByOwner = new Map<string, Map<DocumentId, RetainedLiveDocument>>();
  private readonly unleasedRetainedByOwner = new Map<
    string,
    { roomKeys: Set<string>; detachedRoomKeys: Set<string> }
  >();
  private readonly authorityOperations = new Map<string, Promise<void>>();
  private readonly pendingTeardownTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private liveDocCapWarningEmitted = false;
  private readonly sessionObservers = new Map<
    string,
    Map<(snapshot: DocumentSessionSnapshot) => void, (() => void) | undefined>
  >();

  constructor(
    private readonly createAuthorityStore: (accountId: AccountId) => AuthorityStore = (accountId) =>
      new DocumentSessionAuthorityStore(accountId),
    private readonly teardownGraceMs = SESSION_TEARDOWN_GRACE_MS,
  ) {}

  async admit(
    projectId: ProjectId,
    documentId: DocumentId,
    generation: AvailabilityGeneration,
  ): Promise<LiveDocumentSessionLease> {
    compareAvailabilityGeneration(generation, generation);
    return this.runAuthorityOperation(documentId, async ({ accountId, store, epoch }) => {
      await store.retryPendingPurges();
      const fences = await store.readAdmissionFences(
        documentFenceKey(accountId, documentId),
        accessFenceKey(accountId, projectId, documentId),
      );
      for (const fence of fences) {
        if (fence && compareAvailabilityGeneration(generation, fence.revokedThrough) <= 0) {
          throw new DocumentSessionAuthorityError(
            "generation-revoked",
            `Generation ${generation} is revoked for ${documentId}`,
          );
        }
      }

      this.assertAccountEpoch(accountId, epoch);
      await this.retireUnleasedLiveRoom(documentId);
      this.assertAccountEpoch(accountId, epoch);
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
    });
  }

  async revokeDocument(
    _projectId: ProjectId,
    documentId: DocumentId,
    generation: AvailabilityGeneration,
    commandId: AvailabilityCommandId,
  ): Promise<{ revokedThrough: AvailabilityGeneration; persistence: "cleared" }> {
    compareAvailabilityGeneration(generation, generation);
    return this.runAuthorityOperation(documentId, async ({ accountId, store, epoch }) => {
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
      this.assertAccountEpoch(accountId, epoch);
      if (advance.kind === "advanced") await this.removeLiveDocument(documentId);
      this.assertAccountEpoch(accountId, epoch);
      if (!(await store.retryPendingPurges())) {
        throw new DocumentSessionAuthorityError(
          "purge-pending",
          `Persistence purge is pending for ${documentId}`,
        );
      }
      this.assertAccountEpoch(accountId, epoch);
      return { revokedThrough: advance.fence.revokedThrough, persistence: "cleared" as const };
    });
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
    compareAvailabilityGeneration(generation, generation);
    return this.runAuthorityOperation(documentId, async ({ accountId, store, epoch }) => {
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
      this.assertAccountEpoch(accountId, epoch);
      if (advance.kind === "advanced") {
        state?.leases.delete(projectId);
        this.removeRetainedProjectLease(projectId, documentId);
        if (!retainedByOtherLease) await this.removeLiveDocument(documentId);
      }
      this.assertAccountEpoch(accountId, epoch);
      if (retainedByOtherLease) {
        return {
          revokedThrough: advance.fence.revokedThrough,
          persistence: "retained-by-other-lease" as const,
        };
      }
      if (!(await store.retryPendingPurges())) {
        throw new DocumentSessionAuthorityError(
          "purge-pending",
          `Persistence purge is pending for ${documentId}`,
        );
      }
      this.assertAccountEpoch(accountId, epoch);
      return { revokedThrough: advance.fence.revokedThrough, persistence: "cleared" as const };
    });
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
    this.reconcileRetainedSessions();
  }

  retainBranchRooms(ownerId: string, roomKeys: Iterable<string>): void {
    const keys = new Set(roomKeys);
    for (const roomKey of keys) {
      if (parseYjsRoomName(roomKey)?.kind !== "branch") {
        throw new Error(`Branch retention requires a branch room: ${roomKey}`);
      }
    }
    this.unleasedRetainedByOwner.set(ownerId, { roomKeys: keys, detachedRoomKeys: new Set() });
    this.reconcileUnleasedSessions();
  }

  releaseBranchRooms(ownerId: string): void {
    this.unleasedRetainedByOwner.delete(ownerId);
    this.reconcileUnleasedSessions();
  }

  getBranchRoom(roomKey: string): DocumentSession {
    const room = parseYjsRoomName(roomKey);
    if (room?.kind !== "branch")
      throw new Error(`Branch session requires a branch room: ${roomKey}`);
    this.cancelPendingTeardown(roomKey);
    const existing = this.unleasedRooms.get(roomKey)?.session;
    if (existing) return existing;
    const session = this.createSession(roomKey, false);
    this.attachSessionTransport(session);
    session.subscribe((snapshot) => {
      if (snapshot.connectionState?.kind !== "reset") return;
      void session.destroy().finally(() => {
        if (this.unleasedRooms.get(roomKey)?.session === session)
          this.unleasedRooms.delete(roomKey);
      });
    });
    this.unleasedRooms.set(roomKey, { session, detached: false });
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
    this.accountEpoch += 1;
    if (this.accountId !== null) this.destroyAll();
    else {
      for (const { session } of this.unleasedRooms.values())
        session.markerStore.setOwnUserId(userId);
    }
    this.accountId = userId;
    this.authorityStore = this.createAuthorityStore(userId);
    void previous?.close();
    void this.authorityStore.retryPendingPurges();
  }

  destroyAll(): void {
    this.accountEpoch += 1;
    this.retainedByOwner.clear();
    this.unleasedRetainedByOwner.clear();
    this.liveDocCapWarningEmitted = false;
    for (const timer of this.pendingTeardownTimers.values()) clearTimeout(timer);
    this.pendingTeardownTimers.clear();
    for (const state of this.liveRooms.values()) void state.session?.destroy();
    for (const { session } of this.unleasedRooms.values()) void session.destroy();
    this.liveRooms.clear();
    this.unleasedRooms.clear();
  }

  private configuredAuthority(): { accountId: AccountId; store: AuthorityStore } {
    if (!this.accountId || !this.authorityStore) {
      throw new DocumentSessionAuthorityError(
        "account-unconfigured",
        "Session account is not configured",
      );
    }
    return { accountId: this.accountId, store: this.authorityStore };
  }

  private async runAuthorityOperation<T>(
    documentId: DocumentId,
    operation: (context: {
      accountId: AccountId;
      store: AuthorityStore;
      epoch: number;
    }) => Promise<T>,
  ): Promise<T> {
    const { accountId, store } = this.configuredAuthority();
    const epoch = this.accountEpoch;
    const key = `${encodeURIComponent(accountId)}/${encodeURIComponent(documentId)}`;
    const previous = this.authorityOperations.get(key) ?? Promise.resolve();
    let result!: T;
    const current = previous
      .catch(() => undefined)
      .then(async () => {
        this.assertAccountEpoch(accountId, epoch);
        try {
          result = await operation({ accountId, store, epoch });
        } catch (error) {
          this.assertAccountEpoch(accountId, epoch);
          throw error;
        }
      });
    this.authorityOperations.set(key, current);
    try {
      await current;
      return result;
    } finally {
      if (this.authorityOperations.get(key) === current) this.authorityOperations.delete(key);
    }
  }

  private assertAccountEpoch(accountId: AccountId, epoch: number): void {
    if (this.accountId !== accountId || this.accountEpoch !== epoch) {
      throw new DocumentSessionAuthorityError(
        "account-mismatch",
        "Session account changed during the authority operation",
      );
    }
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
    for (const owner of keep.values()) {
      const state = this.requireLease(owner.lease);
      this.getOrCreateLiveSession(owner.lease, state, !owner.detached);
    }
    for (const [documentId, state] of this.liveRooms) {
      if (state.session && !keep.has(documentId)) {
        this.scheduleTeardown(documentId);
      }
    }
  }

  private scheduleTeardown(roomKey: string): void {
    if (this.pendingTeardownTimers.has(roomKey)) return;
    const timer = setTimeout(() => {
      this.pendingTeardownTimers.delete(roomKey);
      const state = this.liveRooms.get(roomKey);
      if (state?.session) {
        if (this.isRetained(roomKey)) return;
        const session = state.session;
        state.session = null;
        void session.destroy();
        return;
      }
      const unleased = this.unleasedRooms.get(roomKey);
      if (!unleased || this.isUnleasedRetained(roomKey)) return;
      this.unleasedRooms.delete(roomKey);
      void unleased.session.destroy();
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
    return false;
  }

  private isUnleasedRetained(roomKey: string): boolean {
    for (const retained of this.unleasedRetainedByOwner.values()) {
      if (retained.roomKeys.has(roomKey)) return true;
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
    observers.set(observer, this.peekAnyRoom(roomKey)?.subscribe(observer));
    return () => {
      observers?.get(observer)?.();
      observers?.delete(observer);
      if (observers?.size === 0) this.sessionObservers.delete(roomKey);
    };
  }

  private reconcileUnleasedSessions(): void {
    const keep = new Set<string>();
    const attach = new Set<string>();
    for (const retained of this.unleasedRetainedByOwner.values()) {
      for (const roomKey of retained.roomKeys) {
        keep.add(roomKey);
        if (!retained.detachedRoomKeys.has(roomKey)) attach.add(roomKey);
      }
    }
    for (const roomKey of keep) {
      if (parseYjsRoomName(roomKey)?.kind === "branch") this.getBranchRoom(roomKey);
      else this.temporaryGetLive(roomKey, !attach.has(roomKey));
    }
    for (const roomKey of this.unleasedRooms.keys()) {
      if (!keep.has(roomKey)) this.scheduleTeardown(roomKey);
    }
  }

  private peekAnyRoom(roomKey: string): DocumentSession | undefined {
    return (
      this.unleasedRooms.get(roomKey)?.session ?? this.liveRooms.get(roomKey)?.session ?? undefined
    );
  }

  private async retireUnleasedLiveRoom(documentId: DocumentId): Promise<void> {
    const room = this.unleasedRooms.get(documentId);
    if (!room) return;
    this.cancelPendingTeardown(documentId);
    this.unleasedRooms.delete(documentId);
    for (const retained of this.unleasedRetainedByOwner.values()) {
      retained.roomKeys.delete(documentId);
      retained.detachedRoomKeys.delete(documentId);
    }
    await room.session.destroy();
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
    const roomKeys = new Set(openRoomKeys);
    const branchKeys = new Set(
      [...roomKeys].filter((roomKey) => parseYjsRoomName(roomKey)?.kind === "branch"),
    );
    const liveKeys = new Set([...roomKeys].filter((roomKey) => !branchKeys.has(roomKey)));
    const detached = new Set(options.detachedRoomKeys);
    if (branchKeys.size > 0 && liveKeys.size === 0) {
      this.retainBranchRooms(ownerId, branchKeys);
      return;
    }
    this.unleasedRetainedByOwner.set(ownerId, {
      roomKeys: new Set([...branchKeys, ...liveKeys]),
      detachedRoomKeys: new Set([...detached].filter((roomKey) => liveKeys.has(roomKey))),
    });
    this.reconcileUnleasedSessions();
  }

  temporaryPeek(roomKey: string): DocumentSession | undefined {
    const room = parseYjsRoomName(roomKey);
    return room?.kind === "branch"
      ? this.unleasedRooms.get(roomKey)?.session
      : this.unleasedRooms.get(roomKey)?.session;
  }

  async temporaryRevokeRoom(roomKey: string): Promise<void> {
    this.cancelPendingTeardown(roomKey);
    for (const retained of this.unleasedRetainedByOwner.values()) {
      retained.roomKeys.delete(roomKey);
      retained.detachedRoomKeys.delete(roomKey);
    }
    const room = this.unleasedRooms.get(roomKey);
    this.unleasedRooms.delete(roomKey);
    await room?.session.destroy();
  }

  temporaryRelease(ownerId: string): void {
    this.releaseBranchRooms(ownerId);
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
    if (this.liveRooms.get(documentId)?.leases.size) {
      throw new DocumentSessionAuthorityError(
        "stale-lease",
        `Legacy acquisition is unavailable after admission for ${documentId}`,
      );
    }
    this.cancelPendingTeardown(documentId);
    const existing = this.unleasedRooms.get(documentId);
    if (existing) {
      if (!detached && existing.session.getSnapshot().status === "detached") {
        this.attachSessionTransport(existing.session);
        existing.detached = false;
      }
      return existing.session;
    }
    const session = this.createSession(documentId, false);
    this.unleasedRooms.set(documentId, { session, detached });
    if (!detached) this.attachSessionTransport(session);
    return session;
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
    release: (owner) => registry.temporaryRelease(owner),
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
