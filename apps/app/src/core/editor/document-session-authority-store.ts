/** Durable account-scoped live-room ordering, drains, fences, and proven purge work. */
import type {
  AccessFenceKey,
  AccountId,
  AvailabilityCommandId,
  AvailabilityGeneration,
  DocumentFenceKey,
  RevocationFence,
} from "@meridian/contracts/protocol";
import { assertAvailabilityGeneration } from "@meridian/contracts/protocol";
import type { DocumentId, ProjectId } from "@meridian/contracts/runtime";
import { collabSchemaKeyTag } from "@meridian/prosemirror-schema";

const AUTHORITY_STORE_VERSION = 2;
const FENCES = "fences";
const PURGES = "purges";
const ROOMS = "room-order";
const ACCESS_HEADS = "access-heads";
const ACCESS_OUTCOMES = "access-outcomes";
const LIVE_PERSISTENCE_PREFIX = `meridian:document:${collabSchemaKeyTag()}:live/`;
const LIVE_PERSISTENCE_PATTERN = /^meridian:document:v\d+\.\d+:live\//;

type FenceRecord = RevocationFence & { key: DocumentFenceKey | AccessFenceKey };
export type PendingDrain =
  | {
      kind: "document";
      generation: AvailabilityGeneration;
      commandId: AvailabilityCommandId;
      incarnation: AvailabilityGeneration | null;
    }
  | {
      kind: "access";
      projectId: ProjectId;
      generation: AvailabilityGeneration;
      commandId: AvailabilityCommandId;
      incarnation: AvailabilityGeneration | null;
    };
export type RoomOrderRecord = {
  documentId: DocumentId;
  persistenceGeneration: AvailabilityGeneration | null;
  documentAdmittedThrough: AvailabilityGeneration | null;
  pendingDrain: PendingDrain | null;
};
type AccessHeadRecord = {
  key: string;
  documentId: DocumentId;
  projectId: ProjectId;
  admittedThrough: AvailabilityGeneration;
};
type AccessOutcomeRecord = {
  key: string;
  documentId: DocumentId;
  projectId: ProjectId;
  generation: AvailabilityGeneration;
  commandId: AvailabilityCommandId;
  persistence: "cleared" | "retained-by-other-lease";
};
export type PendingDocumentPurge = {
  key: string;
  accountId: AccountId;
  documentId: DocumentId;
  revokedThrough: AvailabilityGeneration;
};

export type AdmissionDecision =
  | { kind: "admitted"; persistenceGeneration: AvailabilityGeneration }
  | { kind: "generation-revoked" }
  | { kind: "purge-barrier"; purgeThrough: AvailabilityGeneration }
  | { kind: "pending"; pending: PendingDrain };

export type DrainStart =
  | { kind: "started"; pending: PendingDrain }
  | { kind: "pending"; pending: PendingDrain }
  | { kind: "older"; revokedThrough: AvailabilityGeneration }
  | { kind: "collision"; revokedThrough: AvailabilityGeneration }
  | {
      kind: "replay";
      revokedThrough: AvailabilityGeneration;
      persistence?: "cleared" | "retained-by-other-lease";
    };

function encodeKeyPart(value: string): string {
  return encodeURIComponent(value);
}

function decodeKeyPart(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function accessRecordKey(documentId: DocumentId, projectId: ProjectId): string {
  return `${encodeKeyPart(documentId)}/${encodeKeyPart(projectId)}`;
}

function purgeRecordKey(accountId: AccountId, documentId: DocumentId): string {
  return `${accountId}/${documentId}`;
}

function emptyRoom(documentId: DocumentId): RoomOrderRecord {
  return {
    documentId,
    persistenceGeneration: null,
    documentAdmittedThrough: null,
    pendingDrain: null,
  };
}

export function compareAvailabilityGeneration(
  left: AvailabilityGeneration,
  right: AvailabilityGeneration,
): -1 | 0 | 1 {
  assertAvailabilityGeneration(left);
  assertAvailabilityGeneration(right);
  const comparison = BigInt(left) - BigInt(right);
  return comparison < 0n ? -1 : comparison > 0n ? 1 : 0;
}

function maximumGeneration(
  current: AvailabilityGeneration | null,
  candidate: AvailabilityGeneration,
): AvailabilityGeneration {
  return current && compareAvailabilityGeneration(current, candidate) > 0 ? current : candidate;
}

export function documentFenceKey(accountId: AccountId, documentId: DocumentId): DocumentFenceKey {
  return `document/${accountId}/${documentId}`;
}

export function accessFenceKey(
  accountId: AccountId,
  projectId: ProjectId,
  documentId: DocumentId,
): AccessFenceKey {
  return `access/${accountId}/${projectId}/${documentId}`;
}

export function documentSessionPersistenceKey(
  accountId: AccountId,
  documentId: DocumentId,
  generation: AvailabilityGeneration,
): string {
  assertAvailabilityGeneration(generation);
  return `${LIVE_PERSISTENCE_PREFIX}${encodeKeyPart(accountId)}/${encodeKeyPart(documentId)}/${generation}`;
}

export function parseDocumentSessionPersistenceKey(name: string): {
  accountId: AccountId;
  documentId: DocumentId;
  generation: AvailabilityGeneration;
} | null {
  const prefix = name.match(LIVE_PERSISTENCE_PATTERN)?.[0];
  if (!prefix) return null;
  const parts = name.slice(prefix.length).split("/");
  if (parts.length !== 3) return null;
  try {
    assertAvailabilityGeneration(parts[2] ?? "");
  } catch {
    return null;
  }
  const accountId = decodeKeyPart(parts[0] ?? "");
  const documentId = decodeKeyPart(parts[1] ?? "");
  if (accountId === null || documentId === null) return null;
  return { accountId, documentId, generation: parts[2] ?? "" };
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction failed"));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
  });
}

/** One durable authority database per authenticated account. */
export class DocumentSessionAuthorityStore {
  private readonly databasePromise: Promise<IDBDatabase>;
  private readonly blockedDeleteRequests = new Set<string>();
  private closed = false;

  constructor(
    readonly accountId: AccountId,
    private readonly idb: IDBFactory = indexedDB,
    private readonly onVersionChange: () => void = () => undefined,
    private readonly onPurgeWake: () => void = () => undefined,
  ) {
    this.databasePromise = new Promise((resolve, reject) => {
      let settled = false;
      let request: IDBOpenDBRequest;
      try {
        request = idb.open(
          `meridian:document-session-authority:${encodeKeyPart(accountId)}`,
          AUTHORITY_STORE_VERSION,
        );
      } catch (error) {
        reject(error);
        return;
      }
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(FENCES))
          database.createObjectStore(FENCES, { keyPath: "key" });
        if (!database.objectStoreNames.contains(PURGES))
          database.createObjectStore(PURGES, { keyPath: "key" });
        if (!database.objectStoreNames.contains(ROOMS))
          database.createObjectStore(ROOMS, { keyPath: "documentId" });
        if (!database.objectStoreNames.contains(ACCESS_HEADS))
          database.createObjectStore(ACCESS_HEADS, { keyPath: "key" });
        if (!database.objectStoreNames.contains(ACCESS_OUTCOMES))
          database.createObjectStore(ACCESS_OUTCOMES, { keyPath: "key" });
      };
      request.onblocked = () => {
        if (!settled) {
          settled = true;
          reject(new Error("Document session authority upgrade is blocked"));
        }
      };
      request.onerror = () => {
        if (!settled) {
          settled = true;
          reject(request.error ?? new Error("IndexedDB authority open failed"));
        }
      };
      request.onsuccess = () => {
        if (settled) {
          request.result.close();
          return;
        }
        settled = true;
        // Coordination owns the ordered close barrier. Keeping this connection open
        // keeps the upgrader blocked until local sessions and lifecycle holds are gone.
        request.result.onversionchange = this.onVersionChange;
        resolve(request.result);
      };
    });
  }

  async ensureAvailable(): Promise<void> {
    const database = await this.databasePromise;
    const transaction = database.transaction(ROOMS, "readwrite");
    await transactionDone(transaction);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      (await this.databasePromise).close();
    } catch {
      // A store that never became available has no connection to close.
    }
  }

  async readFence(key: DocumentFenceKey | AccessFenceKey): Promise<RevocationFence | null> {
    const database = await this.databasePromise;
    const transaction = database.transaction(FENCES, "readonly");
    const record = (await requestResult(transaction.objectStore(FENCES).get(key))) as
      | FenceRecord
      | undefined;
    await transactionDone(transaction);
    return record ? { revokedThrough: record.revokedThrough, commandId: record.commandId } : null;
  }

  async readAdmissionFences(
    documentKey: DocumentFenceKey,
    accessKey: AccessFenceKey,
  ): Promise<readonly [RevocationFence | null, RevocationFence | null]> {
    const database = await this.databasePromise;
    const transaction = database.transaction(FENCES, "readonly");
    const fences = transaction.objectStore(FENCES);
    const records = await Promise.all([
      requestResult(fences.get(documentKey)) as Promise<FenceRecord | undefined>,
      requestResult(fences.get(accessKey)) as Promise<FenceRecord | undefined>,
    ]);
    await transactionDone(transaction);
    const toFence = (record: FenceRecord | undefined): RevocationFence | null =>
      record ? { revokedThrough: record.revokedThrough, commandId: record.commandId } : null;
    return [toFence(records[0]), toFence(records[1])];
  }

  async readRoom(documentId: DocumentId): Promise<RoomOrderRecord> {
    const database = await this.databasePromise;
    const transaction = database.transaction(ROOMS, "readonly");
    const room = (await requestResult(transaction.objectStore(ROOMS).get(documentId))) as
      | RoomOrderRecord
      | undefined;
    await transactionDone(transaction);
    return room ?? emptyRoom(documentId);
  }

  async readAccessHead(
    documentId: DocumentId,
    projectId: ProjectId,
  ): Promise<AvailabilityGeneration | null> {
    const database = await this.databasePromise;
    const transaction = database.transaction(ACCESS_HEADS, "readonly");
    const record = (await requestResult(
      transaction.objectStore(ACCESS_HEADS).get(accessRecordKey(documentId, projectId)),
    )) as AccessHeadRecord | undefined;
    await transactionDone(transaction);
    return record?.admittedThrough ?? null;
  }

  async listPendingDrains(): Promise<readonly RoomOrderRecord[]> {
    const database = await this.databasePromise;
    const transaction = database.transaction(ROOMS, "readonly");
    const rooms = (await requestResult(
      transaction.objectStore(ROOMS).getAll(),
    )) as RoomOrderRecord[];
    await transactionDone(transaction);
    return rooms.filter((room) => room.pendingDrain !== null);
  }

  async admit(input: {
    documentId: DocumentId;
    projectId: ProjectId;
    generation: AvailabilityGeneration;
  }): Promise<AdmissionDecision> {
    assertAvailabilityGeneration(input.generation);
    const database = await this.databasePromise;
    const transaction = database.transaction([FENCES, PURGES, ROOMS, ACCESS_HEADS], "readwrite");
    const fences = transaction.objectStore(FENCES);
    const [documentFence, accessFence, storedRoom, purge] = await Promise.all([
      requestResult(fences.get(documentFenceKey(this.accountId, input.documentId))) as Promise<
        FenceRecord | undefined
      >,
      requestResult(
        fences.get(accessFenceKey(this.accountId, input.projectId, input.documentId)),
      ) as Promise<FenceRecord | undefined>,
      requestResult(transaction.objectStore(ROOMS).get(input.documentId)) as Promise<
        RoomOrderRecord | undefined
      >,
      requestResult(
        transaction.objectStore(PURGES).get(purgeRecordKey(this.accountId, input.documentId)),
      ) as Promise<PendingDocumentPurge | undefined>,
    ]);
    if (
      [documentFence, accessFence].some(
        (fence) =>
          fence && compareAvailabilityGeneration(input.generation, fence.revokedThrough) <= 0,
      )
    ) {
      transaction.abort();
      return { kind: "generation-revoked" };
    }
    const room = storedRoom ?? emptyRoom(input.documentId);
    if (room.pendingDrain) {
      transaction.abort();
      return { kind: "pending", pending: room.pendingDrain };
    }
    const reusable =
      room.persistenceGeneration &&
      (!purge ||
        compareAvailabilityGeneration(room.persistenceGeneration, purge.revokedThrough) > 0)
        ? room.persistenceGeneration
        : null;
    if (
      !reusable &&
      purge &&
      compareAvailabilityGeneration(input.generation, purge.revokedThrough) <= 0
    ) {
      transaction.abort();
      return { kind: "purge-barrier", purgeThrough: purge.revokedThrough };
    }
    const persistenceGeneration = reusable ?? input.generation;
    room.persistenceGeneration = persistenceGeneration;
    room.documentAdmittedThrough = maximumGeneration(
      room.documentAdmittedThrough,
      input.generation,
    );
    transaction.objectStore(ROOMS).put(room);
    const heads = transaction.objectStore(ACCESS_HEADS);
    const key = accessRecordKey(input.documentId, input.projectId);
    const currentHead = (await requestResult(heads.get(key))) as AccessHeadRecord | undefined;
    heads.put({
      key,
      documentId: input.documentId,
      projectId: input.projectId,
      admittedThrough: maximumGeneration(currentHead?.admittedThrough ?? null, input.generation),
    } satisfies AccessHeadRecord);
    await transactionDone(transaction);
    return { kind: "admitted", persistenceGeneration };
  }

  async startDocumentDrain(input: {
    documentId: DocumentId;
    generation: AvailabilityGeneration;
    commandId: AvailabilityCommandId;
  }): Promise<DrainStart> {
    return this.startDrain({ kind: "document", ...input });
  }

  async startAccessDrain(input: {
    documentId: DocumentId;
    projectId: ProjectId;
    generation: AvailabilityGeneration;
    commandId: AvailabilityCommandId;
  }): Promise<DrainStart> {
    return this.startDrain({ kind: "access", ...input });
  }

  private async startDrain(
    input:
      | {
          kind: "document";
          documentId: DocumentId;
          generation: AvailabilityGeneration;
          commandId: AvailabilityCommandId;
        }
      | {
          kind: "access";
          documentId: DocumentId;
          projectId: ProjectId;
          generation: AvailabilityGeneration;
          commandId: AvailabilityCommandId;
        },
  ): Promise<DrainStart> {
    assertAvailabilityGeneration(input.generation);
    const database = await this.databasePromise;
    const transaction = database.transaction(
      [FENCES, ROOMS, ACCESS_HEADS, ACCESS_OUTCOMES],
      "readwrite",
    );
    const rooms = transaction.objectStore(ROOMS);
    const room =
      ((await requestResult(rooms.get(input.documentId))) as RoomOrderRecord | undefined) ??
      emptyRoom(input.documentId);
    if (room.pendingDrain) {
      transaction.abort();
      return { kind: "pending", pending: room.pendingDrain };
    }
    const key =
      input.kind === "document"
        ? documentFenceKey(this.accountId, input.documentId)
        : accessFenceKey(this.accountId, input.projectId, input.documentId);
    const fences = transaction.objectStore(FENCES);
    const current = (await requestResult(fences.get(key))) as FenceRecord | undefined;
    if (current) {
      const comparison = compareAvailabilityGeneration(input.generation, current.revokedThrough);
      if (comparison < 0) {
        transaction.abort();
        return { kind: "older", revokedThrough: current.revokedThrough };
      }
      if (comparison === 0) {
        if (current.commandId !== input.commandId) {
          transaction.abort();
          return { kind: "collision", revokedThrough: current.revokedThrough };
        }
        if (input.kind === "document") {
          transaction.abort();
          return { kind: "replay", revokedThrough: current.revokedThrough, persistence: "cleared" };
        }
        const outcome = (await requestResult(
          transaction
            .objectStore(ACCESS_OUTCOMES)
            .get(accessRecordKey(input.documentId, input.projectId)),
        )) as AccessOutcomeRecord | undefined;
        transaction.abort();
        if (
          !outcome ||
          outcome.generation !== input.generation ||
          outcome.commandId !== input.commandId
        ) {
          throw new Error("Completed access fence is missing its exact outcome");
        }
        return {
          kind: "replay",
          revokedThrough: current.revokedThrough,
          persistence: outcome.persistence,
        };
      }
    }
    const admittedThrough =
      input.kind === "document"
        ? room.documentAdmittedThrough
        : ((
            (await requestResult(
              transaction
                .objectStore(ACCESS_HEADS)
                .get(accessRecordKey(input.documentId, input.projectId)),
            )) as AccessHeadRecord | undefined
          )?.admittedThrough ?? null);
    if (admittedThrough && compareAvailabilityGeneration(input.generation, admittedThrough) < 0) {
      transaction.abort();
      return { kind: "older", revokedThrough: admittedThrough };
    }
    const fence: FenceRecord = {
      key,
      revokedThrough: input.generation,
      commandId: input.commandId,
    };
    fences.put(fence);
    if (input.kind === "access") {
      transaction
        .objectStore(ACCESS_OUTCOMES)
        .delete(accessRecordKey(input.documentId, input.projectId));
    }
    const pending: PendingDrain = {
      ...input,
      incarnation: room.persistenceGeneration,
    };
    room.pendingDrain = pending;
    if (
      input.kind === "document" &&
      room.persistenceGeneration &&
      compareAvailabilityGeneration(room.persistenceGeneration, input.generation) <= 0
    ) {
      room.persistenceGeneration = null;
    }
    rooms.put(room);
    await transactionDone(transaction);
    return { kind: "started", pending };
  }

  async finishDocumentDrain(input: {
    documentId: DocumentId;
    generation: AvailabilityGeneration;
    commandId: AvailabilityCommandId;
  }): Promise<boolean> {
    return this.finishDrain({ kind: "document", ...input, persistence: "cleared" });
  }

  async finishAccessDrain(input: {
    documentId: DocumentId;
    projectId: ProjectId;
    generation: AvailabilityGeneration;
    commandId: AvailabilityCommandId;
    persistence: "cleared" | "retained-by-other-lease";
  }): Promise<boolean> {
    return this.finishDrain({ kind: "access", ...input });
  }

  private async finishDrain(
    input:
      | {
          kind: "document";
          documentId: DocumentId;
          generation: AvailabilityGeneration;
          commandId: AvailabilityCommandId;
          persistence: "cleared";
        }
      | {
          kind: "access";
          documentId: DocumentId;
          projectId: ProjectId;
          generation: AvailabilityGeneration;
          commandId: AvailabilityCommandId;
          persistence: "cleared" | "retained-by-other-lease";
        },
  ): Promise<boolean> {
    const database = await this.databasePromise;
    const transaction = database.transaction([ROOMS, PURGES, ACCESS_OUTCOMES], "readwrite");
    const rooms = transaction.objectStore(ROOMS);
    const room = (await requestResult(rooms.get(input.documentId))) as RoomOrderRecord | undefined;
    const pending = room?.pendingDrain;
    if (
      !room ||
      !pending ||
      pending.kind !== input.kind ||
      pending.generation !== input.generation ||
      pending.commandId !== input.commandId ||
      (pending.kind === "access" &&
        input.kind === "access" &&
        pending.projectId !== input.projectId)
    ) {
      transaction.abort();
      return false;
    }
    room.pendingDrain = null;
    if (input.kind === "access") {
      const key = accessRecordKey(input.documentId, input.projectId);
      transaction.objectStore(ACCESS_OUTCOMES).put({
        key,
        documentId: input.documentId,
        projectId: input.projectId,
        generation: input.generation,
        commandId: input.commandId,
        persistence: input.persistence,
      } satisfies AccessOutcomeRecord);
      if (
        input.persistence === "cleared" &&
        room.persistenceGeneration &&
        compareAvailabilityGeneration(room.persistenceGeneration, input.generation) <= 0
      ) {
        room.persistenceGeneration = null;
      }
    }
    rooms.put(room);
    if (input.persistence === "cleared") {
      const purges = transaction.objectStore(PURGES);
      const key = purgeRecordKey(this.accountId, input.documentId);
      const current = (await requestResult(purges.get(key))) as PendingDocumentPurge | undefined;
      purges.put({
        key,
        accountId: this.accountId,
        documentId: input.documentId,
        revokedThrough: maximumGeneration(current?.revokedThrough ?? null, input.generation),
      } satisfies PendingDocumentPurge);
    }
    await transactionDone(transaction);
    return true;
  }

  async pendingPurges(): Promise<readonly PendingDocumentPurge[]> {
    const database = await this.databasePromise;
    const transaction = database.transaction(PURGES, "readonly");
    const records = (await requestResult(
      transaction.objectStore(PURGES).getAll(),
    )) as PendingDocumentPurge[];
    await transactionDone(transaction);
    return records;
  }

  async snapshotPurge(documentId: DocumentId): Promise<PendingDocumentPurge | null> {
    const database = await this.databasePromise;
    const transaction = database.transaction([ROOMS, PURGES], "readonly");
    const [room, purge] = await Promise.all([
      requestResult(transaction.objectStore(ROOMS).get(documentId)) as Promise<
        RoomOrderRecord | undefined
      >,
      requestResult(
        transaction.objectStore(PURGES).get(purgeRecordKey(this.accountId, documentId)),
      ) as Promise<PendingDocumentPurge | undefined>,
    ]);
    await transactionDone(transaction);
    return room?.pendingDrain ? null : (purge ?? null);
  }

  async compareClearPurge(purge: PendingDocumentPurge): Promise<boolean> {
    const database = await this.databasePromise;
    const transaction = database.transaction(PURGES, "readwrite");
    const store = transaction.objectStore(PURGES);
    const current = (await requestResult(store.get(purge.key))) as PendingDocumentPurge | undefined;
    if (!current || current.revokedThrough !== purge.revokedThrough) {
      transaction.abort();
      return false;
    }
    store.delete(purge.key);
    await transactionDone(transaction);
    return true;
  }

  async deletePersistenceThrough(pending: PendingDocumentPurge): Promise<boolean> {
    if (typeof this.idb.databases !== "function") return false;
    const databases = await this.idb.databases();
    const matching = (databases ?? []).flatMap(({ name }) => {
      if (!name) return [];
      const parsed = parseDocumentSessionPersistenceKey(name);
      if (
        !parsed ||
        parsed.accountId !== pending.accountId ||
        parsed.documentId !== pending.documentId ||
        compareAvailabilityGeneration(parsed.generation, pending.revokedThrough) > 0
      ) {
        return [];
      }
      return [name];
    });
    for (const name of matching) {
      if (!(await this.deleteDatabase(name))) return false;
    }
    return true;
  }

  private deleteDatabase(name: string): Promise<boolean> {
    if (this.blockedDeleteRequests.has(name)) return Promise.resolve(false);
    return new Promise((resolve, reject) => {
      const request = this.idb.deleteDatabase(name);
      let settled = false;
      request.onblocked = () => {
        settled = true;
        this.blockedDeleteRequests.add(name);
        resolve(false);
      };
      request.onerror = () => {
        this.blockedDeleteRequests.delete(name);
        reject(request.error ?? new Error(`Failed to delete IndexedDB ${name}`));
      };
      request.onsuccess = () => {
        this.blockedDeleteRequests.delete(name);
        if (!settled) {
          resolve(true);
          return;
        }
        if (!this.closed) queueMicrotask(this.onPurgeWake);
      };
    });
  }
}
