/** Account-qualified owner of durable pre-authority Untitled sessions. */
import type { AccountId } from "@meridian/contracts/protocol";
import { collabSchemaKeyTag } from "@meridian/prosemirror-schema";
import type { DocumentSession, DocumentSessionSnapshot } from "@/core/editor/document-session";
import type {
  LocalUntitledCrossContextLease,
  LocalUntitledCrossContextLeasePort,
} from "@/core/editor/document-session-cross-context-coordination";
import type { LocalUntitledDocumentSessionFactory } from "@/core/editor/document-session-registry";
import type {
  LocalDocumentSessionHandoff,
  LocalDocumentSessionReservationPort,
} from "@/core/editor/local-document-session-adoption";
import type {
  LocalUntitledKey,
  LocalUntitledRecord,
  LocalUntitledRecordStore,
} from "./local-untitled-record-store";
import { encodeLocalUntitledKey } from "./local-untitled-record-store";

export type LocalUntitledSession = Readonly<{
  key: LocalUntitledKey;
  session: DocumentSession;
}>;

export type LocalUntitledOpenResult =
  | { kind: "opened"; value: LocalUntitledSession }
  | { kind: "owned-elsewhere" };

export class LocalUntitledIdentityRedirect extends Error {
  constructor(readonly key: LocalUntitledKey) {
    super(`Local Untitled identity moved to ${key.documentId}`);
    this.name = "LocalUntitledIdentityRedirect";
  }
}

type Owned = {
  value: LocalUntitledSession;
  lease: LocalUntitledCrossContextLease;
  revision: number;
  transferring: boolean;
  handoff: LocalDocumentSessionHandoff | null;
};

type PendingFinalizer = {
  key: string;
  closeProvider(): Promise<void>;
  lease: LocalUntitledCrossContextLease;
  afterSettled?: () => void;
  providerClosed?: boolean;
  leaseReleased?: boolean;
};

export type LocalUntitledOwnerDependencies = {
  accountId: AccountId;
  records: LocalUntitledRecordStore;
  lifetime: LocalUntitledCrossContextLeasePort;
  sessions: LocalUntitledDocumentSessionFactory;
  reservations: LocalDocumentSessionReservationPort;
  newLineageId?: () => string;
};

export function localUntitledPersistenceKey(key: LocalUntitledKey): string {
  return `meridian:local-untitled:${collabSchemaKeyTag()}:${encodeURIComponent(key.accountId)}:${encodeURIComponent(key.projectId)}:${encodeURIComponent(key.documentId)}`;
}

function sameKey(left: LocalUntitledKey, right: LocalUntitledKey): boolean {
  return (
    left.accountId === right.accountId &&
    left.projectId === right.projectId &&
    left.documentId === right.documentId
  );
}

export class LocalUntitledOwner {
  readonly accountId: AccountId;
  private readonly owned = new Map<string, Owned>();
  private readonly retained = new Map<string, Set<string>>();
  private readonly pendingFinalizers = new Map<string, PendingFinalizer>();
  private closePromise: Promise<void> | null = null;
  private closing = false;

  constructor(dependencies: LocalUntitledOwnerDependencies) {
    this.dependencies = dependencies;
    this.accountId = dependencies.accountId;
  }

  private readonly dependencies: LocalUntitledOwnerDependencies;

  key(
    projectId: LocalUntitledKey["projectId"],
    documentId: LocalUntitledKey["documentId"],
  ): LocalUntitledKey {
    return { accountId: this.accountId, projectId, documentId };
  }

  phase(key: LocalUntitledKey): LocalUntitledRecord["phase"] | null {
    this.requireQualified(key);
    return this.dependencies.records.read(key)?.phase ?? null;
  }

  readWork(key: LocalUntitledKey): LocalUntitledRecord | null {
    this.requireQualified(key);
    return this.dependencies.records.read(key);
  }

  listWork(): readonly LocalUntitledRecord[] {
    return this.dependencies.records.list(this.accountId);
  }

  writeWork(record: LocalUntitledRecord): void {
    this.requireQualified(record.key);
    this.dependencies.records.write(record);
  }

  removeWork(key: LocalUntitledKey, expectedRevision: number): "removed" | "stale" {
    this.requireQualified(key);
    return this.dependencies.records.remove(key, expectedRevision);
  }

  create(key: LocalUntitledKey): Promise<LocalUntitledOpenResult> {
    return this.open(key, "create");
  }

  restore(key: LocalUntitledKey): Promise<LocalUntitledOpenResult> {
    return this.open(key, "restore");
  }

  getDetached(key: LocalUntitledKey): LocalUntitledSession | null {
    this.requireQualified(key);
    const owned = this.owned.get(encodeLocalUntitledKey(key));
    return owned && sameKey(owned.value.key, key) ? owned.value : null;
  }

  recordRevision(key: LocalUntitledKey): number | null {
    this.requireQualified(key);
    return this.dependencies.records.read(key)?.revision ?? null;
  }

  retain(ownerId: string, keys: Iterable<LocalUntitledKey>): void {
    const ids = new Set<string>();
    for (const key of keys) {
      this.requireQualified(key);
      if (this.getDetached(key)) ids.add(encodeLocalUntitledKey(key));
    }
    this.retained.set(ownerId, ids);
  }

  release(ownerId: string): void {
    this.retained.delete(ownerId);
  }

  observe(
    key: LocalUntitledKey,
    observer: (snapshot: DocumentSessionSnapshot) => void,
  ): () => void {
    const value = this.getDetached(key);
    if (!value) throw new Error("Local Untitled session is not owned in this realm");
    return value.session.subscribe(observer);
  }

  async abandon(input: {
    key: LocalUntitledKey;
    expectedRevision: number;
    evidence: "writer-empty-close" | "server-row-absent" | "remint-replaced";
  }): Promise<"abandoned" | "stale" | "busy"> {
    const pending = this.pendingFinalizers.get(encodeLocalUntitledKey(input.key));
    if (pending) {
      await this.settleFinalizer(pending, false);
      return "abandoned";
    }
    await this.retryPendingFinalizers();
    const owned = this.requireOwned(input.key);
    const record = this.dependencies.records.read(input.key);
    if (!record || record.revision !== input.expectedRevision || owned.revision !== record.revision)
      return "stale";
    if (owned.transferring || this.isRetained(input.key)) return "busy";
    if (
      input.evidence === "writer-empty-close" &&
      owned.value.session.document.getXmlFragment(owned.value.session.fragmentName).length > 0
    ) {
      return "busy";
    }
    const encoded = encodeLocalUntitledKey(input.key);
    const finalizer: PendingFinalizer = {
      key: encoded,
      closeProvider: () => owned.value.session.destroy({ clearPersistence: true }),
      lease: owned.lease,
      afterSettled: () => {
        if (this.dependencies.records.remove(input.key, input.expectedRevision) !== "removed")
          throw new Error("Local Untitled abandon revision became stale");
        this.owned.delete(encoded);
      },
    };
    this.pendingFinalizers.set(encoded, finalizer);
    await this.settleFinalizer(finalizer, false);
    return "abandoned";
  }

  async prepareMaterialization(
    key: LocalUntitledKey,
    expectedRevision: number,
  ): Promise<LocalDocumentSessionHandoff> {
    await this.retryPendingFinalizers();
    const owned = this.requireOwned(key);
    const record = this.dependencies.records.read(key);
    if (record?.phase !== "local-pending" || record.revision !== expectedRevision)
      throw new Error("Local Untitled materialization revision is stale");
    if (owned.transferring) {
      if (owned.handoff) return owned.handoff;
      throw new Error("Local Untitled transfer is already preparing");
    }
    owned.transferring = true;
    try {
      await owned.value.session.flushLocalPersistence();
      const handoff = this.reserveTransfer(key, owned, expectedRevision);
      owned.handoff = handoff;
      return handoff;
    } catch (error) {
      owned.transferring = false;
      throw error;
    }
  }

  abortMaterialization(key: LocalUntitledKey, handoff: LocalDocumentSessionHandoff): void {
    const owned = this.requireOwned(key);
    if (!owned.transferring || owned.handoff !== handoff) {
      throw new Error("Local Untitled handoff is not the active reservation");
    }
    this.dependencies.reservations.abort(handoff);
    owned.handoff = null;
    owned.transferring = false;
  }

  async remint(from: LocalUntitledKey, to: LocalUntitledKey): Promise<LocalUntitledSession> {
    await this.retryPendingFinalizers();
    const old = this.requireOwned(from);
    this.requireQualified(to);
    if (from.projectId !== to.projectId || from.documentId === to.documentId)
      throw new Error("Local Untitled remint requires a new ID in the same project");
    const replacementLease = await this.dependencies.lifetime.tryAcquire(
      to.projectId,
      to.documentId,
    );
    if (!replacementLease)
      throw new Error("Replacement local Untitled identity is owned elsewhere");
    const current = this.dependencies.records.read(from);
    if (!current || current.revision !== old.revision) {
      await replacementLease.release();
      throw new Error("Local Untitled remint revision is stale");
    }
    const nextRevision = current.revision + 1;
    const replacement: LocalUntitledRecord = {
      ...current,
      key: to,
      revision: nextRevision,
      lineageRevision: (current.lineageRevision ?? current.revision) + 1,
      active: true,
    };
    const prepared = await old.value.session.prepareDetachedReidentity(
      to.documentId,
      localUntitledPersistenceKey(to),
    );
    let cleanup: { closePrevious(): Promise<void> };
    try {
      if (old.handoff) {
        this.dependencies.reservations.abort(old.handoff);
        old.handoff = null;
        old.transferring = false;
      }
      this.dependencies.records.write({ ...replacement, active: false });
      this.dependencies.records.write(replacement);
      cleanup = prepared.commit();
    } catch (error) {
      await prepared.abort();
      await replacementLease.release();
      throw error;
    }
    try {
      this.dependencies.records.write({ ...current, active: false });
    } catch {
      // The higher active lineage revision is already authoritative.
    }
    this.owned.delete(encodeLocalUntitledKey(from));
    const value = { key: to, session: old.value.session };
    this.owned.set(encodeLocalUntitledKey(to), {
      value,
      lease: replacementLease,
      revision: nextRevision,
      transferring: false,
      handoff: null,
    });
    const next = this.requireOwned(to);
    next.transferring = true;
    next.handoff = this.reserveTransfer(to, next, nextRevision);
    const finalizer: PendingFinalizer = {
      key: encodeLocalUntitledKey(from),
      closeProvider: () => cleanup.closePrevious(),
      lease: old.lease,
    };
    this.pendingFinalizers.set(finalizer.key, finalizer);
    try {
      await this.settleFinalizer(finalizer, false);
    } catch {
      // The replacement is already authoritative. Cleanup remains owner-held GC.
    }
    return value;
  }

  destroyAll(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.retained.clear();
    const owned = [...this.owned.entries()];
    this.owned.clear();
    const finalizers = [
      ...this.pendingFinalizers.values(),
      ...owned
        .filter(([key]) => !this.pendingFinalizers.has(key))
        .map(
          ([key, entry]): PendingFinalizer => ({
            key,
            closeProvider: () => entry.value.session.destroy(),
            lease: entry.lease,
          }),
        ),
    ];
    this.pendingFinalizers.clear();
    this.closePromise = Promise.allSettled(
      finalizers.map((finalizer) => this.settleFinalizer(finalizer, true)),
    ).then((results) => {
      const failures = results
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason);
      if (failures.length > 0) throw new AggregateError(failures, "Local Untitled teardown failed");
    });
    return this.closePromise;
  }

  private async open(
    key: LocalUntitledKey,
    mode: "create" | "restore",
  ): Promise<LocalUntitledOpenResult> {
    await this.retryPendingFinalizers();
    this.requireQualified(key);
    if (this.closing) throw new Error("Local Untitled owner is closing");
    if (mode === "restore") {
      const requested = this.dependencies.records.read(key);
      if (requested) {
        const winner = this.dependencies.records
          .list(key.accountId)
          .filter(
            (record) =>
              record.key.projectId === key.projectId &&
              record.lineageId === requested.lineageId &&
              record.active !== false,
          )
          .sort(
            (left, right) =>
              (right.lineageRevision ?? right.revision) - (left.lineageRevision ?? left.revision),
          )[0];
        if (winner && !sameKey(winner.key, key))
          throw new LocalUntitledIdentityRedirect(winner.key);
      }
    }
    const existing = this.getDetached(key);
    if (existing) return { kind: "opened", value: existing };
    const lease = await this.dependencies.lifetime.tryAcquire(key.projectId, key.documentId);
    if (!lease) return { kind: "owned-elsewhere" };
    try {
      let record = this.dependencies.records.read(key);
      if (mode === "restore") {
        if (record?.phase !== "local-pending" || record.active === false)
          throw new Error("Local Untitled restore requires a durable pending record");
      } else if (!record) {
        record = {
          key,
          lineageId: this.dependencies.newLineageId?.() ?? crypto.randomUUID(),
          revision: 1,
          lineageRevision: 1,
          active: true,
          phase: "local-pending",
          home: null,
          pendingSinceMs: null,
        };
        this.dependencies.records.write(record);
      } else if (record.phase !== "local-pending" || record.active === false) {
        throw new Error("Local Untitled identity is not locally writable");
      }
      const session = this.dependencies.sessions.createDetached({
        ...key,
        persistenceKey: localUntitledPersistenceKey(key),
      });
      const value = Object.freeze({ key, session });
      this.owned.set(encodeLocalUntitledKey(key), {
        value,
        lease,
        revision: record.revision,
        transferring: false,
        handoff: null,
      });
      return { kind: "opened", value };
    } catch (error) {
      await lease.release();
      throw error;
    }
  }

  private requireQualified(key: LocalUntitledKey): void {
    if (key.accountId !== this.dependencies.accountId)
      throw new Error("Local Untitled key belongs to a different account");
  }

  private async retryPendingFinalizers(): Promise<void> {
    const failures: unknown[] = [];
    for (const finalizer of [...this.pendingFinalizers.values()]) {
      try {
        await this.settleFinalizer(finalizer, false);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0)
      throw new AggregateError(failures, "Local Untitled cleanup retry failed");
  }

  private async settleFinalizer(finalizer: PendingFinalizer, releaseAfterFailure: boolean) {
    let providerFailure: unknown;
    if (!finalizer.providerClosed) {
      try {
        await finalizer.closeProvider();
        finalizer.providerClosed = true;
      } catch (error) {
        providerFailure = error;
        if (!releaseAfterFailure) throw error;
      }
    }
    let leaseFailure: unknown;
    if (!finalizer.leaseReleased) {
      try {
        await finalizer.lease.release();
        finalizer.leaseReleased = true;
      } catch (error) {
        leaseFailure = error;
      }
    }
    if (!providerFailure && !leaseFailure) {
      finalizer.afterSettled?.();
      this.pendingFinalizers.delete(finalizer.key);
      return;
    }
    throw new AggregateError(
      [providerFailure, leaseFailure].filter((error) => error !== undefined),
      "Local Untitled finalizer failed",
    );
  }

  private requireOwned(key: LocalUntitledKey): Owned {
    const owned = this.getDetached(key) && this.owned.get(encodeLocalUntitledKey(key));
    if (!owned) throw new Error("Local Untitled session is not owned in this realm");
    return owned;
  }

  private reserveTransfer(
    key: LocalUntitledKey,
    owned: Owned,
    expectedRevision: number,
  ): LocalDocumentSessionHandoff {
    return this.dependencies.reservations.reserve({
      projectId: key.projectId,
      documentId: key.documentId,
      session: owned.value.session,
      ownerRevision: expectedRevision,
      prepareCommit: () => {
        const latest = this.dependencies.records.read(key);
        if (
          latest?.phase !== "local-pending" ||
          latest.revision !== expectedRevision ||
          this.owned.get(encodeLocalUntitledKey(key)) !== owned
        ) {
          throw new Error("Local Untitled ownership changed during materialization");
        }
        this.dependencies.records.write({ ...latest, phase: "adopted-live" });
      },
      commit: () => {
        this.owned.delete(encodeLocalUntitledKey(key));
      },
      finalize: () => owned.lease.release(),
    });
  }

  private isRetained(key: LocalUntitledKey): boolean {
    const encoded = encodeLocalUntitledKey(key);
    for (const ids of this.retained.values()) if (ids.has(encoded)) return true;
    return false;
  }
}
