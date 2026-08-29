/** Durable account-scoped fences and generation-qualified live-room purge work. */
import type {
  AccessFenceKey,
  AccountId,
  AvailabilityCommandId,
  AvailabilityGeneration,
  DocumentFenceKey,
  RevocationFence,
} from "@meridian/contracts/protocol";
import type { DocumentId, ProjectId } from "@meridian/contracts/runtime";
import { collabSchemaKeyTag } from "@meridian/prosemirror-schema";

const AUTHORITY_STORE_VERSION = 1;
const FENCES = "fences";
const PURGES = "purges";
const LIVE_PERSISTENCE_PREFIX = `meridian:document:${collabSchemaKeyTag()}:live/`;
const LIVE_PERSISTENCE_PATTERN = /^meridian:document:v\d+\.\d+:live\//;

type FenceRecord = RevocationFence & { key: DocumentFenceKey | AccessFenceKey };
export type PendingDocumentPurge = {
  key: string;
  accountId: AccountId;
  documentId: DocumentId;
  revokedThrough: AvailabilityGeneration;
};

export type FenceAdvance =
  | { kind: "advanced"; fence: RevocationFence }
  | { kind: "idempotent"; fence: RevocationFence }
  | { kind: "older"; fence: RevocationFence }
  | { kind: "collision"; fence: RevocationFence };

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

export function compareAvailabilityGeneration(
  left: AvailabilityGeneration,
  right: AvailabilityGeneration,
): -1 | 0 | 1 {
  const comparison = BigInt(left) - BigInt(right);
  return comparison < 0n ? -1 : comparison > 0n ? 1 : 0;
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
  if (parts.length !== 3 || !/^\d+$/.test(parts[2] ?? "")) return null;
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

  constructor(
    readonly accountId: AccountId,
    private readonly idb: IDBFactory = indexedDB,
  ) {
    const request = idb.open(
      `meridian:document-session-authority:${encodeKeyPart(accountId)}`,
      AUTHORITY_STORE_VERSION,
    );
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(FENCES))
        database.createObjectStore(FENCES, { keyPath: "key" });
      if (!database.objectStoreNames.contains(PURGES))
        database.createObjectStore(PURGES, { keyPath: "key" });
    };
    this.databasePromise = requestResult(request);
  }

  async close(): Promise<void> {
    (await this.databasePromise).close();
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

  /** Atomically advances the fence and records purge work before any physical deletion. */
  async advanceFence(input: {
    key: DocumentFenceKey | AccessFenceKey;
    documentId: DocumentId;
    revokedThrough: AvailabilityGeneration;
    commandId: AvailabilityCommandId;
    purge: boolean;
  }): Promise<FenceAdvance> {
    const database = await this.databasePromise;
    const transaction = database.transaction([FENCES, PURGES], "readwrite");
    const fences = transaction.objectStore(FENCES);
    const current = (await requestResult(fences.get(input.key))) as FenceRecord | undefined;
    if (current) {
      const ordering = compareAvailabilityGeneration(input.revokedThrough, current.revokedThrough);
      if (ordering < 0) {
        transaction.abort();
        return { kind: "older", fence: current };
      }
      if (ordering === 0) {
        transaction.abort();
        return {
          kind: current.commandId === input.commandId ? "idempotent" : "collision",
          fence: current,
        };
      }
    }

    const fence: FenceRecord = {
      key: input.key,
      revokedThrough: input.revokedThrough,
      commandId: input.commandId,
    };
    fences.put(fence);
    if (input.purge) {
      const purges = transaction.objectStore(PURGES);
      const key = `${this.accountId}/${input.documentId}`;
      const pending = (await requestResult(purges.get(key))) as PendingDocumentPurge | undefined;
      const revokedThrough =
        pending && compareAvailabilityGeneration(pending.revokedThrough, input.revokedThrough) > 0
          ? pending.revokedThrough
          : input.revokedThrough;
      purges.put({ key, accountId: this.accountId, documentId: input.documentId, revokedThrough });
    }
    await transactionDone(transaction);
    return { kind: "advanced", fence };
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

  async retryPendingPurges(): Promise<boolean> {
    let cleared = true;
    for (const pending of await this.pendingPurges()) {
      if (!(await this.settlePurge(pending))) cleared = false;
    }
    return cleared;
  }

  private async settlePurge(pending: PendingDocumentPurge): Promise<boolean> {
    const databases = typeof this.idb.databases === "function" ? await this.idb.databases() : [];
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
    await this.removePending(pending.key);
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
        if (!settled) resolve(true);
      };
    });
  }

  private async removePending(key: string): Promise<void> {
    const database = await this.databasePromise;
    const transaction = database.transaction(PURGES, "readwrite");
    transaction.objectStore(PURGES).delete(key);
    await transactionDone(transaction);
  }
}
