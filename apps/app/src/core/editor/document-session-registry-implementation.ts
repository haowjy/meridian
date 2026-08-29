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
  compareAvailabilityGeneration,
  documentSessionPersistenceKey,
} from "./document-session-authority-store";
import {
  createDocumentSessionCrossContextCoordination,
  DocumentSessionCoordinationError,
  type DocumentSessionCrossContextCoordination,
  type LocalSessionAuthority,
} from "./document-session-cross-context-coordination";
import { readSchemaFenceQuarantine, writeSchemaFenceQuarantine } from "./schema-fence";

const LIVE_DOC_SOFT_CAP = 50;
const SESSION_TEARDOWN_GRACE_MS = 3_000;

type LiveRoomState = {
  session: DocumentSession | null;
  persistenceGeneration: AvailabilityGeneration | null;
  leases: Map<ProjectId, LiveDocumentSessionLease>;
};

type RetainedLiveDocument = { lease: LiveDocumentSessionLease; detached: boolean };

type UnleasedRoomState = { session: DocumentSession; detached: boolean };

export class DocumentSessionAuthorityError extends Error {
  constructor(
    readonly kind:
      | "account-unconfigured"
      | "authority-unavailable"
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

export class DocumentSessionRegistry
  implements LiveDocumentSessionAuthority, LocalSessionAuthority
{
  private accountId: AccountId | null = null;
  private coordination: DocumentSessionCrossContextCoordination | null = null;
  private accountTransition: Promise<void> = Promise.resolve();
  private accountTransitionVersion = 0;
  private authorityFailure: unknown = null;
  private readonly liveRooms = new Map<DocumentId, LiveRoomState>();
  private readonly unleasedRooms = new Map<string, UnleasedRoomState>();
  private readonly retainedByOwner = new Map<string, Map<DocumentId, RetainedLiveDocument>>();
  private readonly unleasedRetainedByOwner = new Map<
    string,
    { roomKeys: Set<string>; detachedRoomKeys: Set<string> }
  >();
  private readonly admissionReservations = new Map<DocumentId, number>();
  private readonly pendingTeardownTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private liveDocCapWarningEmitted = false;
  private readonly sessionObservers = new Map<
    string,
    Map<(snapshot: DocumentSessionSnapshot) => void, (() => void) | undefined>
  >();

  constructor(
    private readonly createCoordination: (
      accountId: AccountId,
      local: LocalSessionAuthority,
    ) => DocumentSessionCrossContextCoordination = (accountId, local) =>
      createDocumentSessionCrossContextCoordination({ accountId, local }),
    private readonly teardownGraceMs = SESSION_TEARDOWN_GRACE_MS,
  ) {}

  async admit(
    projectId: ProjectId,
    documentId: DocumentId,
    generation: AvailabilityGeneration,
  ): Promise<LiveDocumentSessionLease> {
    compareAvailabilityGeneration(generation, generation);
    this.reserveAdmission(documentId);
    try {
      const coordination = await this.configuredCoordination();
      const admitted = await this.translateCoordination(() =>
        coordination.admit(projectId, documentId, generation),
      );
      return {
        accountId: admitted.accountId,
        projectId: admitted.projectId,
        documentId: admitted.documentId,
        generation: admitted.generation,
      };
    } finally {
      this.releaseAdmissionReservation(documentId);
    }
  }

  async revokeDocument(
    _projectId: ProjectId,
    documentId: DocumentId,
    generation: AvailabilityGeneration,
    commandId: AvailabilityCommandId,
  ): Promise<{ revokedThrough: AvailabilityGeneration; persistence: "cleared" }> {
    compareAvailabilityGeneration(generation, generation);
    const coordination = await this.configuredCoordination();
    return this.translateCoordination(() =>
      coordination.revokeDocument(_projectId, documentId, generation, commandId),
    );
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
    const coordination = await this.configuredCoordination();
    return this.translateCoordination(() =>
      coordination.revokeAccess(projectId, documentId, generation, commandId),
    );
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
    const transitionVersion = ++this.accountTransitionVersion;
    const previous = this.coordination;
    this.accountId = userId;
    this.coordination = null;
    this.authorityFailure = null;
    const closePrevious = previous?.close() ?? this.invalidateAll();
    const transition = this.accountTransition
      .catch(() => undefined)
      .then(async () => {
        await closePrevious;
        if (this.accountId !== userId || this.accountTransitionVersion !== transitionVersion)
          return;
        try {
          this.coordination = this.createCoordination(userId, this);
        } catch (error) {
          this.authorityFailure = error;
        }
      });
    this.accountTransition = transition;
  }

  destroyAll(): void {
    this.accountTransitionVersion += 1;
    const captured = this.coordination;
    this.coordination = null;
    const capturedClose = captured?.close();
    this.accountTransition = this.accountTransition
      .catch(() => undefined)
      .then(async () => {
        const current = this.coordination;
        this.coordination = null;
        if (current && current !== captured) {
          await current.close();
          return;
        }
        await (capturedClose ?? this.invalidateAll());
      });
  }

  async invalidateAll(): Promise<void> {
    this.retainedByOwner.clear();
    this.unleasedRetainedByOwner.clear();
    this.liveDocCapWarningEmitted = false;
    for (const timer of this.pendingTeardownTimers.values()) clearTimeout(timer);
    this.pendingTeardownTimers.clear();
    const sessions = [
      ...[...this.liveRooms.values()].flatMap(({ session }) => (session ? [session] : [])),
      ...[...this.unleasedRooms.values()].map(({ session }) => session),
    ];
    this.liveRooms.clear();
    this.unleasedRooms.clear();
    await Promise.all(sessions.map((session) => session.destroy()));
  }

  private async configuredCoordination(): Promise<DocumentSessionCrossContextCoordination> {
    await this.accountTransition;
    if (!this.accountId) {
      throw new DocumentSessionAuthorityError(
        "account-unconfigured",
        "Session account is not configured",
      );
    }
    if (!this.coordination) {
      const error = this.authorityFailure;
      if (error instanceof DocumentSessionCoordinationError) {
        throw new DocumentSessionAuthorityError(error.kind, error.message);
      }
      throw new DocumentSessionAuthorityError(
        "authority-unavailable",
        "Live document authority is unavailable",
      );
    }
    return this.coordination;
  }

  private async translateCoordination<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof DocumentSessionCoordinationError) {
        throw new DocumentSessionAuthorityError(error.kind, error.message);
      }
      throw error;
    }
  }

  validateAdmission(input: {
    documentId: DocumentId;
    projectId: ProjectId;
    generation: AvailabilityGeneration;
  }): void {
    const existing = this.liveRooms.get(input.documentId)?.leases.get(input.projectId);
    if (existing && compareAvailabilityGeneration(input.generation, existing.generation) < 0) {
      throw new DocumentSessionAuthorityError(
        "stale-lease",
        `A newer lease already exists for ${input.documentId}`,
      );
    }
  }

  installSynchronously(input: {
    documentId: DocumentId;
    projectId: ProjectId;
    generation: AvailabilityGeneration;
    persistenceGeneration: AvailabilityGeneration;
  }): void {
    if (!this.accountId) return;
    const lease = {
      accountId: this.accountId,
      projectId: input.projectId,
      documentId: input.documentId,
      generation: input.generation,
    };
    const state = this.liveRooms.get(input.documentId) ?? {
      session: null,
      persistenceGeneration: input.persistenceGeneration,
      leases: new Map(),
    };
    state.persistenceGeneration = input.persistenceGeneration;
    state.leases.set(input.projectId, lease);
    this.liveRooms.set(input.documentId, state);
  }

  async drainDocument(input: {
    documentId: DocumentId;
    generation: AvailabilityGeneration;
    incarnation: AvailabilityGeneration | null;
  }): Promise<void> {
    const state = this.liveRooms.get(input.documentId);
    if (!state || state.persistenceGeneration !== input.incarnation) return;
    this.cancelPendingTeardown(input.documentId);
    for (const retained of this.retainedByOwner.values()) retained.delete(input.documentId);
    this.liveRooms.delete(input.documentId);
    await state.session?.destroy();
  }

  async drainAccess(input: {
    documentId: DocumentId;
    projectId: ProjectId;
    generation: AvailabilityGeneration;
    incarnation: AvailabilityGeneration | null;
  }): Promise<"other-local-project-remains" | "locally-empty"> {
    const state = this.liveRooms.get(input.documentId);
    if (!state || state.persistenceGeneration !== input.incarnation) return "locally-empty";
    state.leases.delete(input.projectId);
    this.removeRetainedProjectLease(input.projectId, input.documentId);
    if (state.leases.size > 0) return "other-local-project-remains";
    this.cancelPendingTeardown(input.documentId);
    this.liveRooms.delete(input.documentId);
    await state.session?.destroy();
    return "locally-empty";
  }

  private reserveAdmission(documentId: DocumentId): void {
    this.admissionReservations.set(
      documentId,
      (this.admissionReservations.get(documentId) ?? 0) + 1,
    );
  }

  private releaseAdmissionReservation(documentId: DocumentId): void {
    const count = this.admissionReservations.get(documentId) ?? 0;
    if (count <= 1) this.admissionReservations.delete(documentId);
    else this.admissionReservations.set(documentId, count - 1);
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

  private removeRetainedProjectLease(projectId: ProjectId, documentId: DocumentId): void {
    for (const retained of this.retainedByOwner.values()) {
      if (retained.get(documentId)?.lease.projectId === projectId) retained.delete(documentId);
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

  async retireLegacy(documentId: DocumentId): Promise<void> {
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
    for (const documentId of liveKeys) this.assertNoAdmissionReservation(documentId);
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
    if (room?.kind === "live") this.assertNoAdmissionReservation(roomKey);
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
    this.assertNoAdmissionReservation(documentId);
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

  private assertNoAdmissionReservation(documentId: DocumentId): void {
    if (!this.admissionReservations.has(documentId)) return;
    throw new DocumentSessionAuthorityError(
      "stale-lease",
      `Legacy acquisition is unavailable during admission for ${documentId}`,
    );
  }
}
