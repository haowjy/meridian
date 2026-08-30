/** Durable, per-document local Untitled ownership records; browser storage is adapted later. */
import type { AccountId } from "@meridian/contracts/protocol";
import type { DocumentId, ProjectId } from "@meridian/contracts/runtime";

export type LocalUntitledKey = Readonly<{
  accountId: AccountId;
  projectId: ProjectId;
  documentId: DocumentId;
}>;

export type LocalUntitledRecord = Readonly<{
  key: LocalUntitledKey;
  lineageId: string;
  lineageRevision?: number;
  active?: boolean;
  revision: number;
  phase: "local-pending" | "adopted-live";
  home: Readonly<{ scheme: string; path: string; name: string }> | null;
}>;

export interface LocalUntitledRecordStore {
  read(key: LocalUntitledKey): LocalUntitledRecord | null;
  write(record: LocalUntitledRecord): void;
  remove(key: LocalUntitledKey, expectedRevision: number): "removed" | "stale";
  list(accountId: AccountId): readonly LocalUntitledRecord[];
}

const RECORD_PREFIX = "meridian:pending-untitled:v2:";

function recordStorageKey(key: LocalUntitledKey): string {
  return `${RECORD_PREFIX}${encodeURIComponent(key.accountId)}:${encodeURIComponent(key.projectId)}:${encodeURIComponent(key.documentId)}`;
}

function isRecord(value: unknown): value is LocalUntitledRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<LocalUntitledRecord>;
  const key = record.key as Partial<LocalUntitledKey> | undefined;
  return (
    typeof key?.accountId === "string" &&
    typeof key.projectId === "string" &&
    typeof key.documentId === "string" &&
    typeof record.lineageId === "string" &&
    Number.isSafeInteger(record.revision) &&
    (record.phase === "local-pending" || record.phase === "adopted-live")
  );
}

/** Per-document browser storage adapter; malformed residue is never authority. */
export class BrowserLocalUntitledRecordStore implements LocalUntitledRecordStore {
  constructor(private readonly storage: Storage) {}

  read(key: LocalUntitledKey): LocalUntitledRecord | null {
    const raw = this.storage.getItem(recordStorageKey(key));
    if (!raw) return null;
    try {
      const record: unknown = JSON.parse(raw);
      return isRecord(record) &&
        record.key.accountId === key.accountId &&
        record.key.projectId === key.projectId &&
        record.key.documentId === key.documentId
        ? record
        : null;
    } catch {
      return null;
    }
  }

  write(record: LocalUntitledRecord): void {
    this.storage.setItem(recordStorageKey(record.key), JSON.stringify(record));
  }

  remove(key: LocalUntitledKey, expectedRevision: number): "removed" | "stale" {
    const current = this.read(key);
    if (!current || current.revision !== expectedRevision) return "stale";
    this.storage.removeItem(recordStorageKey(key));
    return "removed";
  }

  list(accountId: AccountId): readonly LocalUntitledRecord[] {
    const prefix = `${RECORD_PREFIX}${encodeURIComponent(accountId)}:`;
    const records: LocalUntitledRecord[] = [];
    for (let index = 0; index < this.storage.length; index += 1) {
      const storageKey = this.storage.key(index);
      if (!storageKey?.startsWith(prefix)) continue;
      const raw = this.storage.getItem(storageKey);
      if (!raw) continue;
      try {
        const record: unknown = JSON.parse(raw);
        if (isRecord(record) && record.key.accountId === accountId) records.push(record);
      } catch {
        // Malformed residue is deliberately ignored rather than deleting data.
      }
    }
    return records;
  }
}
