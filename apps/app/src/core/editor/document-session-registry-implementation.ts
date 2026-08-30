/**
 * Account-scoped owner of live document sessions and generation-fenced branch rooms.
 * Live acquisition is lease-required; branch rooms remain generation-qualified.
 */
import type {
  AccountId,
  AvailabilityCommandId,
  AvailabilityGeneration,
  LiveDocumentSessionAuthority,
  LiveDocumentSessionLease,
} from "@meridian/contracts/protocol";
import { parseYjsRoomName } from "@meridian/contracts/protocol";
import type { DocumentId, ProjectId } from "@meridian/contracts/runtime";

import { createHocuspocusDocumentTransport } from "@/core/transport/hocuspocus-document-transport";
import type { DocumentSessionTransportFactory } from "./document-session";
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
import type {
  LocalUntitledDocumentSessionFactory,
  RetainedLiveDocumentReference,
} from "./document-session-registry";
import type {
  LocalDocumentSessionAdoptionPort,
  LocalDocumentSessionHandoff,
  LocalDocumentSessionReservationPort,
  LocalDocumentSessionTransfer,
} from "./local-document-session-adoption";
import { readSchemaFenceQuarantine, writeSchemaFenceQuarantine } from "./schema-fence";

const LIVE_DOC_SOFT_CAP = 50;
const SESSION_TEARDOWN_GRACE_MS = 3_000;

type LiveRoomState = {
  session: DocumentSession | null;
  persistenceGeneration: AvailabilityGeneration | null;
  leases: Map<ProjectId, LiveDocumentSessionLease>;
};

type RetainedLiveDocument = { lease: LiveDocumentSessionLease; detached: boolean };

type LocalTransferReservation = {
  handoff: LocalDocumentSessionHandoff;
  transfer: LocalDocumentSessionTransfer;
  settled: Promise<void>;
  settle(): void;
};

type AdoptionFinalizer = {
  closeProvider(): Promise<void>;
  releaseLease(): Promise<void>;
  providerClosed: boolean;
  leaseReleased: boolean;
  inFlight: Promise<void> | null;
};

function localTransferKey(projectId: ProjectId, documentId: DocumentId): string {
  return `${encodeURIComponent(projectId)}:${encodeURIComponent(documentId)}`;
}

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
  implements
    LiveDocumentSessionAuthority,
    LocalSessionAuthority,
    LocalUntitledDocumentSessionFactory,
    LocalDocumentSessionReservationPort,
    LocalDocumentSessionAdoptionPort
{
  private accountId: AccountId | null = null;
  private coordination: DocumentSessionCrossContextCoordination | null = null;
  private authorityFailure: unknown = null;
  private accountRuntimeState: "open" | "closing" = "open";
  private invalidationPromise: Promise<void> | null = null;
  private readonly liveRooms = new Map<DocumentId, LiveRoomState>();
  private readonly branchRooms = new Map<string, DocumentSession>();
  private readonly retainedByOwner = new Map<string, Map<DocumentId, RetainedLiveDocument>>();
  private readonly retainedObservers = new Set<
    (snapshot: readonly RetainedLiveDocumentReference[]) => void
  >();
  private readonly retainedBranchRoomsByOwner = new Map<string, Set<string>>();
  private readonly admissionReservations = new Map<DocumentId, number>();
  private readonly localTransferReservations = new Map<string, LocalTransferReservation>();
  private readonly pendingAdoptionFinalizers = new Set<AdoptionFinalizer>();
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
    accountId?: AccountId,
    private readonly transportFactory: DocumentSessionTransportFactory = ({
      roomKey,
      document,
      awareness,
    }) => createHocuspocusDocumentTransport({ roomName: roomKey, document, awareness }),
  ) {
    if (!accountId) return;
    this.accountId = accountId;
    try {
      this.coordination = this.createCoordination(accountId, this);
    } catch (error) {
      this.authorityFailure = error;
    }
  }

  async admit(
    projectId: ProjectId,
    documentId: DocumentId,
    generation: AvailabilityGeneration,
  ): Promise<LiveDocumentSessionLease> {
    this.requireAccountRuntimeOpen();
    compareAvailabilityGeneration(generation, generation);
    this.reserveAdmission(documentId);
    try {
      await this.localTransferReservations.get(localTransferKey(projectId, documentId))?.settled;
      this.requireAccountRuntimeOpen();
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
    this.publishRetainedLiveDocuments();
  }

  release(ownerId: string): void {
    if (!this.retainedByOwner.delete(ownerId)) return;
    this.reconcileRetainedSessions();
    this.publishRetainedLiveDocuments();
  }

  observeRetainedLiveDocuments(
    observer: (snapshot: readonly RetainedLiveDocumentReference[]) => void,
  ): () => void {
    this.retainedObservers.add(observer);
    this.notifyRetainedObserver(observer, this.retainedSnapshot());
    return () => this.retainedObservers.delete(observer);
  }

  retainBranchRooms(ownerId: string, roomKeys: Iterable<string>): void {
    const keys = new Set(roomKeys);
    for (const roomKey of keys) {
      if (parseYjsRoomName(roomKey)?.kind !== "branch") {
        throw new Error(`Branch retention requires a branch room: ${roomKey}`);
      }
    }
    this.retainedBranchRoomsByOwner.set(ownerId, keys);
    this.reconcileBranchRooms();
  }

  releaseBranchRooms(ownerId: string): void {
    this.retainedBranchRoomsByOwner.delete(ownerId);
    this.reconcileBranchRooms();
  }

  getBranchRoom(roomKey: string): DocumentSession {
    const room = parseYjsRoomName(roomKey);
    if (room?.kind !== "branch")
      throw new Error(`Branch session requires a branch room: ${roomKey}`);
    this.cancelPendingTeardown(roomKey);
    const existing = this.branchRooms.get(roomKey);
    if (existing) return existing;
    const session = this.createSession(roomKey, { kind: "none" });
    this.attachSessionTransport(session);
    session.subscribe((snapshot) => {
      if (snapshot.connectionState?.kind !== "reset") return;
      void session
        .destroy()
        .finally(() => {
          if (this.branchRooms.get(roomKey) === session) this.branchRooms.delete(roomKey);
        })
        .catch(() => undefined);
    });
    this.branchRooms.set(roomKey, session);
    return session;
  }

  localUntitledDocumentSessionFactory(): LocalUntitledDocumentSessionFactory {
    return this;
  }

  createDetached(input: {
    accountId: AccountId;
    projectId: ProjectId;
    documentId: DocumentId;
    persistenceKey: string;
  }): DocumentSession {
    this.requireAccountRuntimeOpen();
    if (input.accountId !== this.accountId) {
      throw new DocumentSessionAuthorityError(
        "account-mismatch",
        "Local Untitled construction belongs to a different account epoch",
      );
    }
    return this.constructSession(input.documentId, {
      kind: "indexeddb",
      key: input.persistenceKey,
    });
  }

  reserve(transfer: LocalDocumentSessionTransfer): LocalDocumentSessionHandoff {
    this.requireAccountRuntimeOpen();
    const key = localTransferKey(transfer.projectId, transfer.documentId);
    const existing = this.localTransferReservations.get(key);
    if (existing) {
      if (
        existing.transfer.session === transfer.session &&
        existing.transfer.projectId === transfer.projectId &&
        existing.transfer.ownerRevision === transfer.ownerRevision
      ) {
        return existing.handoff;
      }
      throw new Error("A different local transfer already reserves this document");
    }
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const handoff = Object.freeze({}) as LocalDocumentSessionHandoff;
    this.localTransferReservations.set(key, {
      handoff,
      transfer,
      settled,
      settle,
    });
    return handoff;
  }

  abort(handoff: LocalDocumentSessionHandoff): void {
    for (const [key, reservation] of this.localTransferReservations) {
      if (reservation.handoff !== handoff) continue;
      this.localTransferReservations.delete(key);
      reservation.settle();
      return;
    }
    throw new Error("Local document handoff is not reserved");
  }

  async admitAndAdopt(input: {
    projectId: ProjectId;
    documentId: DocumentId;
    generation: AvailabilityGeneration;
    handoff: LocalDocumentSessionHandoff;
  }): Promise<{ lease: LiveDocumentSessionLease; session: DocumentSession }> {
    this.requireAccountRuntimeOpen();
    compareAvailabilityGeneration(input.generation, input.generation);
    const reservationKey = localTransferKey(input.projectId, input.documentId);
    const reservation = this.localTransferReservations.get(reservationKey);
    if (
      !reservation ||
      reservation.handoff !== input.handoff ||
      reservation.transfer.projectId !== input.projectId ||
      reservation.transfer.documentId !== input.documentId
    ) {
      throw new Error("Local document handoff does not own this reservation");
    }
    const coordination = await this.configuredCoordination();
    if (!coordination.admitAndRun)
      throw new Error("Cross-context coordination cannot adopt a local session");
    const cleanup: { closePrevious?: () => Promise<void> } = {};
    const result = await this.translateCoordination(
      () =>
        coordination.admitAndRun?.(
          input.projectId,
          input.documentId,
          input.generation,
          async (admitted) => {
            this.requireAccountRuntimeOpen();
            if (this.localTransferReservations.get(reservationKey) !== reservation)
              throw new Error("Local document reservation changed during admission");
            const state = this.liveRooms.get(input.documentId);
            if (!state || state.session) throw new Error("A different live session won adoption");
            const stage = await reservation.transfer.session.stageIndexedDbPersistence(
              documentSessionPersistenceKey(
                this.accountId as AccountId,
                input.documentId,
                admitted.persistenceGeneration,
              ),
            );
            try {
              this.requireAccountRuntimeOpen();
              if (
                this.localTransferReservations.get(reservationKey) !== reservation ||
                this.liveRooms.get(input.documentId) !== state ||
                state.session
              ) {
                throw new Error("Local adoption lost its exact reservation");
              }
              reservation.transfer.prepareCommit();
              const stageCleanup = stage.commit();
              cleanup.closePrevious = stageCleanup.closePrevious;
              state.session = reservation.transfer.session;
              state.persistenceGeneration = admitted.persistenceGeneration;
              reservation.transfer.commit();
              this.localTransferReservations.delete(reservationKey);
              reservation.settle();
            } catch (error) {
              await stage.abort();
              throw error;
            }
          },
        ) as Promise<{
          admitted: LiveDocumentSessionLease & { persistenceGeneration: AvailabilityGeneration };
          value: undefined;
        }>,
    );
    const session = reservation.transfer.session;
    const finalizer: AdoptionFinalizer = {
      closeProvider: () => cleanup.closePrevious?.() ?? Promise.resolve(),
      releaseLease: () => reservation.transfer.finalize(),
      providerClosed: false,
      leaseReleased: false,
      inFlight: null,
    };
    this.pendingAdoptionFinalizers.add(finalizer);
    try {
      await this.settleAdoptionFinalizer(finalizer);
      this.pendingAdoptionFinalizers.delete(finalizer);
    } catch {
      // Canonical authority already committed. Retain the finalizer (and HL)
      // for a later open/teardown retry rather than misreporting adoption.
    }
    try {
      this.attachSessionTransport(session);
    } catch {
      // A later bind/open retries attachment on this same canonical session.
    }
    return { lease: result.admitted, session };
  }

  beginCloseAccountRuntime(): void {
    if (this.accountRuntimeState === "closing") return;
    this.accountRuntimeState = "closing";
    for (const reservation of this.localTransferReservations.values()) reservation.settle();
    this.localTransferReservations.clear();
    this.coordination?.beginClose();
  }

  closeAccountRuntime(): Promise<void> {
    this.beginCloseAccountRuntime();
    return this.retryAdoptionFinalizers().then(async () => {
      const coordination = this.coordination;
      await (coordination?.close() ?? this.invalidateAll());
      if (this.coordination === coordination) this.coordination = null;
    });
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

  invalidateAll(): Promise<void> {
    if (this.invalidationPromise) return this.invalidationPromise;
    this.clearRetainedLiveDocuments();
    this.retainedBranchRoomsByOwner.clear();
    this.liveDocCapWarningEmitted = false;
    for (const timer of this.pendingTeardownTimers.values()) clearTimeout(timer);
    this.pendingTeardownTimers.clear();
    const sessions = [
      ...[...this.liveRooms.values()].flatMap(({ session }) => (session ? [session] : [])),
      ...this.branchRooms.values(),
    ];
    this.liveRooms.clear();
    this.branchRooms.clear();
    const invalidation = async () => {
      const results = await Promise.allSettled(sessions.map((session) => session.destroy()));
      const errors = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, "Session registry teardown failed");
    };
    const pending = invalidation();
    this.invalidationPromise = pending;
    void pending
      .finally(() => {
        if (this.invalidationPromise === pending) this.invalidationPromise = null;
      })
      .catch(() => undefined);
    return pending;
  }

  private clearRetainedLiveDocuments(): void {
    const hadRetainedReferences = [...this.retainedByOwner.values()].some(
      (retained) => retained.size > 0,
    );
    this.retainedByOwner.clear();
    if (hadRetainedReferences) this.publishRetainedLiveDocuments();
  }

  private async configuredCoordination(): Promise<DocumentSessionCrossContextCoordination> {
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
    this.requireAccountRuntimeOpen();
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
    let retainedChanged = false;
    for (const retained of this.retainedByOwner.values()) {
      retainedChanged = retained.delete(input.documentId) || retainedChanged;
    }
    if (retainedChanged) this.publishRetainedLiveDocuments();
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
    if (this.removeRetainedProjectLease(input.projectId, input.documentId)) {
      this.publishRetainedLiveDocuments();
    }
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
    if (state.session) {
      if (attach && state.session.getSnapshot().status === "detached") {
        this.attachSessionTransport(state.session);
      }
      void this.retryAdoptionFinalizers().catch(() => undefined);
      return state.session;
    }
    state.persistenceGeneration ??= lease.generation;
    const session = this.createSession(lease.documentId, {
      kind: "indexeddb",
      key: documentSessionPersistenceKey(
        lease.accountId,
        lease.documentId,
        state.persistenceGeneration,
      ),
    });
    state.session = session;
    if (attach) this.attachSessionTransport(session);
    this.maybeWarnLiveDocCap();
    return session;
  }

  private createSession(
    roomKey: string,
    persistence: { kind: "indexeddb"; key: string } | { kind: "none" },
  ): DocumentSession {
    const session = this.constructSession(roomKey, persistence);
    this.publishSession(roomKey, session);
    return session;
  }

  private constructSession(
    roomKey: string,
    persistence: { kind: "indexeddb"; key: string } | { kind: "none" },
  ): DocumentSession {
    const session = new DocumentSession({
      roomKey,
      persistence,
      ownUserId: this.accountId,
      persistSchemaFence: (fence) => writeSchemaFenceQuarantine(roomKey, fence),
    });
    const quarantine = readSchemaFenceQuarantine(roomKey);
    if (quarantine) session.raiseSchemaFence(quarantine);
    return session;
  }

  private requireAccountRuntimeOpen(): void {
    if (this.accountRuntimeState !== "open") {
      throw new Error("Account document session runtime is closing");
    }
  }

  private attachSessionTransport(session: DocumentSession): void {
    if (session.getSnapshot().schemaFence) return;
    session.attachTransport(this.transportFactory);
  }

  private async retryAdoptionFinalizers(): Promise<void> {
    const pending = [...this.pendingAdoptionFinalizers];
    const failures: unknown[] = [];
    for (const finalize of pending) {
      try {
        await this.settleAdoptionFinalizer(finalize);
        this.pendingAdoptionFinalizers.delete(finalize);
      } catch (error) {
        // The exact finalizer remains owned for the next canonical retry.
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Adoption finalization failed");
  }

  private settleAdoptionFinalizer(finalizer: AdoptionFinalizer): Promise<void> {
    if (finalizer.inFlight) return finalizer.inFlight;
    const attempt = (async () => {
      if (!finalizer.providerClosed) {
        await finalizer.closeProvider();
        finalizer.providerClosed = true;
      }
      if (!finalizer.leaseReleased) {
        await finalizer.releaseLease();
        finalizer.leaseReleased = true;
      }
    })().finally(() => {
      if (finalizer.inFlight === attempt) finalizer.inFlight = null;
    });
    finalizer.inFlight = attempt;
    return attempt;
  }

  private removeRetainedProjectLease(projectId: ProjectId, documentId: DocumentId): boolean {
    let changed = false;
    for (const retained of this.retainedByOwner.values()) {
      if (retained.get(documentId)?.lease.projectId === projectId) {
        retained.delete(documentId);
        changed = true;
      }
    }
    return changed;
  }

  private retainedSnapshot(): readonly RetainedLiveDocumentReference[] {
    const references = new Map<string, RetainedLiveDocumentReference>();
    for (const retained of this.retainedByOwner.values()) {
      for (const { lease } of retained.values()) {
        const reference = Object.freeze({
          projectId: lease.projectId,
          documentId: lease.documentId,
        });
        references.set(`${lease.projectId}\0${lease.documentId}`, reference);
      }
    }
    return Object.freeze(
      [...references.values()].sort(
        (left, right) =>
          left.projectId.localeCompare(right.projectId) ||
          left.documentId.localeCompare(right.documentId),
      ),
    );
  }

  private publishRetainedLiveDocuments(): void {
    const snapshot = this.retainedSnapshot();
    for (const observer of this.retainedObservers) this.notifyRetainedObserver(observer, snapshot);
  }

  private notifyRetainedObserver(
    observer: (snapshot: readonly RetainedLiveDocumentReference[]) => void,
    snapshot: readonly RetainedLiveDocumentReference[],
  ): void {
    try {
      observer(snapshot);
    } catch {
      // A diagnostic observer cannot interrupt the registry's lease transaction.
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
        void session.destroy().catch(() => undefined);
        return;
      }
      const branch = this.branchRooms.get(roomKey);
      if (!branch || this.isBranchRetained(roomKey)) return;
      this.branchRooms.delete(roomKey);
      void branch.destroy().catch(() => undefined);
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

  private isBranchRetained(roomKey: string): boolean {
    for (const retained of this.retainedBranchRoomsByOwner.values()) {
      if (retained.has(roomKey)) return true;
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
    observers.set(
      observer,
      (this.branchRooms.get(roomKey) ?? this.liveRooms.get(roomKey)?.session)?.subscribe(observer),
    );
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

  private reconcileBranchRooms(): void {
    const keep = new Set<string>();
    for (const retained of this.retainedBranchRoomsByOwner.values()) {
      for (const roomKey of retained) keep.add(roomKey);
    }
    for (const roomKey of keep) this.getBranchRoom(roomKey);
    for (const roomKey of this.branchRooms.keys()) {
      if (!keep.has(roomKey)) this.scheduleTeardown(roomKey);
    }
  }
}
