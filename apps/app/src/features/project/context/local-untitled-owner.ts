/** Account-qualified owner of durable pre-authority Untitled sessions. */
import type { AccountId } from "@meridian/contracts/protocol";
import type { DocumentId } from "@meridian/contracts/runtime";
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

export type LocalUntitledSession = Readonly<{
  key: LocalUntitledKey;
  session: DocumentSession;
}>;

export type LocalUntitledOpenResult =
  | { kind: "opened"; value: LocalUntitledSession }
  | { kind: "owned-elsewhere" };

type Owned = {
  value: LocalUntitledSession;
  lease: LocalUntitledCrossContextLease;
  revision: number;
  transferring: boolean;
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
  return `meridian:local-untitled:v1:${encodeURIComponent(key.accountId)}:${encodeURIComponent(key.projectId)}:${encodeURIComponent(key.documentId)}`;
}

function sameKey(left: LocalUntitledKey, right: LocalUntitledKey): boolean {
  return (
    left.accountId === right.accountId &&
    left.projectId === right.projectId &&
    left.documentId === right.documentId
  );
}

export class LocalUntitledOwner {
  readonly dependencies: LocalUntitledOwnerDependencies;
  private readonly owned = new Map<DocumentId, Owned>();
  private readonly retained = new Map<string, Set<DocumentId>>();
  private closePromise: Promise<void> | null = null;
  private closing = false;

  constructor(dependencies: LocalUntitledOwnerDependencies) {
    this.dependencies = dependencies;
  }

  create(key: LocalUntitledKey): Promise<LocalUntitledOpenResult> {
    return this.open(key, "create");
  }

  restore(key: LocalUntitledKey): Promise<LocalUntitledOpenResult> {
    return this.open(key, "restore");
  }

  getDetached(key: LocalUntitledKey): LocalUntitledSession | null {
    this.requireQualified(key);
    const owned = this.owned.get(key.documentId);
    return owned && sameKey(owned.value.key, key) ? owned.value : null;
  }

  retain(ownerId: string, keys: Iterable<LocalUntitledKey>): void {
    const ids = new Set<DocumentId>();
    for (const key of keys) {
      this.requireQualified(key);
      if (this.getDetached(key)) ids.add(key.documentId);
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
    const owned = this.requireOwned(input.key);
    const record = this.dependencies.records.read(input.key);
    if (!record || record.revision !== input.expectedRevision || owned.revision !== record.revision)
      return "stale";
    if (owned.transferring || this.isRetained(input.key.documentId)) return "busy";
    if (
      input.evidence === "writer-empty-close" &&
      owned.value.session.document.getXmlFragment(owned.value.session.fragmentName).length > 0
    ) {
      return "busy";
    }
    if (this.dependencies.records.remove(input.key, input.expectedRevision) !== "removed")
      return "stale";
    this.owned.delete(input.key.documentId);
    await owned.value.session.destroy({ clearPersistence: true });
    await owned.lease.release();
    return "abandoned";
  }

  async prepareMaterialization(
    key: LocalUntitledKey,
    expectedRevision: number,
  ): Promise<LocalDocumentSessionHandoff> {
    const owned = this.requireOwned(key);
    const record = this.dependencies.records.read(key);
    if (record?.phase !== "local-pending" || record.revision !== expectedRevision)
      throw new Error("Local Untitled materialization revision is stale");
    if (owned.transferring) throw new Error("Local Untitled transfer is already prepared");
    owned.transferring = true;
    try {
      await owned.value.session.flushLocalPersistence();
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
            this.owned.get(key.documentId) !== owned
          ) {
            throw new Error("Local Untitled ownership changed during materialization");
          }
          this.dependencies.records.write({ ...latest, phase: "adopted-live" });
        },
        commit: () => {
          this.owned.delete(key.documentId);
          void owned.lease.release().catch(() => undefined);
        },
      });
    } catch (error) {
      owned.transferring = false;
      throw error;
    }
  }

  async remint(from: LocalUntitledKey, to: LocalUntitledKey): Promise<LocalUntitledSession> {
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
    this.dependencies.records.write({ ...replacement, active: false });
    try {
      await old.value.session.reidentifyDetached(to.documentId, localUntitledPersistenceKey(to));
      this.dependencies.records.write(replacement);
      this.owned.delete(from.documentId);
      const value = { key: to, session: old.value.session };
      this.owned.set(to.documentId, {
        value,
        lease: replacementLease,
        revision: nextRevision,
        transferring: false,
      });
      await old.lease.release();
      return value;
    } catch (error) {
      await replacementLease.release();
      throw error;
    }
  }

  destroyAll(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.retained.clear();
    const owned = [...this.owned.values()];
    this.owned.clear();
    this.closePromise = Promise.allSettled(
      owned.map(async (entry) => {
        await entry.value.session.destroy();
        await entry.lease.release();
      }),
    ).then((results) => {
      const failed = results.find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (failed) throw failed.reason;
    });
    return this.closePromise;
  }

  private async open(
    key: LocalUntitledKey,
    mode: "create" | "restore",
  ): Promise<LocalUntitledOpenResult> {
    this.requireQualified(key);
    if (this.closing) throw new Error("Local Untitled owner is closing");
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
      this.owned.set(key.documentId, {
        value,
        lease,
        revision: record.revision,
        transferring: false,
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

  private requireOwned(key: LocalUntitledKey): Owned {
    const owned = this.getDetached(key) && this.owned.get(key.documentId);
    if (!owned) throw new Error("Local Untitled session is not owned in this realm");
    return owned;
  }

  private isRetained(documentId: DocumentId): boolean {
    for (const ids of this.retained.values()) if (ids.has(documentId)) return true;
    return false;
  }
}
